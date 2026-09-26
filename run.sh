#!/usr/bin/env bash
set -e

# Resolve script root directory
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$( cd -P "$( dirname "$SOURCE" )" >/dev/null 2>&1 && pwd )"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
ROOT_DIR="$( cd -P "$( dirname "$SOURCE" )" >/dev/null 2>&1 && pwd )"
cd "$ROOT_DIR"

echo "==================================================="
echo "            Rsrch Studio Launcher"
echo "==================================================="

# 1. Check for uv (fast path) or fallback to system python3
if command -v uv >/dev/null 2>&1; then
    echo "[Rsrch] Using uv package manager..."
    if [ ! -d ".venv" ]; then
        echo "[Rsrch] Creating virtual environment (.venv)..."
        uv venv .venv
    fi
    source .venv/bin/activate
    echo "[Rsrch] Syncing dependencies..."
    uv pip install -r requirements.txt --quiet
else
    echo "[Rsrch] uv not found; checking for Python 3..."
    if ! command -v python3 >/dev/null 2>&1; then
        echo ""
        echo "[Rsrch Error] python3 was not found on your system PATH."
        echo "Please install Python 3.11+ from your package manager or https://www.python.org/downloads/"
        echo "or install uv for instantaneous setup:"
        echo "  curl -LsSf https://astral.sh/uv/install.sh | sh"
        echo ""
        exit 1
    fi

    if [ ! -d ".venv" ]; then
        echo "[Rsrch] Creating virtual environment (.venv)..."
        python3 -m venv .venv
        source .venv/bin/activate
        echo "[Rsrch] Installing dependencies (first run only, please wait)..."
        python3 -m pip install --upgrade pip --quiet
        python3 -m pip install -r requirements.txt
    else
        source .venv/bin/activate
    fi
fi

# 2. Initialize default environment configuration if missing
if [ ! -f "backend/.env" ] && [ -f "backend/.env.example" ]; then
    cp "backend/.env.example" "backend/.env"
    echo "[Rsrch] Initialized backend/.env configuration."
fi

# 3. Check for pre-built frontend bundle
if [ ! -f "dist/index.html" ]; then
    echo "[Rsrch Notice] Built frontend not found in dist/."
    echo "If building from source, run: bun run build (or npm run build)"
fi

echo "[Rsrch] Starting server on http://127.0.0.1:8000..."
echo "[Rsrch] Opening browser in app window mode..."

# 4. Background browser launcher: waits 2s for server bind, then opens Chrome/Brave/Edge in app mode or default browser
(
    sleep 2
    URL="http://127.0.0.1:8000"
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        open -na "Google Chrome" --args --app="$URL" 2>/dev/null || \
        open -na "Brave Browser" --args --app="$URL" 2>/dev/null || \
        open -na "Microsoft Edge" --args --app="$URL" 2>/dev/null || \
        open "$URL" 2>/dev/null || true
    else
        # Linux
        google-chrome --app="$URL" 2>/dev/null || \
        chromium-browser --app="$URL" 2>/dev/null || \
        chromium --app="$URL" 2>/dev/null || \
        brave-browser --app="$URL" 2>/dev/null || \
        microsoft-edge --app="$URL" 2>/dev/null || \
        xdg-open "$URL" 2>/dev/null || true
    fi
) &

# 5. Start the backend server
exec python backend/server.py
