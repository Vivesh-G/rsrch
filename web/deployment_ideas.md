# Rsrch — Deployment & Distribution Architecture

This document outlines the simplified deployment paradigms for **Rsrch**, moving away from complex cross-platform desktop binary compilation (PyInstaller/Tauri) toward lightweight, maintainable, and high-leverage distribution models.

---

## 1. Complete Serverless Web Version (Client-Side Only)

Static SPA hosted on GitHub Pages/Cloudflare Pages with all data stored client-side in the browser.

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
Running a full TeX Live or Tectonic compiler natively in the browser was historically prohibitive, but modern WebAssembly distributions now make client-side compilation completely viable:
* **Option 1 (Client-Side WASM Engine - Recommended):** Use **`corca-ai/wasmtex`** inside a Web Worker. It compiles LaTeX directly to PDF in-memory and includes built-in bidirectional **SyncTeX** mapping (`wasmtex/synctex`) for CodeMirror $\leftrightarrow$ PDF viewer synchronization.
* **Option 2 (Modular TeX Live WASM):** Use **`texlyre-busytex`** if dedicated `biber` or `bibtex8` citation processing is required.
* **Option 3 (Lightweight Fallback):** Provide live **KaTeX** previews for standalone math and equations without requiring full document compilation.

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
  compileLatex?(docId: string, source: string): Promise<CompileResult>;
}
```

* **`HttpStorageDriver`:** Calls FastAPI endpoints (used when running via `run.bat` / `run.sh` or local dev).
* **`IndexedDbStorageDriver`:** Interacts directly with browser IndexedDB, local Web Workers, and the Gemini REST API.
* **Automatic Detection:** The app automatically falls back to `IndexedDbStorageDriver` if `/api/health` is unreachable, enabling offline and static deployments seamlessly.

---

## 5. Architectural Comparison Matrix

| Characteristic | Standalone Binary (PyInstaller) | Launcher Scripts (`run.bat` / `run.sh`) | Complete Web Version (Client-Side WASM) |
|---|---|---|---|
| **Hosting Cost** | $0 (Local) | $0 (Local) | **$0/month** (Static CDN: Cloudflare / GitHub Pages) |
| **Prerequisites** | None | Python 3.11+ | **None** (Any modern browser) |
| **User Setup Time** | Download & Click | 1 click / command | **Instant** (Navigate to URL) |
| **Binary / Asset Size** | 200MB+ per OS | ~20MB repo + venv | ~3MB web app + ~30MB cached WASM TeX assets |
| **Data Privacy** | 100% Local | 100% Local | **100% Local** (Stays inside browser IndexedDB) |
| **Offline Capability** | Yes | Yes | **Yes** (PWA / Cache Storage API) |
| **Full LaTeX Compilation** | Yes (Host Tectonic binary) | Yes (Host Tectonic binary) | **Yes** (Client-side WASM via `corca-ai/wasmtex`) |
| **Interactive SyncTeX** | Yes (Backend parser) | Yes (Backend parser) | **Yes** (Client-side `wasmtex/synctex`) |
| **Maintenance Burden** | High (CI matrix + Notarization) | Minimal (Simple shell scripts) | **Lowest** (Zero backend infrastructure to run) |

---

## 6. Frontend Framework Selection (Next.js vs. SolidJS vs. React 19)

For a local-first, zero-backend workspace running heavy WASM and canvas workloads:

| Metric | Next.js (App Router) | React 19 + Vite (Current Stack) | SolidJS + Vite |
|---|---|---|---|
| **Hosting Cost** | $0 only if strictly configured with `output: 'export'` | **$0 forever** (Cloudflare / GitHub Pages) | **$0 forever** (Cloudflare / GitHub Pages) |
| **WASM / Canvas / Web Worker Fit** | ⚠️ **Clunky** (Hydration mismatches, requires `'use client'` and dynamic `ssr: false` everywhere) | **Clean** (Pure SPA lifecycle, no hydration conflicts) | ⚡ **Best** (Reactive signals bind directly to Web Workers outside UI) |
| **Editor & Token Streaming Perf** | Medium (VDOM reconciliation overhead on fast typing/streaming) | Medium (Requires careful `memo`/`useCallback` to prevent render lag) | ⚡ **Blazing Fast** (Zero VDOM, fine-grained DOM surgical updates) |
| **Existing Codebase Effort** | ⚠️ High (Need to dismantle SSR and reconfigure routing) | **Zero** (All 19 components already built and working) | ⚠️ High (Must rewrite ~1,300 lines of `@embedpdf` & hooks) |
| **Runtime Bundle Size** | ~90–120 KB | ~45 KB | **~7 KB** |
| **Verdict** | ❌ **Not recommended** | 🏆 **Best for shipping immediately** | 🚀 **Best for clean-slate peak performance** |

### Key Takeaways:
* **Avoid Next.js:** Private workspaces have zero SEO needs. Server-side rendering (SSR) only creates friction with browser canvas engines (`@embedpdf`) and WebAssembly modules.
* **Keep React 19 + Vite to Ship Today:** `DocViewer.tsx` has 1,300+ lines tightly coupled to `@embedpdf/*/react`. Keeping React allows converting to a zero-cost client-side app by only updating `src/services/api.ts` without touching UI components.
* **Choose SolidJS if Rebuilding from Scratch:** Solid's lack of a Virtual DOM makes live CodeMirror math editing and token streaming feel native with zero micro-stutters.

---

## 7. Client-Side LaTeX WASM Engine Evaluation

Comparison of browser-ready WebAssembly TeX engines to replace the backend Tectonic CLI:

| Evaluation Criteria | 🥇 `corca-ai/wasmtex` | 🥈 `TeXlyre/texlyre-busytex` | 🥉 `tectonic-wasm` (`nl5887`) |
|---|---|---|---|
| **Underlying Engine** | TeX Live (pdfLaTeX, XeLaTeX, LuaLaTeX) | BusyTeX (TeX Live multi-call WASM) | Tectonic (XeTeX fork in Rust/C++) |
| **Interactive SyncTeX** | 🏆 **Built-in (`wasmtex/synctex`)**<br>2-way coordinate $\leftrightarrow$ line parser included | ⚠️ Outputs `.synctex.gz`<br>(Requires custom JS parser) | ❌ **Unsupported**<br>(Only returns raw PDF bytes) |
| **Project Status** | 🟢 **Actively maintained** (2025/2026)<br>Powers production app CorTeX | 🟢 **Actively maintained** (2025/2026)<br>Powers collaborative TeXlyre | 🔴 **Stale / Experimental**<br>Unmaintained community hobby port |
| **Package Support** | Full standard TeX Live bundles | Modular data packages (`texlive-basic.js`) | Restricted to static bundle; fails on missing packages |
| **Bibliographies** | Multi-pass engine compilation | 🏆 Dedicated **`biber`** & **`bibtex8`** WASM binaries | Barebones / unreliable |
| **Editor API** | 🏆 **`wasmtex/headless`**<br>(DOM-free, virtual in-memory filesystem) | `BusyTexRunner`<br>(Web Worker runner) | Basic `compile_tex()` string function |
| **npm Distribution** | `github:corca-ai/wasmtex#main` | Published on npm registry (`texlyre-busytex`) | GitHub clone / manual build |

### Why `corca-ai/wasmtex` is the Primary Choice for Rsrch:
1. **Solves SyncTeX Out-of-the-Box:** It includes `wasmtex/synctex`, preserving Rsrch's core forward and inverse line-to-PDF synchronization.
2. **Headless-First Design:** `wasmtex/headless` accepts an in-memory dictionary of virtual files (`'main.tex'`, images, `.sty` macros), ideal for CodeMirror integration.
3. **Why Not `tectonic-wasm`:** Upstream Tectonic has no official WASM target yet. Community WASM builds lack SyncTeX outputs, cannot dynamically fetch packages from CTAN due to browser socket restrictions, and are largely experimental prototypes.

---

## 8. Recommended Implementation Roadmap

1. **Phase 1: Dual-Driver Storage Layer**
   * Implement `IndexedDbStorageDriver` using `idb` or `Dexie.js`.
   * Store raw PDF Blobs, workspaces, documents, and notes locally.
2. **Phase 2: Client-Side Gemini AI (BYOK)**
   * Add an API key field in UI settings.
   * Direct browser `fetch()` calls to `generativelanguage.googleapis.com` (CORS-enabled by Google AI Studio).
3. **Phase 3: Client-Side PDF Text Extraction**
   * Run `pdfjs-dist` in a Web Worker to extract page text upon drop/upload, saving chunks to IndexedDB.
4. **Phase 4: In-Browser LaTeX Compilation & SyncTeX**
   * Mount `wasmtex/headless` inside a dedicated Web Worker (`compiler.worker.ts`).
   * Cache engine WASM assets in Cache Storage / IndexedDB on initial load.
   * Connect `wasmtex/synctex` to CodeMirror line clicks and EmbedPDF coordinates.
5. **Phase 5: Deploy Static Bundle**
   * Build with `npm run build` (`vite build`).
   * Deploy `dist/` to **Cloudflare Pages** or **GitHub Pages** for $0/month lifetime hosting.

