@echo off
setlocal enabledelayedexpansion

:: Switch to script directory
cd /d "%~dp0"

title Rsrch Studio
echo ===================================================
echo             Rsrch Studio Launcher
echo ===================================================

:: 1. Check for uv (fast path) or fallback to system Python
where uv >nul 2>nul
if %ERRORLEVEL% equ 0 (
    echo [Rsrch] Using uv package manager...
    if not exist ".venv" (
        echo [Rsrch] Creating virtual environment (.venv)...
        uv venv .venv
        if %ERRORLEVEL% neq 0 (
            echo [Rsrch Error] Failed to create virtual environment with uv.
            pause
            exit /b 1
        )
    )
    call .venv\Scripts\activate.bat
    echo [Rsrch] Syncing dependencies...
    uv pip install -r requirements.txt --quiet
    if %ERRORLEVEL% neq 0 (
        echo [Rsrch Error] Failed to install dependencies with uv.
        pause
        exit /b 1
    )
) else (
    echo [Rsrch] uv not found; checking for Python...
    where python >nul 2>nul
    if %ERRORLEVEL% neq 0 (
        where py >nul 2>nul
        if %ERRORLEVEL% neq 0 (
            echo.
            echo [Rsrch Error] Python 3.11+ was not found on your system PATH.
            echo Please install Python 3.11+ from https://www.python.org/downloads/
            echo or install uv for instantaneous setup:
            echo   powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
            echo.
            pause
            exit /b 1
        )
        set "PY_CMD=py -3"
    ) else (
        set "PY_CMD=python"
    )

    if not exist ".venv" (
        echo [Rsrch] Creating virtual environment (.venv)...
        !PY_CMD! -m venv .venv
        if %ERRORLEVEL% neq 0 (
            echo [Rsrch Error] Failed to create virtual environment.
            pause
            exit /b 1
        )
        call .venv\Scripts\activate.bat
        echo [Rsrch] Installing dependencies (first run only, please wait)...
        python -m pip install --upgrade pip --quiet
        python -m pip install -r requirements.txt
        if %ERRORLEVEL% neq 0 (
            echo [Rsrch Error] Dependency installation failed.
            pause
            exit /b 1
        )
    ) else (
        call .venv\Scripts\activate.bat
    )
)

:: 2. Initialize default environment configuration if missing
if not exist "backend\.env" (
    if exist "backend\.env.example" (
        copy "backend\.env.example" "backend\.env" >nul
        echo [Rsrch] Initialized backend\.env configuration.
    )
)

:: 3. Check for pre-built frontend bundle
if not exist "dist\index.html" (
    echo [Rsrch Notice] Built frontend not found in dist\.
    echo If building from source, run: bun run build (or npm run build)
)

echo [Rsrch] Starting server on http://127.0.0.1:8000...
echo [Rsrch] Opening browser in app window mode...

:: 4. Background browser launcher: waits 2s for server bind, then opens Edge/Chrome app mode or default browser
start "" /b cmd /c "ping 127.0.0.1 -n 3 >nul & (start "" msedge --app=http://127.0.0.1:8000 2>nul || start "" chrome --app=http://127.0.0.1:8000 2>nul || start "" http://127.0.0.1:8000)"

:: 5. Start the backend server
python backend\server.py

if %ERRORLEVEL% neq 0 (
    echo.
    echo [Rsrch] Server process exited with code %ERRORLEVEL%.
    pause
)
