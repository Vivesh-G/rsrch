@echo off
setlocal
cd /d "%~dp0"

title Rsrch Studio

:: 1. Fast path with uv if installed
where uv >nul 2>nul
if %ERRORLEVEL% equ 0 (
    if not exist ".venv" (
        echo [Rsrch] Initializing environment with uv...
        uv venv .venv
    )
    call .venv\Scripts\activate.bat
    echo [Rsrch] Verifying dependencies...
    uv pip install -r requirements.txt --quiet
    python main.py
    goto :done
)

:: 2. Fallback to standard Python
where python >nul 2>nul
if %ERRORLEVEL% neq 0 (
    where py >nul 2>nul
    if %ERRORLEVEL% neq 0 (
        echo [Rsrch Error] Python 3.11+ is not found on your system PATH.
        echo Please install Python from https://www.python.org/downloads/
        pause
        exit /b 1
    )
    set "PY_CMD=py -3"
) else (
    set "PY_CMD=python"
)

if not exist ".venv" (
    echo [Rsrch] Creating virtual environment (.venv)...
    %PY_CMD% -m venv .venv
    call .venv\Scripts\activate.bat
    echo [Rsrch] Installing dependencies...
    python -m pip install -r requirements.txt --quiet
) else (
    call .venv\Scripts\activate.bat
)

python main.py

:done
if %ERRORLEVEL% neq 0 pause
