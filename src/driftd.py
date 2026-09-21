#!/usr/bin/env python3
"""driftd: a tiny local HTTP bridge that keeps a Laya decision model resident.

The laya-drift opencode plugin asks this daemon to answer a fixed set of typed
questions about a session state. Laya returns calibrated probability
distributions in a single forward pass; the plugin treats those distributions
as a semantic embedding of the session and measures how far the running
context has moved from the calibrated plan.

Endpoints
    GET  /health  -> readiness + checkpoint + device
    POST /score   -> {"state": str, "questions": {id: qdef}} -> laya answers

Run:
    .venv/bin/python src/driftd.py --port 8765 --checkpoint multilingual
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional

os.environ.setdefault("USE_TF", "0")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")

CHECKPOINTS: Dict[str, Dict[str, Optional[str]]] = {
    "english": {"repo": "convaiinnovations/laya", "subfolder": None},
    "multilingual": {"repo": "convaiinnovations/laya", "subfolder": "multilingual"},
    "typed-decisions": {"repo": "convaiinnovations/laya", "subfolder": "typed-decisions"},
}

VALID_TYPES = {"choice", "score", "noul"}

log = logging.getLogger("driftd")


class ModelState:
    """Holds the loaded Laya agent and serialises inference across threads."""

    def __init__(self, checkpoint: str, device: Optional[str]) -> None:
        self.checkpoint = checkpoint
        self.device = device
        self.agent: Any = None
        self.error: Optional[str] = None
        self.ready = False
        self.loading = True
        self.lock = threading.Lock()
        self.loaded_at: Optional[float] = None

    def load(self) -> None:
        started = time.time()
        try:
            import laya

            spec = CHECKPOINTS[self.checkpoint]
            log.info(
                "loading checkpoint=%s repo=%s subfolder=%s device=%s",
                self.checkpoint,
                spec["repo"],
                spec["subfolder"] or "<root>",
                self.device or "auto",
            )
            if spec["subfolder"]:
                self.agent = laya.load(spec["repo"], subfolder=spec["subfolder"], device=self.device)
            else:
                # Root checkpoint: the repo bundles the other checkpoints in
                # subfolders, so fetch only the root files instead of the family.
                from huggingface_hub import snapshot_download

                local = snapshot_download(
                    spec["repo"],
                    allow_patterns=["*.json", "*.safetensors", "*.txt", "*.md", "encoder/*", "tokenizer/*"],
                )
                self.agent = laya.load(local, device=self.device)
            self.device = str(getattr(self.agent, "device", self.device or "unknown"))
            self.ready = True
            self.loaded_at = time.time()
            log.info("checkpoint loaded in %.1fs on %s", time.time() - started, self.device)
        except Exception as exc:  # noqa: BLE001 - surface any load failure to the client
            self.error = f"{type(exc).__name__}: {exc}"
            log.exception("failed to load checkpoint")
        finally:
            self.loading = False

    def predict(self, state: str, questions: Dict[str, Any]) -> Dict[str, Any]:
        if not self.ready or self.agent is None:
            raise RuntimeError(self.error or "model is not loaded yet")
        with self.lock:
            started = time.time()
            result = self.agent.predict(state, questions)
            result["elapsed_ms"] = round((time.time() - started) * 1000, 1)
            return result


def validate_questions(raw: Any) -> Dict[str, Any]:
    if not isinstance(raw, dict) or not raw:
        raise ValueError("questions must be a non-empty object")
    clean: Dict[str, Any] = {}
    for qid, qdef in raw.items():
        if not isinstance(qdef, dict):
            raise ValueError(f"question {qid!r} must be an object")
        qtype = qdef.get("type")
        if qtype not in VALID_TYPES:
            raise ValueError(f"question {qid!r} has invalid type {qtype!r}")
        instructions = qdef.get("instructions")
        if not isinstance(instructions, str) or not instructions.strip():
            raise ValueError(f"question {qid!r} needs non-empty instructions")
        question: Dict[str, Any] = {"type": qtype, "instructions": instructions}
        criteria = qdef.get("criteria")
        if qtype == "choice":
            if isinstance(criteria, list):
                criteria = {str(c): None for c in criteria}
            if not isinstance(criteria, dict) or not criteria:
                raise ValueError(f"choice question {qid!r} needs criteria")
            question["criteria"] = {str(k): v for k, v in criteria.items()}
        elif qtype == "score":
            if not isinstance(criteria, list) or len(criteria) < 2:
                raise ValueError(f"score question {qid!r} needs a criteria list of >= 2 levels")
            question["criteria"] = [str(c) for c in criteria]
        clean[str(qid)] = question
    return clean


class Handler(BaseHTTPRequestHandler):
    server_version = "driftd/0.1"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        log.debug("%s - %s", self.address_string(), fmt % args)

    def _send(self, code: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            raise ValueError("empty request body")
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def do_GET(self) -> None:  # noqa: N802
        state: ModelState = self.server.model_state  # type: ignore[attr-defined]
        if self.path.split("?")[0] in ("/health", "/"):
            self._send(
                200 if state.ready else 503,
                {
                    "ok": state.ready,
                    "ready": state.ready,
                    "loading": state.loading,
                    "error": state.error,
                    "checkpoint": state.checkpoint,
                    "device": state.device,
                    "pid": os.getpid(),
                    "loaded_at": state.loaded_at,
                },
            )
            return
        self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        state: ModelState = self.server.model_state  # type: ignore[attr-defined]
        path = self.path.split("?")[0]
        if path != "/score":
            self._send(404, {"ok": False, "error": "not found"})
            return
        try:
            body = self._read_json()
        except Exception as exc:  # noqa: BLE001
            self._send(400, {"ok": False, "error": f"bad json: {exc}"})
            return
        if not state.ready:
            self._send(503, {"ok": False, "error": state.error or "model loading", "loading": state.loading})
            return
        try:
            session_state = body.get("state")
            if not isinstance(session_state, str) or not session_state.strip():
                raise ValueError("state must be a non-empty string")
            questions = validate_questions(body.get("questions"))
            result = state.predict(session_state, questions)
        except ValueError as exc:
            self._send(400, {"ok": False, "error": str(exc)})
            return
        except Exception as exc:  # noqa: BLE001
            log.exception("score failed")
            self._send(500, {"ok": False, "error": f"{type(exc).__name__}: {exc}"})
            return
        self._send(200, {"ok": True, "checkpoint": state.checkpoint, **result})


def main() -> int:
    parser = argparse.ArgumentParser(description="Laya scoring daemon for the laya-drift opencode plugin")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--checkpoint", default="multilingual", choices=sorted(CHECKPOINTS))
    parser.add_argument("--device", default=None, help="torch device (mps, cuda, cpu); auto when omitted")
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )

    state = ModelState(args.checkpoint, args.device)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    server.model_state = state  # type: ignore[attr-defined]

    def shutdown(signum: int, _frame: Any) -> None:
        log.info("signal %s received, shutting down", signum)
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    log.info("driftd listening on http://%s:%d (loading model in background)", args.host, args.port)
    threading.Thread(target=state.load, name="laya-loader", daemon=True).start()

    try:
        server.serve_forever()
    finally:
        server.server_close()
        log.info("driftd stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
