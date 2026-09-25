# Rsrch — Maintainer Context

> Read this before changing anything. It maps every moving part, what each
> function does, and where to look when something breaks or needs a feature.

## 1. What this is

Research workspace app: workspaces → PDF & LaTeX documents (`doc_type`: `'pdf'` | `'latex'`) → side-by-side PDF / live compiled LaTeX viewer + markdown notes / CodeMirror LaTeX editor + per-document AI chat (Gemini with KaTeX math rendering). Two processes in dev, one in prod.

| Piece | Tech | Port |
|---|---|---|
| Frontend | React 19 + TypeScript + Vite, EmbedPDF (pdfium) viewer, CodeMirror 6 + KaTeX | 5173 (dev) |
| Backend | FastAPI + aiosqlite, PyMuPDF extraction, Gemini chat, Tectonic LaTeX engine | 8000 |

Dev: `vite` (proxies `/api` → 127.0.0.1:8000, see `vite.config.ts`) + backend (`uvicorn server:app` from `backend/`). Prod: `vite build`, then serve — `backend/server.py` auto-serves `../dist` (SPA + `/assets`, `.wasm` MIME registered) when the dir exists, so one process is enough.

### Configuration & Environment Variables

All backend settings load once at startup into a frozen `Settings` object in `backend/config.py`.
**Precedence:** OS Environment Variables > `backend/.env` > `backend/.config` (INI `[rsrch]`) > Dataclass defaults.

| Var | Where | Purpose | Default |
|---|---|---|---|
| `GEMINI_API_KEY` | `.env` / env | Chat model auth (`genai.Client()` reads it) | None (required for chat) |
| `GEMINI_MODEL` | `.env` / env / `.config` | Gemini model name | `'gemini-3.5-flash-lite'` |
| `CORS_ORIGINS` | `.env` / env / `.config` | Comma-separated allowed origins | `http://localhost:5173,http://127.0.0.1:5173` |
| `MAX_UPLOAD_MB` | `.env` / env / `.config` | PDF upload size cap (in megabytes) | `50` |
| `RSRCH_DATA_DIR` | env | Base directory for DB, PDFs, and LaTeX builds | `backend/data/` |
| `RSRCH_DIST_DIR` | env | Production frontend static asset directory | `dist/` |
| `LATEX_MAX_BUILDS_PER_DOC` | `.env` / env / `.config` | Number of build snapshots kept per LaTeX doc | `3` |
| `LATEX_MAX_TOTAL_BUILDS` | `.env` / env / `.config` | Global limit on total cached build folders | `100` |
| `LATEX_MAX_TOTAL_MB` | `.env` / env / `.config` | Global cap on total LaTeX build cache size | `500` |
| `VITE_API_URL` | frontend build-time | Origin of API when split from frontend | `''` (same origin / Vite proxy) |

Data directories live under `RSRCH_DATA_DIR` (default `backend/data/`):
- SQLite database: `backend/data/rschr.db`
- Uploaded PDFs: `backend/data/pdfs/`
- Compiled LaTeX builds: `backend/data/latex_builds/`
- Ephemeral build attempts: `backend/data/latex_temp/`

All are gitignored (`**/data/`, `*.db`, `*.pdf`). The DB was committed once by accident and has been untracked (`git rm --cached`, file kept on disk). Never re-add data files to git.

## 2. Repo map

```
src/
  App.tsx                    # all global state + handlers (brain, panel order, resize, latex compile sync)
  main.tsx                   # StrictMode root (dev double-effects apply!)
  services/api.ts            # fetch wrapper: req(), timeouts, API_BASE, compileDocument, createLatexDoc
  types/index.ts             # Workspace, DocumentItem (doc_type: 'pdf' | 'latex'), NoteData, ChatMessage
  utils/search.ts            # docMatchesQuery — THE shared search predicate
  components/
    TopBar.tsx               # search input (local state + 150ms debounce), theme, chat toggle, duotone logo
    Sidebar.tsx              # workspace tree, per-doc rows, inline rename, new doc/latex modals
    RightSidebar.tsx         # collapsible right docking bar for panel visibility toggles (Viewer/Chat/Notes)
    WorkspaceOverview.tsx    # doc cards grid (no doc open)
    DocViewer.tsx            # EmbedPDF viewer + LaTeX compiled PDF preview & live diagnostics
    NotesPanel.tsx           # switches between LiveMarkdownEditor (PDF notes) & CodeMirrorLatexEditor (LaTeX)
    LiveMarkdownEditor.tsx   # contentEditable markdown engine, slash menu
    CodeMirrorLatexEditor.tsx# CodeMirror 6 LaTeX editor, inline KaTeX math decorations, custom slash menu
    katexDecoration.ts       # ViewPlugin + StateField rendering inline/display math in CodeMirror
    latexAutocomplete.ts     # categorized slash command registry & snippet insertions
    ChatPanel.tsx            # per-doc/global chat UI, KaTeX math formatting, "Replace Selection" button
    ErrorBoundary.tsx        # class boundary w/ resetKey
    Modals.tsx / Resizer.tsx / Icons.tsx / KeyboardShortcutsModal.tsx
backend/
  server.py                  # routes, upload/chat bounds, compile orchestration, SPA serving
  database.py                # all SQL (WAL, doc_type, batched doc queries, connection safety)
  models.py                  # pydantic schemas (maxLength bounds, DocumentCreateLatex, etc.)
  config.py                  # frozen Settings dataclass (single-source of truth for env/.env/.config)
  compiler.py                # Tectonic compilation runner, SHA256 build caching, LRU pruning
  diagnostics.py             # TeX log and stderr parser for line-numbered compiler diagnostics
  .config                    # committed non-secret configuration defaults
  tests/                     # pytest suite (test_config.py, test_database.py, test_server_utils.py)
```

## 3. Backend

### `server.py` — routes

| Method + path | Handler | Does | Errors |
|---|---|---|---|
| `GET /api/health` | `health` | liveness | — |
| `GET /api/workspaces` | `list_workspaces` | all workspaces + embedded docs (batched query) | — |
| `POST /api/workspaces` | `create_ws` | `ws_<8hex>` + name | 422 |
| `PUT /api/workspaces/{id}` | `update_ws` | name/expanded | 404 |
| `DELETE /api/workspaces/{id}` | `delete_ws` | + deletes PDF files | 404 if no row |
| `POST /api/workspaces/{ws}/documents/upload` | `upload_document` | validate (magic bytes, size, ext) → store → extract → row + starter note | 404 ws / 413 size / 400 non-PDF |
| `POST /api/workspaces/{ws}/documents/latex` | `create_latex_document` | create `.tex` doc + starter note + trigger initial compile | 404 ws / 422 |
| `GET /api/documents/{id}` | `get_doc` | metadata | 404 |
| `GET /api/documents/{id}/file` | `get_doc_file` | PDF bytes (`Accept-Ranges`); for LaTeX, serves/compiles cached build | 404 |
| `POST /api/documents/{id}/compile` | `compile_document` | triggers Tectonic build of LaTeX source content | 404 doc |
| `PUT /api/documents/{id}` | `update_doc` | note_title/tag/bookmarked | 404 |
| `DELETE /api/documents/{id}` | `delete_doc` | + deletes file | 404 if no row |
| `GET /api/documents/{id}/note` | `read_doc_note` | note/tex source (creates starter on miss) | — |
| `PUT /api/documents/{id}/note` | `save_doc_note` | upsert note / LaTeX source content | — |
| `GET /api/search` | `search` | name/title/tag/note LIKE search | — (**unused by UI**; UI filters client-side) |
| `GET /api/chats` | `list_chat_sessions` | all chats, `updated_at DESC`, with `message_count`, `last_preview`, `origin_title` | — |
| `POST /api/chats` | `create_chat_session` | `{title?, document_id?}`; unknown doc → null origin (never 404) | 422 |
| `GET /api/chats/{id}/messages` | `get_chat_msgs` | ordered messages (tail preserved chronologically), `limit` clamped 1–500 (default 200) | 404 chat |
| `POST /api/chats/{id}/messages` | `send_chat_message` | rate-limit → resolve ≤3 context docs (PDF extract or LaTeX source) → bounded history → Gemini → store reply → auto-title | 404 / 429 / 422 |
| `DELETE /api/chats/{id}` | `delete_chat_session` | messages + chat + rate window | 404 if no row |

### `server.py` & Auxiliary Modules — non-route functions

- `config.py` (`settings`) — frozen dataclass instantiated once. Single place for runtime paths (`db_path`, `pdf_dir`, `latex_builds_dir`, `latex_temp_dir`, `frontend_assets_dir`, `frontend_index`) and tunables.
- `compiler.py` — orchestrates headless Tectonic compilation:
  - `run_compile(doc_id, source)`: throttled by `compile_semaphore = asyncio.Semaphore(2)`. Generates isolated unique temp folder, compiles with `--keep-logs`, extracts diagnostics, stores build to `latex_builds/{hash}`, and evicts stale builds.
  - `get_build_key(source, entrypoint)`: SHA-256 hash of entrypoint name + source text.
  - `_prune_builds(keep_doc_id, keep_key)`: enforces per-doc retention cap (`MAX_BUILDS_PER_DOC`), global build count cap (`MAX_TOTAL_BUILDS`), and global disk usage (`MAX_TOTAL_BYTES`).
  - `_prune_temp_orphans()`: sweeps dead/aborted attempt directories older than 1 hour.
- `diagnostics.py` (`parse_diagnostics`) — parses TeX engine logs and compiler stderr to extract structured line numbers, columns, severities, and error messages.
- `get_genai_client()` — lazily creates ONE `genai.Client()` (module `_genai_client`).
- `check_chat_rate_limit(chat_id)` — in-memory sliding window, 20 req / 60s / chat → 429. Resets on restart (by design).
- `_extract_pdf(path)` — **blocking** PyMuPDF full-text parse; runs via `asyncio.to_thread`.
- `lifespan` — runs `settings.ensure_dirs()`, `init_db()`, and startup build cache pruning on startup.
- SPA block (`DIST_DIR`, `spa_root`, `spa_fallback`) — serves `dist/` if present; `.wasm` MIME registered for WebAssembly PDF engine streaming. Catch-all registered last; path-traversal guarded via `.resolve()` and prefix checks.

### Bounds & Defaults (from `config.settings`)

`MAX_UPLOAD_BYTES` (50MB) · `MAX_EXTRACTED_CHARS` 200k · `CHAT_CONTEXT_CHARS` 30k · `CHAT_HISTORY_LIMIT` 20 · `CHAT_TIMEOUT_S` 90 · `CHAT_RATE_LIMIT` 20/min/chat (`_chat_hits` sweeps expired windows on every check + drops entry on chat delete).
Model string comes from `settings.gemini_model` (default `'gemini-3.5-flash-lite'`).
Chat context = up to 3 attached docs, budget split evenly, each labeled `[title]` (uses `extracted_text` for PDFs, `content` for LaTeX docs). Untitled chats auto-title from the first message (first line, 40 chars).

### `database.py` — functions

- `get_db()` — per-op connection, `foreign_keys=ON`, `journal_mode=WAL`, `busy_timeout=30s`.
- `init_db()` — creates tables (`workspaces`, `documents`, `notes`, `chats`, `chat_messages`), migrates `doc_type` column, creates indexes, seeds `ws_default`.
- `get_all_workspaces()` — single batched query using `WHERE workspace_id IN (...)` (eliminated legacy N+1 query loop).
- `get_workspace(id)` — single row or None.
- `create_workspace / update_workspace` — updates return None when no fields → 404 upstream.
- `delete_workspace / delete_document` — removes files from disk, then DELETE; returns `rowcount > 0`. Cascades via FK.
- `create_document(...)` — supports `doc_type` ('pdf' | 'latex'); sets starter template (`.tex` starter document for LaTeX); returns metadata without leaking local disk paths.
- `get_document / update_document` — re-reads updated rows using the **same connection handle** to prevent connection pool deadlocks.
- `get_note` (auto-creates starter) / `save_note` (upsert) — re-uses existing connection handle for title lookup.
- `search_all` — `LOWER LIKE` across name/title/tag/note.
- Chats: `list_chats`, `create_chat`, `get_chat`, `update_chat_title`, `delete_chat`, `get_chat_messages` (queries `ORDER BY created_at DESC, id DESC LIMIT ?` and reverses rows so callers reliably receive the chronological tail), `add_chat_message`.

### `models.py`

`NoteBase/Response/NoteUpdate`, `DocumentBase/Update/Response`, `DocumentCreateLatex`, `WorkspaceBase/Update/Response`, `SearchResultItem/SearchResponse`, `ChatMessage`, `ChatCreate`, `ChatSessionResponse`, `ChatSendRequest` (message 1–4000 chars, ≤3 `document_ids`), `ChatSendResponse`. Strict `maxLength` validations enforced on titles, tags, and names.

## 4. Frontend

### `services/api.ts`

- `API_BASE = (VITE_API_URL ?? '') + '/api'`. `getDocumentFileUrl(id)` returns file URL.
- All path parameters sanitized with `encodeURIComponent`.
- `req(path, init?, timeoutMs)` — AbortController timeout (30s default, 120s upload/chat), throws `ApiError(status, detail)`.
- Methods: `getWorkspaces`, `createWorkspace`, `updateWorkspace`, `deleteWorkspace`, `uploadDocument`, `createLatexDocument`, `compileDocument`, `getDocument`, `updateDocument`, `deleteDocument`, `getNote`, `saveNote`, `listChats`, `createChat`, `getChatMessages`, `sendChatMessage`, `deleteChat`.

### `App.tsx` — state ownership (single source of truth)

| State | Updated by | Consumed by |
|---|---|---|
| `workspaces` | all CRUD handlers | Sidebar, Overview, activeDoc memo |
| `activeWsId / activeDocId` | select handlers | everything |
| `panelOrder` | framer-motion drag handle | `Reorder.Group` container order |
| `isViewerOpen / isChatOpen / isNotesOpen` | RightSidebar / TopBar / hotkeys | Layout visibility & collapsing |
| `notesCache: Record<docId, md>` | `handleNoteChange` (instant) → debounced persist 800ms (localStorage + `saveNote`) | NotesPanel; Sidebar search only during active query (`sidebarNotesCache`) |
| `searchQuery` (+ `useDeferredValue`) | TopBar (150ms debounce) | Sidebar, Overview filters |
| `widths: Record<PanelId, number>` | Resizer drag / keyboard (pair-weighted math) | flex-basis styles |

Key handlers: `handleAddFiles` (batch upload + single commit), `handleCreateLatexDoc`, `doDeleteWorkspace`, `doDeleteDoc`, `handleToggleBookmark`, `handleTitleChange`, `handleRenameDoc`, `handleTagChange`, `handleNoteChange`, `handleManualSave` (Ctrl+S / button), pair-weighted resizing with keyboard arrow-key navigation.

### Components

- **`TopBar`** — duotone logo (`IconLogo`), local input state + 150ms debounce, theme toggle (`rschr-theme` + `body.dark`), panel view toggle. Memo'd.
- **`Sidebar`** — workspace tree, LaTeX document creation modal, PDF upload trigger, per-doc rows, inline rename, collapsed hover drawer with 3px edge visual hint.
- **`RightSidebar`** — collapsible right docking rail with quick toggles for PDF Viewer, AI Chat, and Notes editor, showing active/collapsed indicator bars and tooltips.
- **`WorkspaceOverview`** — cards grid for docs across active workspace; filters by search query against title, tag, and note/tex content.
- **`DocViewer`** (lazy chunk + `pdfium.wasm`):
  - Dual document support: handles both uploaded PDFs and compiled LaTeX outputs.
  - For LaTeX documents, fetches compiled PDF via `/api/documents/{id}/file`, reloads preview on build completion, displays diagnostic error/warning banner at the bottom with jump-to-line buttons, and provides direct PDF download.
  - `DocumentKeeper` & `HighlightRestorer`: caches loaded document instances and dedupes/validates annotation IDs before WASM engine import.
- **`NotesPanel`** — dynamically renders `CodeMirrorLatexEditor` when `doc.doc_type === 'latex'` or `LiveMarkdownEditor` when `doc.doc_type === 'pdf'`. Download button adapts to `.tex` or `.md`.
- **`CodeMirrorLatexEditor`** — CodeMirror 6 LaTeX editing engine:
  - LaTeX syntax highlighting, bracket matching, active line highlighting (`highlightActiveLine`, `highlightActiveLineGutter`), line numbers, and code folding.
  - Inline KaTeX math preview via `katexDecoration.ts`: transforms `$..$` and `$$..$$` into rendered math while keeping source editable on cursor focus.
  - Custom floating `.slash-menu` system matching Notes: categorized palette (`Structure`, `Environments`, `Math`, `Lists`, `Formatting`), monospace badges (`H1`, `H2`, `TAB`, `FIG`, `$$`, `∑`, etc.), caret coordinate tracking (`view.coordsAtPos`), and `Prec.highest` keyboard trap (`ArrowUp`, `ArrowDown`, `Enter`, `Tab`, `Escape`).
  - Dark mode caret visibility (`caretColor: var(--text-primary)`, `borderLeft: 2px solid var(--text-primary)`).
  - Selection highlight regularization: native browser selection forced transparent inside `.cm-content` to prevent dark-mode overlay clashes with `.cm-selectionBackground`.
  - Selection Ask AI tooltip (`.latex-ask-ai-popup`, `.latex-ask-ai-btn`): compact floating button with sparkle icon to send highlighted code to AI chat.
- **`katexDecoration.ts`** — CodeMirror 6 ViewPlugin + StateField rendering KaTeX mathematical formulas seamlessly inline and in display blocks.
- **`latexAutocomplete.ts`** — structured registry `LATEX_SLASH_COMMANDS` of LaTeX templates and snippet generators.
- **`LiveMarkdownEditor`** — contentEditable markdown engine for note taking with slash commands and formatting hotkeys.
- **`ChatPanel`** — global AI chat with LaTeX math rendering via `remark-math` and `rehype-katex`. Supports attaching up to 3 documents, multi-turn history, and "Replace Selection" button on code blocks to inject AI code snippets into active editors.
- **`Resizer`** — accessible proportional resizer with pair-weighted drag math, keyboard navigation (`ArrowLeft`/`ArrowRight`), and ARIA separator attributes.
- **`ErrorBoundary`** — class boundary with `resetKey` isolating panel failures.

### Cross-cutting contracts

- localStorage: `rsrch-note-{docId}` (note text / tex source) · `rshr-page-{docId}` (page num) · `rsrch-pdf-highlights-{docId}` (deduped annotations) · `rschr-theme` · UI keys `rschr-ws`, `rschr-doc`, `rschr-sidecol`, `rschr-sidew`, `rschr-notesw`, `rschr-chatw`, `rschr-chat-open`, `rschr-chat-id`.
- Event: `window 'rsrch:scroll-to-page' {detail:{page}}` — editor `[p. N]` badges → viewer smooth-scroll.
- Code block replacement: `window 'rsrch:replace-selection' {detail:{code}}` — ChatPanel code block → active editor selection replacement.

## 5. Feature recipes (where to cut)

| Want | Touch |
|---|---|
| New backend endpoint | `models.py` schema → `database.py` fn → `server.py` route (before SPA block!) → `api.ts` method |
| New global state | `App.tsx` useState + stable `useCallback` + memoized `style` (else memo'd children rerender) |
| Change search semantics | `utils/search.ts` only |
| Change LLM / prompt | `send_chat_message` in `server.py` (+ bounds at top / `settings.gemini_model`); chat UI is `ChatPanel` |
| LaTeX compilation tuning | `backend/compiler.py` (`compile_semaphore`, timeouts, flags) & `diagnostics.py` |
| New LaTeX slash command | Add to `LATEX_SLASH_COMMANDS` in `src/components/latexAutocomplete.ts` |
| New note markdown syntax | `inline()/renderBlock()` in `LiveMarkdownEditor.tsx` (keep `esc()` first!) |
| New viewer toolbar btn | `LoadedViewer` toolbar in `DocViewer.tsx`; page-level needs `renderPage` deps |
| New panel in workspace | `App.tsx` layout + `Resizer` + width state + `ErrorBoundary` wrapper + `RightSidebar` toggle |

## 6. Verify

- Frontend build: `bun run build` (runs `tsc -b && vite build` cleanly).
- Backend tests: `uv run pytest backend/tests` (runs 19 unit & integration tests).
- Backend syntax verification: `python -m py_compile backend/*.py`.
- (ESLint is broken repo-wide: `typescript-eslint` vs TS 7 — pre-existing, don't chase it.)

## 7. Incident log (solved — don't regress)

### 7.1 `net::ERR_FILE_NOT_FOUND`
Chrome logs this for `file://` subresource loads and missing prod assets — never for FastAPI 404s. Trigger was always PDF-open time (lazy `DocViewer` chunk, `pdfium.wasm`, `worker-engine`, `/api/.../file`). Fix: `server.py` serves `dist/` + registers `application/wasm`; run one process.

### 7.2 Duplicate annotation keys + multiplying highlights
Library reducer appends imported uids blindly; re-importing exports containing embedded foreign highlights caused duplicate key crashes. Fixed by idempotent import + store repair + deduped persist (`HighlightRestorer`). Never call `importAnnotations` with unfiltered exports.

### 7.3 CodeMirror selection double-paint in dark mode
Browser native `::selection` overlay rendered concurrently with CodeMirror's `.cm-selectionBackground`, creating unreadable dark blotches in dark mode. Fixed by setting `.cm-content ::selection { background: transparent !important }` and applying clean semi-transparent background rules on `.cm-selectionBackground`.

### 7.4 SQLite nested connection checkout deadlocks
`update_document` and `get_note` previously invoked `get_document()` while still holding open an active transaction on another connection handle, risking SQLite busy timeout deadlocks. Fixed by executing follow-up queries on the same connection handle.

## 8. Changelog

### Sep 22, 2026
- **Architecture: Movable Layout System:** 
  - Integrated `framer-motion` `Reorder.Group` in `App.tsx` governed by a new `panelOrder` state array (`['viewer', 'chat', 'notes']`). The `Sidebar` is intentionally excluded and statically locked to the left.
  - Introduced a `PanelWrapper` component to map the `panelOrder` IDs to their respective flex containers (`Reorder.Item`).
  - **Render-Prop Drag Injection:** Used a render-prop pattern in `PanelWrapper` (`children: (dragHandle: ReactNode) => ReactNode`) to pass the `Reorder.Item`'s `dragControls` into deeply nested panel headers, bypassing `ErrorBoundary` wrappers.
- **Architecture: Resizer Performance Tuning:** 
  - Disabled full bounding-box `layout` animations in `framer-motion` by passing `layout="position"` to `Reorder.Item`s. Removed visual lag during resizer dragging.
- **UI & Layout Integrity:** 
  - Explicitly applied `height: 100%` overrides inside flex containers to restore full vertical bounds under `Reorder.Item` wrappers.
  - **Sidebar UX:** Added a 3px dark-gray visual hint for the collapsed sidebar. Reworked hover trigger coordinates with `left: calc(100% - 14px)` so hovering the screen edge pops the drawer out reliably.
- **Header & State Cleanups:** 
  - Removed bulky editable title block from `NotesPanel`, flattening the header to a concise single line (`[DragHandle] Notes / [Title] [Save] [Download]`).
- **Brand Identity & Spacing:** 
  - Created a duotone SVG logo (`IconLogo` in `Icons.tsx`) and added it to `TopBar` with exact 32x32 alignment.
  - Reduced global `.app` shell gap from `var(--space-2)` to `4px`.
- **ChatPanel Math Rendering (`17c44e2`):**
  - Integrated `remark-math` and `rehype-katex` with KaTeX stylesheet (`katex/dist/katex.min.css`) in `ChatPanel.tsx` to render inline and block math formulas in AI responses.

### Sep 24, 2026
- **Component Architecture & Right Navigation Rail (`5c8a63f`):**
  - Added `RightSidebar.tsx` as a collapsible right rail with icon docking toggles for PDF Viewer, AI Chat, and Notes editor (`isViewerOpen`, `isChatOpen`, `isNotesOpen`).
  - Added active state indicator bars, responsive drawer toggles, and tooltip badges.
- **Security, Validation & Accessibility Hardening (`8154715`):**
  - **API & Path Hardening:** Sanitized all document and workspace IDs across `api.ts` with `encodeURIComponent`.
  - **Upload Verification:** Corrected inverted PDF magic-byte check (`%PDF-`), enforced lowercase `.pdf` file extension checks, and clamped maximum file size thresholds.
  - **Schema Constraints:** Added `maxLength` bounds on document names, tags, titles, and workspace names in both frontend form inputs and Pydantic models.
  - **Annotation Import Guard:** Added validation for localStorage annotations before WASM engine import to prevent corrupted store states.
  - **Proportional Resizing & A11y:** Implemented pair-weighted resize math in `App.tsx` and `Resizer.tsx`. Added full keyboard accessibility (`ArrowLeft`/`ArrowRight`, `Enter`/`Space`) and ARIA slider semantics (`role="separator"`, `aria-valuenow`).
- **Realtime LaTeX Authoring Engine (`2891fe4`):**
  - **Tectonic Compilation Runner (`backend/compiler.py`):** Headless background compilation using Tectonic CLI with SHA-256 build key caching, concurrency semaphore (`compile_semaphore = 2`), isolated execution directories, and LRU pruning (`MAX_BUILDS_PER_DOC`, `MAX_TOTAL_BUILDS`, `MAX_TOTAL_BYTES`).
  - **Diagnostic Parser (`backend/diagnostics.py`):** Regex parser extracting line numbers, columns, severities, and error messages from TeX engine logs and stderr.
  - **Backend LaTeX Endpoints:** Introduced `POST /api/workspaces/{ws}/documents/latex` for creating LaTeX documents with starter templates and `POST /api/documents/{id}/compile` for on-demand builds. Updated `GET /api/documents/{id}/file` to compile and stream cached LaTeX PDFs.
  - **Database Support:** Added `doc_type` column (`'pdf'` | `'latex'`) to `documents` table with automated schema migration.
  - **CodeMirror 6 Editor (`CodeMirrorLatexEditor.tsx`):** Implemented LaTeX syntax highlighting, bracket matching, line numbers, code folding, and compile error diagnostic banner.
  - **Inline KaTeX Math Decorations (`katexDecoration.ts`):** Created ViewPlugin + StateField rendering live KaTeX math previews for `$..$` and `$$..$$` formulas directly in the editor when unfocused.
  - **DocViewer & Chat Integration:** Added LaTeX PDF preview reloads, direct compiled `.pdf` download, `.tex` source download, LaTeX source context injection in Gemini prompts, and "Replace Selection" action for AI code snippets.

### Sep 25, 2026
- **Configuration Management Architecture (`backend/config.py`, `backend/.config`) (`21f48cf`):**
  - Introduced centralized, frozen `Settings` dataclass loaded once at process startup.
  - Enforced strict configuration precedence: `OS Environment Variables > backend/.env > backend/.config (INI [rsrch]) > Dataclass Defaults`.
  - Added cross-platform runtime path resolution supporting portable executable bundles via `RSRCH_DATA_DIR` and `RSRCH_DIST_DIR`.
  - Decoupled `database.py` and `server.py` to source database paths, PDF storage, and build directories exclusively from `config.settings`.
  - Added test suite in `backend/tests/` covering configuration precedence, database operations, and server utilities (`test_config.py`, `test_database.py`, `test_server_utils.py`).
- **Database Concurrency & Query Optimization (`backend/database.py`):**
  - Eliminated N+1 query loop in `get_all_workspaces()` by batching document retrieval into a single `IN (...)` query.
  - Resolved nested connection checkout deadlocks in `update_document` and `get_note` by reusing existing connection handles.
  - Corrected `get_chat_messages` query to sort by `created_at DESC, id DESC LIMIT ?` and reverse results, ensuring callers reliably receive the chronological conversation tail.
- **LaTeX Slash Command Menu Unification (`latexAutocomplete.ts`, `CodeMirrorLatexEditor.tsx`):**
  - Replaced unstyled CodeMirror autocomplete dropdown with a custom floating `.slash-menu` system identical to the Notes editor (`LiveMarkdownEditor.tsx`).
  - Added structured `LATEX_SLASH_COMMANDS` registry across 5 categories (`Structure`, `Environments`, `Math`, `Lists`, `Formatting`) with monospace badges (`H1`, `H2`, `H3`, `TAB`, `FIG`, `$$`, `½`, `∑`, `REF`, etc.).
  - Positioned menu anchored dynamically to caret screen coordinates (`view.coordsAtPos`) with keyboard navigation (`ArrowUp`, `ArrowDown`, `Enter`, `Tab`, `Escape`) using high-precedence keymap (`Prec.highest`).
- **Dark Mode Caret & Active Line Visibility:**
  - Added missing `@codemirror/view` extensions: `drawSelection()`, `dropCursor()`, `highlightActiveLine()`, and `highlightActiveLineGutter()`.
  - Styled high-contrast white caret for dark mode (`caretColor: var(--text-primary)`, `borderLeft: 2px solid var(--text-primary)`).
- **Selection Highlight Regularization:**
  - Fixed dark mode selection clash where browser native selection overlay double-rendered over CodeMirror's `.cm-selectionBackground` producing patchy, unreadable text.
  - Forced native selection transparent inside `.cm-content` and applied balanced semi-transparent blue highlights for light (`rgba(56, 139, 253, 0.22)`) and dark (`rgba(56, 139, 253, 0.32)`) modes.
- **Ask AI Selection Popup Refinement:**
  - Eliminated double container nesting/padding bug where `.pdf-selection-popup` was wrapped inside CodeMirror's `.cm-tooltip`.
  - Implemented dedicated `.latex-ask-ai-popup` and `.latex-ask-ai-btn` with sparkle SVG icon, 24px height, uniform 3px padding, and 6px vertical offset.
