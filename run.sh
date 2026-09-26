#!/usr/bin/env bash
set -e

SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$( cd -P "$( dirname "$SOURCE" )" >/dev/null 2>&1 && pwd )"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
ROOT_DIR="$( cd -P "$( dirname "$SOURCE" )" >/dev/null 2>&1 && pwd )"
cd "$ROOT_DIR"

# 1. Fast path with uv if installed
if command -v uv >/dev/null 2>&1; then
    if [ ! -d ".venv" ]; then
        echo "[Rsrch] Initializing environment with uv..."
        uv venv .venv
    fi
    source .venv/bin/activate
    echo "[Rsrch] Verifying dependencies..."
    uv pip install -r requirements.txt --quiet
    exec python main.py
fi

# 2. Fallback to standard python3
if ! command -v python3 >/dev/null 2>&1; then
    echo "[Rsrch Error] python3 was not found on your system PATH."
    echo "Please install Python 3.11+ from your package manager or https://www.python.org/downloads/"
    exit 1
fi

if [ ! -d ".venv" ]; then
    echo "[Rsrch] Creating virtual environment (.venv)..."
    python3 -m venv .venv
    source .venv/bin/activate
    echo "[Rsrch] Installing dependencies..."
    python3 -m pip install -r requirements.txt --quiet
else
    source .venv/bin/activate
fi

exec python main.py
