"""FastAPI application with a health endpoint and a cat dispensing button."""

from __future__ import annotations

import time
from functools import lru_cache

import redis
from fastapi import Depends, FastAPI, HTTPException, Response
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel

from app.redis_store import (
    create_session,
    delete_session,
    get_session_user,
    redis_from_env,
)

app = FastAPI(title="drift")


@lru_cache(maxsize=1)
def get_redis() -> redis.Redis:
    """Shared client; credentials and db index come from the environment."""
    return redis_from_env()


class SessionCreate(BaseModel):
    user: str


class SessionCreated(BaseModel):
    token: str


class SessionRead(BaseModel):
    user: str

PAGE = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cat Dispenser</title>
  <style>
    body {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1rem;
      min-height: 100vh;
      margin: 0;
      padding: 2rem;
      box-sizing: border-box;
      font-family: system-ui, sans-serif;
      background: #1e1e2e;
      color: #cdd6f4;
    }
    button {
      font-size: 1.25rem;
      padding: 0.75rem 2rem;
      border: none;
      border-radius: 999px;
      background: #f9e2af;
      color: #1e1e2e;
      cursor: pointer;
    }
    button:active {
      transform: scale(0.97);
    }
    img {
      max-width: min(90vw, 600px);
      border-radius: 12px;
    }
  </style>
</head>
<body>
  <h1>Cat Dispenser</h1>
  <button onclick="dispense()">Dispense cat</button>
  <img id="cat" alt="A cat" hidden>
  <script>
    function dispense() {
      const img = document.getElementById('cat');
      img.hidden = false;
      img.src = '/cat?t=' + Date.now();
    }
  </script>
</body>
</html>"""


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/sessions", status_code=201)
def login(payload: SessionCreate, conn: redis.Redis = Depends(get_redis)) -> dict[str, str]:
    user = payload.user.strip()
    if not user:
        raise HTTPException(status_code=400, detail="user must be non-empty")
    return {"token": create_session(conn, user)}


@app.get("/sessions/{token}")
def whoami(token: str, conn: redis.Redis = Depends(get_redis)) -> dict[str, str]:
    user = get_session_user(conn, token)
    if user is None:
        raise HTTPException(status_code=404, detail="unknown session")
    return {"user": user}


@app.delete("/sessions/{token}", status_code=204, response_class=Response)
def logout(token: str, conn: redis.Redis = Depends(get_redis)) -> Response:
    delete_session(conn, token)
    return Response(status_code=204)


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return PAGE


@app.get("/cat")
def cat() -> RedirectResponse:
    return RedirectResponse(f"https://cataas.com/cat?t={time.time_ns()}")
