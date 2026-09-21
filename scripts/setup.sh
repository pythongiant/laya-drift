#!/usr/bin/env bash
# Sets up the Python side of the drift plugin: a venv that reuses the system
# torch/transformers install (so nothing heavy is duplicated) plus the laya
# package itself. The first daemon start downloads the checkpoint (~650MB).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

if [ ! -x ".venv/bin/python" ]; then
  echo "==> creating .venv (system site packages, so torch is reused)"
  python3 -m venv --system-site-packages .venv
fi

echo "==> installing laya (deps satisfied by the system interpreter)"
.venv/bin/python -m pip install --no-deps --upgrade -q laya

echo "==> installing pyte (headless TUI layout checks)"
.venv/bin/python -m pip install -q pyte

echo "==> verifying imports"
.venv/bin/python - <<'PY'
import torch
import transformers
import laya

print(f"torch {torch.__version__}")
print(f"transformers {transformers.__version__}")
print(f"laya {laya.__version__}")
print(f"mps available: {torch.backends.mps.is_available()}")
PY

echo
echo "setup complete. Next:"
echo "  1. install JS deps:  (cd .opencode && bun install)   # or npm install"
echo "  2. warm the model:   .venv/bin/python src/driftd.py --checkpoint multilingual"
echo "  3. run opencode in this directory and use /calibrate"
