"""Rsrch Studio — Universal Application Launcher.

Cross-platform entry point. Run with:
    python main.py
or:
    uv run main.py
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent
BACKEND_DIR = ROOT_DIR / "backend"


def _launch_browser(url: str = "http://127.0.0.1:8000") -> None:
    """Open the application in an app-window (frameless) or default browser."""
    time.sleep(1.2)
    # 1. Try native desktop-style app mode (frameless window without browser tabs)
    if sys.platform == "win32":
        for exe in ("msedge", "chrome"):
            try:
                subprocess.Popen(
                    [exe, f"--app={url}"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                return
            except OSError:
                pass
    elif sys.platform == "darwin":
        for app in ("Google Chrome", "Brave Browser", "Microsoft Edge"):
            try:
                subprocess.Popen(
                    ["open", "-na", app, "--args", f"--app={url}"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                return
            except OSError:
                pass
    elif sys.platform.startswith("linux"):
        for exe in (
            "google-chrome",
            "chromium-browser",
            "chromium",
            "brave-browser",
            "microsoft-edge",
        ):
            try:
                subprocess.Popen(
                    [exe, f"--app={url}"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                return
            except OSError:
                pass

    # 2. Fallback to standard default browser
    webbrowser.open(url)


def main() -> None:
    # Ensure backend directory is in Python module search path
    if str(BACKEND_DIR) not in sys.path:
        sys.path.insert(0, str(BACKEND_DIR))

    # Initialize backend/.env from template if missing
    env_file = BACKEND_DIR / ".env"
    env_example = BACKEND_DIR / ".env.example"
    if not env_file.exists() and env_example.exists():
        try:
            env_file.write_text(env_example.read_text(encoding="utf-8"), encoding="utf-8")
        except OSError:
            pass

    # Verify core dependencies
    try:
        import uvicorn
        import fastapi
    except ImportError:
        print("[Rsrch Error] Missing required dependencies.")
        print("Please install dependencies with:")
        print("    pip install -r requirements.txt")
        print("or with uv:")
        print("    uv sync")
        sys.exit(1)

    print("===================================================")
    print("             Rsrch Studio")
    print("===================================================")
    print("[Rsrch] Starting server on http://127.0.0.1:8000...")
    print("[Rsrch] Opening browser window...")

    # Launch browser in a background daemon thread
    threading.Thread(target=_launch_browser, daemon=True).start()

    # Change working directory to backend so relative SQLite / configs resolve correctly
    os.chdir(BACKEND_DIR)
    uvicorn.run("server:app", host="127.0.0.1", port=8000, reload=False)


if __name__ == "__main__":
    main()
