# Rsrch — Deployment & Distribution Architecture

This document outlines the simplified deployment paradigms for **Rsrch**, moving away from complex cross-platform desktop binary compilation (PyInstaller/Tauri) toward lightweight, maintainable, and high-leverage distribution models.

---

## 1. Executive Summary:

Instead of fighting binary packaging, Rsrch can be distributed through two complementary paths:
1. **Local-First Launcher (Devs & Researchers):** `git clone` + automated `run.bat` / `run.sh` script.
2. **Pure Serverless Web Version (Zero Setup):** Static SPA hosted on GitHub Pages/Cloudflare Pages with all data stored client-side in the browser.

---

## 2. Paradigm A: Local-First Launcher Scripts

Ideal for power users, researchers, and local-first workflows where full local filesystem access, fast Python processing, and local Tectonic LaTeX compilation are needed.

### Key Innovations:
1. **Idempotent Single Command:** A single script (`run.bat` on Windows, `run.sh` on macOS/Linux) that sets up the virtual environment if missing, installs dependencies, loads configuration, and launches the server.
2. **Pre-Built `dist/` Bundling:** The production frontend is pre-built and tracked in the repository or downloaded from a release asset. Users **do not need Node.js or npm** installed—only Python is required.
3. **App Window Mode (Zero-Dependency Desktop Feel):** Instead of bundling PyWebView, the launcher can launch Chrome, Edge, or Brave in `--app` mode, opening Rsrch in a dedicated, frameless window without browser tabs or address bars.
4. **Fast Path with `uv`:** If the user has [Astral's `uv`](https://github.com/astral-sh/uv) installed, setup completes in under 2 seconds.

---

### Windows Launcher: `run.bat`

```bat
@echo off
setlocal
cd /d "%~dp0"

echo [Rsrch] Checking environment...

:: Check for uv or fallback to python venv
where uv >nul 2>nul
if %ERRORLEVEL% equ 0 (
    if not exist ".venv" (
        echo [Rsrch] Initializing environment with uv...
        uv venv .venv
    )
    call .venv\Scripts\activate.bat
    uv pip install -r backend\requirements.txt
) else (
    if not exist ".venv" (
        echo [Rsrch] Creating Python virtual environment...
        python -m venv .venv
        call .venv\Scripts\activate.bat
        python -m pip install --upgrade pip
        pip install -r backend\requirements.txt
    ) else (
        call .venv\Scripts\activate.bat
    )
)

:: Copy default config if missing
if not exist "backend\.env" (
    if exist "backend\.env.example" (
        copy "backend\.env.example" "backend\.env" >nul
        echo [Rsrch] Created backend\.env from template.
    )
)

:: Launch in dedicated browser window if Edge/Chrome exists, else standard default browser
echo [Rsrch] Starting server on http://127.0.0.1:8000...
start "" msedge --app=http://127.0.0.1:8000 2>nul || start "" "http://127.0.0.1:8000"

python backend\server.py
pause
```

---

### macOS & Linux Launcher: `run.sh`

```bash
#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo "[Rsrch] Checking environment..."

# Check for uv or fallback to python3 venv
if command -v uv &> /dev/null; then
    if [ ! -d ".venv" ]; then
        echo "[Rsrch] Initializing environment with uv..."
        uv venv .venv
    fi
    source .venv/bin/activate
    uv pip install -r backend/requirements.txt
else
    if [ ! -d ".venv" ]; then
        echo "[Rsrch] Creating virtual environment..."
        python3 -m venv .venv
        source .venv/bin/activate
        pip install --upgrade pip
        pip install -r backend/requirements.txt
    else
        source .venv/bin/activate
    fi
fi

# Copy default config if missing
if [ ! -f "backend/.env" ] && [ -f "backend/.env.example" ]; then
    cp backend/.env.example backend/.env
    echo "[Rsrch] Created backend/.env from template."
fi

echo "[Rsrch] Starting server on http://127.0.0.1:8000..."

# Launch browser in app mode (Chrome/Brave) or fallback to default browser
(
    sleep 1.5
    if [[ "$OSTYPE" == "darwin"* ]]; then
        open -na "Google Chrome" --args --app=http://127.0.0.1:8000 2>/dev/null || open "http://127.0.0.1:8000"
    else
        google-chrome --app=http://127.0.0.1:8000 2>/dev/null || xdg-open "http://127.0.0.1:8000" 2>/dev/null
    fi
) &

python backend/server.py
```

---

## 3. Paradigm B: Complete Serverless Web Version (Client-Side Only)

A zero-backend static single-page application (SPA) where the application code is served from any static web host (GitHub Pages, Cloudflare Pages, Vercel) and **100% of user data, PDFs, notes, and workspaces remain inside the browser**.

### The Storage Architecture: `localStorage` vs. `IndexedDB`

| Storage Engine | Size Limit | Supported Types | Ideal For |
|---|---|---|---|
| **`localStorage`** | ~5 MB total | Strings (UTF-16) | UI themes, sidebar dimensions, active document ID, user Gemini API key |
| **`IndexedDB`** | Gigabytes (up to 80% free disk) | Binary Blobs, Objects, ArrayBuffers | Workspaces, document metadata, note contents, chat messages, and **raw PDF files** |
| **`OPFS` / `sqlite3-wasm`** | Gigabytes | Virtual SQLite file | Direct in-browser SQLite with 100% schema parity with `database.py` |

> **Critical Rule:** Never attempt to store PDFs in `localStorage`. A single 15MB PDF encoded in Base64 will immediately exceed the browser's 5MB origin quota and throw a `QuotaExceededError`. PDF files must reside in **IndexedDB** or **OPFS**.

---

### Technical Components of the Web Version

#### 1. PDF Storage and Rendering
* **Upload:** When a user uploads a PDF, the raw `File` / `Blob` is stored directly into an IndexedDB object store (`pdf_blobs`) keyed by `document_id`.
* **Viewing:** Instead of requesting `/api/documents/:id/file`, retrieve the `Blob` from IndexedDB and generate a transient URL:
  ```typescript
  const pdfBlob = await db.get('pdf_blobs', docId);
  const blobUrl = URL.createObjectURL(pdfBlob);
  ```
  Pass `blobUrl` into EmbedPDF. EmbedPDF is already WebAssembly (`pdfium.wasm`) and runs entirely client-side.

#### 2. Client-Side Text Extraction (Replacing PyMuPDF)
In the Python backend, PyMuPDF extracts text so that search and AI chat have paper context. In the browser:
* Run `pdfjs-dist` inside a Web Worker.
* On file drop/upload, parse the text across all pages in the background.
* Store the extracted text in IndexedDB alongside the document metadata.
* Full-text search runs client-side instantly and works completely offline.

#### 3. Direct Gemini AI Integration (Replacing the Backend Proxy)
Because there is no backend server to hold an API key:
* Add a simple **Settings Dialog** in the UI where users enter their Google Gemini API key.
* Save the key to `localStorage.setItem('rsrch_gemini_key', key)`.
* Call the Google Gemini API directly from the browser using `fetch`:
  ```typescript
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: promptWithDocContext }] }]
    })
  });
  ```
  *(Google Gemini's public REST API explicitly supports browser CORS headers for client-side web apps).*

#### 4. LaTeX Strategy in Pure Web Mode
Running a full Tectonic or TeX Live CLI is impossible in pure client-side JavaScript without a massive (~40MB+) WebAssembly TeX distribution.
* **Option 1 (Recommended):** Provide a live **KaTeX / MathJax** split preview for authoring equations and markdown notes.
* **Option 2 (Optional Endpoint):** Allow power users to plug in a custom external compilation URL in settings (e.g., self-hosted compiler or cloud worker).

#### 5. Data Safety & Portability (Backup / Restore)
Because browser cache can be cleared by the user or the operating system under low-storage conditions:
* Provide a prominent **"Backup Workspace"** button that bundles all workspaces, notes, and PDF blobs into a `.zip` archive (using `jszip`).
* Provide a corresponding **"Restore Backup"** feature to re-hydrate the IndexedDB database.

---

## 4. Codebase Architecture: The Dual-Driver Pattern

To avoid maintaining two separate codebases (one for local server and one for web), abstract the storage layer into a unified interface:

```typescript
// src/services/storage/types.ts
export interface StorageDriver {
  getWorkspaces(): Promise<Workspace[]>;
  createWorkspace(name: string): Promise<Workspace>;
  uploadDocument(workspaceId: string, file: File): Promise<DocumentItem>;
  getDocumentBlob(docId: string): Promise<Blob | string>;
  getNote(docId: string): Promise<NoteData>;
  saveNote(docId: string, content: string): Promise<NoteData>;
  sendChatMessage(chatId: string, message: string, docIds: string[]): Promise<ChatMessage>;
}
```

* **`HttpStorageDriver`:** Calls FastAPI endpoints (used when running via `run.bat` / `run.sh` or local dev).
* **`IndexedDbStorageDriver`:** Interacts directly with browser IndexedDB and the Gemini REST API.
* **Automatic Detection:** The app can automatically fall back to `IndexedDbStorageDriver` if `/api/health` is unreachable, enabling offline and static deployments seamlessly.

---

## 5. Architectural Comparison Matrix

| Characteristic | Standalone Binary (PyInstaller) | Launcher Scripts (`run.bat` / `run.sh`) | Complete Web Version (IndexedDB) |
|---|---|---|---|
| **Hosting Cost** | $0 (Local) | $0 (Local) | **$0/month** (Static CDN / GitHub Pages) |
| **Prerequisites** | None | Python 3.11+ | **None** (Any modern browser) |
| **User Setup Time** | Download & Click | 1 click / command | **Instant** (Navigate to URL) |
| **Binary / Asset Size** | 200MB+ per OS | ~20MB repo + venv | **~3MB** static web bundle |
| **Data Privacy** | 100% Local | 100% Local | **100% Local** (Stays in browser) |
| **Offline Capability** | Yes | Yes | **Yes** (PWA / Service Worker) |
| **Full LaTeX (Tectonic)** | Yes | Yes (Host binary) | No (KaTeX preview or remote webhook) |
| **Maintenance Burden** | High (CI matrix + Notarization) | **Minimal** (Simple shell scripts) | **Low** (Standard static React SPA) |

---

## 6. Recommended Action Plan

1. **Near-Term:** Implement `run.bat` and `run.sh` in the repository root for immediate one-click local launches without Node.js friction.
2. **Mid-Term:** Refactor `src/services/api.ts` into a pluggable storage driver interface (`HttpDriver` vs. `IndexedDbDriver`).
3. **Long-Term:** Add the IndexedDB store and client-side Gemini fetch to enable zero-install static deployments on GitHub Pages or Cloudflare Pages.
