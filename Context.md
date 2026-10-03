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
  types/index.ts             # Workspace, DocumentItem (doc_type: 'pdf' | 'latex'), NoteData, ChatMessage (+cited_pages/code_patch/action_type)
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
    ChatPanel.tsx            # global chat UI: context picker (capped at MAX_ATTACHED_DOCS), KaTeX math, citation badges, LaTeX Copy/Insert/Replace toolbar
    ErrorBoundary.tsx        # class boundary w/ resetKey
    Modals.tsx / Resizer.tsx / Icons.tsx / KeyboardShortcutsModal.tsx
backend/
  server.py                  # routes, upload/chat bounds, DSPy chat orchestration, compile orchestration, SPA serving
  database.py                # all SQL (WAL, doc_type, batched doc queries, FTS5 chunk index, connection safety)
  models.py                  # pydantic schemas (maxLength bounds, DocumentCreateLatex, workspace_ids, chat metadata fields)
  ai/                        # DSPy layer: config.py (get_dspy_lm), signatures.py, retriever.py, validators.py, modules/{paper_qa,latex_copilot,diagnostics}.py
  chunker.py                 # page-aware PDF chunking (section detection, paragraph splitting)
  reindex_pdfs.py            # manual backfill: chunk PDFs that have no chunks (startup backfill does this automatically now)
  # NOTE: ai/ imports are top-level (`from ai.x import y`, `from database import ...`) —
  # the backend must run with backend/ on sys.path (`uvicorn server:app` from backend/).
  config.py                  # frozen Settings dataclass (single-source of truth for env/.env/.config)
  compiler.py                # Tectonic compilation runner, SHA256 build caching, LRU pruning
  diagnostics.py             # TeX log and stderr parser for line-numbered compiler diagnostics
  .config                    # committed non-secret configuration defaults
  tests/                     # pytest suite (test_config.py, test_database.py, test_server_utils.py, test_settings_api.py, test_ai_layer.py)
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
| `POST /api/chats/{id}/messages` | `send_chat_message` | rate-limit → API-key guard → resolve explicit docs (≤6, deduped) + workspace docs (≤6 total) → FTS chunks w/ `extracted_text` fallback → branch `/latex` / `/fix` / QA via DSPy (sync `_generate` in worker thread) → citation gating → store reply + `cited_pages` → auto-title | 404 / 429 / 422 |
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
- AI chat internals (`send_chat_message` only — no streaming endpoint; SSE was removed, see §7.5):
  - `get_dspy_lm(model, api_key_override)` (`ai/config.py`) — builds `dspy.LM(gemini/<model>)` from request key → DB key → env key; falls back to `settings.gemini_model` on blank/`"none"`.
  - `GroundedPaperQAModule(document_ids=[])` (`ai/modules/paper_qa.py`) — CoT over `GroundedPaperQA`; always called with empty ids because retrieval runs first in the request handler (keeps DSPy on one thread; `FTS5RetrieverModule` is unreachable from chat). Takes an explicit `system` field for persona — **never smuggle instructions into `chat_history` as a fake `"System: …"` turn**; that confuses the model about the conversation.
  - `SafeLatexModule` / `FixTectonicErrorModule` — LaTeX gen + compiler-error fix. Shared `_strip_code_fences()` in `latex_copilot.py` (imported by `diagnostics.py`) removes ``` fences on **every** attempt, including the retry-exhausted return — see §7.6.
  - `has_pdf_context` + `_strip_page_citations` / `_extract_page_citations` — `[p. N]` / `[p. N, p. M]` / `[pp. N-M]` markers are stripped from code always, and from prose + `cited_pages` unless a PDF is in context (rule: citations live only with PDF context). All three share `_CITATION_BODY`; `_extract_page_citations` **expands ranges** (`[pp. 10-12]` → `[10, 11, 12]`, capped at 500 to survive typos).
  - `WORKSPACE_CONTEXT_DOCS = 6` — cap on total merged context docs per send. `MAX_ATTACHED_DOCS = 6` — cap on explicit `document_ids`; must stay in sync with `ChatSendRequest.document_ids` and the ChatPanel picker cap.
  - Command parsing: `/latex` / `/fix` are split off with `partition(" ")` **before** dispatch, so the literal command prefix never reaches the LM as part of the instruction or error log.
- Background tasks: `_spawn_background(coro, name=...)` keeps a strong reference in the module-level `_background_tasks` set. **Never call bare `asyncio.create_task`** — CPython only weakly references tasks, so an unreferenced one can be GC'd mid-execution and silently cancelled. `lifespan` cancels and drains the set on shutdown.
- Chunk pipeline: `upload_document` fires background `_index_document_chunks` → `chunker.chunk_pdf` (page-first, `MAX_CHUNK_CHARS`=1500, section carry-forward, PDF handle always closed via `finally`) → `store_chunks` (delete-before-insert). `search_chunks(ids, query, 8)` — stopword-stripped, **quoted** terms (so no user text can produce a malformed `MATCH`), AND-first with OR fallback, BM25-ranked, and an `OperationalError` fallback to `[]` rather than a 500. Query tokenizing uses `\w`/`re.UNICODE` so non-ASCII text is not deleted.
- `lifespan` — runs `settings.ensure_dirs()`, `init_db()`, startup build cache pruning, and background `_backfill_chunks()` (chunks any PDF with zero rows — this is what makes pre-chunking libraries searchable without a manual `reindex_pdfs.py` run).
- SPA block (`DIST_DIR`, `spa_root`, `spa_fallback`) — serves `dist/` if present; `.wasm` MIME registered for WebAssembly PDF engine streaming. Catch-all registered last; path-traversal guarded via `.resolve()` and prefix checks.

### Bounds & Defaults (from `config.settings`)

`MAX_UPLOAD_BYTES` (50MB) · `MAX_EXTRACTED_CHARS` 200k · `CHAT_CONTEXT_CHARS` 30k · `CHAT_HISTORY_LIMIT` 20 · `CHAT_TIMEOUT_S` 90 · `CHAT_RATE_LIMIT` 20/min/chat (`_chat_hits` sweeps expired windows on every check + drops entry on chat delete).
Model string comes from `settings.gemini_model` (default `'gemini-3.5-flash-lite'`).
Chat context = explicit docs (≤6, deduped) + workspace-resolved docs (≤6 total, explicit first), budget (`CHAT_CONTEXT_CHARS` 30k) split evenly; LaTeX docs inline as `[LaTeX source: <filename>]` (the file name carries `.tex`, so never label these `[p. 1]`), PDFs as FTS chunk hits `[p. N | title | section]` with `extracted_text` fallback when FTS misses. Untitled chats auto-title from the first message (first line, 40 chars).

### `database.py` — functions

- `get_db()` — per-op connection, `foreign_keys=ON`, `journal_mode=WAL`, `busy_timeout=30s`.
- `init_db()` — creates tables (`workspaces`, `documents`, `notes`, `chats`, `chat_messages`, `document_chunks` + `document_chunks_fts` FTS5 external-content table with AI/AD/AU sync triggers), migrates `doc_type` column, creates indexes, seeds `ws_default`. No per-boot FTS rebuild (triggers keep the index in sync).
- `store_chunks` (delete-before-insert per doc) / `delete_document_chunks` / `search_chunks` (stopword strip, AND-first/OR-fallback, BM25) / `get_workspace_documents(ws_id)` (PDF/LaTeX full rows, oldest-first).
- `_dedupe_pages(pages)` — shared coercion for citation page lists (sorted unique ints, drops junk). Used by `add_chat_message` and `send_chat_message`.
- `get_unindexed_pdf_docs()` — PDFs with a `file_path` but zero chunks; the startup backfill worklist (`NOT EXISTS` subquery, one query).
- `get_all_workspaces()` — single batched query using `WHERE workspace_id IN (...)` (eliminated legacy N+1 query loop).
- `get_workspace(id)` — single row or None.
- `create_workspace / update_workspace` — updates return None when no fields → 404 upstream.
- `delete_workspace / delete_document` — removes files from disk, then DELETE; returns `rowcount > 0`. Cascades via FK.
- `create_document(...)` — supports `doc_type` ('pdf' | 'latex'); sets starter template (`.tex` starter document for LaTeX); returns metadata without leaking local disk paths.
- `get_document / update_document` — re-reads updated rows using the **same connection handle** to prevent connection pool deadlocks.
- `get_note` (auto-creates starter) / `save_note` (upsert) — re-uses existing connection handle for title lookup.
- `search_all` — `LOWER LIKE` across name/title/tag/note.
- Chats: `list_chats`, `create_chat`, `get_chat`, `update_chat_title`, `delete_chat`, `get_chat_messages` (queries `ORDER BY created_at DESC, id DESC LIMIT ?` and reverses rows so callers reliably receive the chronological tail), `add_chat_message(chat_id, document_id, role, content, cited_pages=None)`.
- Chat message rows carry a `cited_pages` column (JSON array text, default `'[]'`). Added by migration in `init_db`; `_chat_msg_row_to_msg` / `_decode_cited_pages` decode it on every read so callers always get `list[int]`, never the raw JSON string. **Citations must be persisted here** or they vanish on history reload — see §7.6.

### `models.py`

`NoteBase/Response/NoteUpdate`, `DocumentBase/Update/Response`, `DocumentCreateLatex`, `WorkspaceBase/Update/Response`, `SearchResultItem/SearchResponse`, `ChatMessage` (+ optional `cited_pages` — **persisted in a DB column**; `code_patch` / `action_type` — response-only, transient), `ChatCreate`, `ChatSessionResponse`, `ChatSendRequest` (message 1–4000 chars, **≤6 `document_ids`** matching `MAX_ATTACHED_DOCS`, ≤2 `workspace_ids`), `ChatSendResponse`. Strict `maxLength` validations enforced on titles, tags, and names.

## 4. Frontend

### `services/api.ts`

- `API_BASE = (VITE_API_URL ?? '') + '/api'`. `getDocumentFileUrl(id)` returns file URL.
- All path parameters sanitized with `encodeURIComponent`.
- `req(path, init?, timeoutMs)` — AbortController timeout (30s default, 120s upload/chat), throws `ApiError(status, detail)`.
- Methods: `getWorkspaces`, `createWorkspace`, `updateWorkspace`, `deleteWorkspace`, `uploadDocument`, `createLatexDocument`, `compileDocument`, `getDocument`, `updateDocument`, `deleteDocument`, `getNote`, `saveNote`, `listChats`, `createChat`, `getChatMessages`, `sendChatMessage(chatId, message, documentIds?, workspaceIds?)`, `deleteChat`.

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
- **`ChatPanel`** — global AI chat (sync JSON send, `Thinking...` waiter — no SSE). Context row: per-doc chips + removable `≡ <workspace>` chips + `+ Add Context` popover (workspace PDF/TeX list with filter; `≡ Add workspace` attaches whole-workspace retrieval). Attachment is hard-capped at `MAX_ATTACHED_DOCS` (mirrors the backend) and shows a limit message — never let the picker build a request the API rejects. Data via stable ref-based `listContextDocs()` prop (must use the same workspace fallback as `activeWorkspace`, or the picker lists a different workspace than the chip). KaTeX math via `remark-math`/`rehype-katex`; `[p. …]` markers render as badges via `transformCitations` (regex must mirror `_CITATION_BODY`); the `cited_pages` chip row shows only pages **not** already rendered inline. LaTeX code blocks get Copy/Insert/`✨ Replace Selection`. **`latex_patch` responses are never auto-applied.** Textarea (Enter sends, Shift+Enter newline) + quick-action chips that *prefill* the composer instead of sending.
- **`Resizer`** — accessible proportional resizer with pair-weighted drag math, keyboard navigation (`ArrowLeft`/`ArrowRight`), and ARIA separator attributes.
- **`ErrorBoundary`** — class boundary with `resetKey` isolating panel failures.

### Cross-cutting contracts

- localStorage: `rsrch-note-{docId}` (note text / tex source) · `rshr-page-{docId}` (page num) · `rsrch-pdf-highlights-{docId}` (deduped annotations) · `rschr-theme` · UI keys `rschr-ws`, `rschr-doc`, `rschr-sidecol`, `rschr-sidew`, `rschr-notesw`, `rschr-chatw`, `rschr-chat-open`, `rschr-chat-id`.
- Event: `window 'rsrch:scroll-to-page' {detail:{page}}` — editor `[p. N]` badges → viewer smooth-scroll.
- Code block replacement: `window 'rsrch:replace-selection' {detail:{code}}` — ChatPanel code block → active editor selection replacement.
- LaTeX handoff: `window 'rsrch:latex-apply' {detail:{code}}` (replace selection) and `'rsrch:latex-insert' {detail:{code}}` (insert at caret) — fired **only** by ChatPanel's explicit Copy/Insert/`✨ Replace Selection` toolbar. `CodeMirrorLatexEditor` handles both.
- `window 'rsrch:latex-ask-ai-fix' {detail:{message, line}}` — private editor↔editor hop for `✨ Fix with AI`. The editor's own listener slices ±12 lines of real source around `line` and forwards a complete `/fix` prompt via `rsrch:chat-send`. Keep this split: the backend only has the chat context doc, which is nowhere near the error site in a long `.tex` file.
- Chat triggers: `window 'rsrch:chat-append' {detail:{text}}` (append to input) and `'rsrch:chat-send' {detail:{message}}` (send immediately). `rsrch:chat-send` is captured in **`App.tsx`**, not ChatPanel — the panel unmounts when closed, so a panel-level listener silently drops editor-initiated sends. App stores the message in `pendingChatSend` and opens the chat panel; ChatPanel drains it via the `pendingSend` prop.

## 5. Feature recipes (where to cut)

| Want | Touch |
|---|---|
| New backend endpoint | `models.py` schema → `database.py` fn → `server.py` route (before SPA block!) → `api.ts` method |
| New global state | `App.tsx` useState + stable `useCallback` + memoized `style` (else memo'd children rerender) |
| New fire-and-forget backend work | `_spawn_background(...)` in `server.py`, **never** bare `asyncio.create_task` |
| New chat response field | `models.py` field → decide persist-in-DB vs response-only → `database.add_chat_message` → `ChatPanel` render |
| Change search semantics | `utils/search.ts` only |
| Change LLM / prompt | `backend/ai/signatures.py` (DSPy signatures) + branch dispatch in `send_chat_message` (`server.py`); persona strings live next to the dispatch; chat UI is `ChatPanel` |
| LaTeX compilation tuning | `backend/compiler.py` (`compile_semaphore`, timeouts, flags) & `diagnostics.py` |
| New LaTeX slash command | Add to `LATEX_SLASH_COMMANDS` in `src/components/latexAutocomplete.ts` |
| New note markdown syntax | `inline()/renderBlock()` in `LiveMarkdownEditor.tsx` (keep `esc()` first!) |
| New viewer toolbar btn | `LoadedViewer` toolbar in `DocViewer.tsx`; page-level needs `renderPage` deps |
| New panel in workspace | `App.tsx` layout + `Resizer` + width state + `ErrorBoundary` wrapper + `RightSidebar` toggle |

## 6. Verify

- Frontend build: `bun run build` (runs `tsc -b && vite build` cleanly).
- Backend tests: `uv run pytest backend/tests`. `test_ai_layer.py` covers the AI path (validators, citation markers, fence stripping, `cited_pages` persistence, FTS robustness) and is **sync-only** — it calls `asyncio.run` internally so it passes with or without `pytest-asyncio` installed.
- Backend syntax verification: `python -m py_compile backend/*.py`.
- (ESLint is broken repo-wide: `typescript-eslint` vs TS 7 — pre-existing, don't chase it.)
- Known pre-existing test failures, unrelated to the AI layer: `test_settings_api.py::test_lazy_table_creation_without_init_db` and the `pytest.Pytest*` fixture errors in `test_database.py` (they need `pytest-asyncio`; without it installed the async `test_db` fixture errors out). Verify against `git stash` before assuming a change caused them.

## 7. Incident log (solved — don't regress)

### 7.1 `net::ERR_FILE_NOT_FOUND`
Chrome logs this for `file://` subresource loads and missing prod assets — never for FastAPI 404s. Trigger was always PDF-open time (lazy `DocViewer` chunk, `pdfium.wasm`, `worker-engine`, `/api/.../file`). Fix: `server.py` serves `dist/` + registers `application/wasm`; run one process.

### 7.2 Duplicate annotation keys + multiplying highlights
Library reducer appends imported uids blindly; re-importing exports containing embedded foreign highlights caused duplicate key crashes. Fixed by idempotent import + store repair + deduped persist (`HighlightRestorer`). Never call `importAnnotations` with unfiltered exports.

### 7.3 CodeMirror selection double-paint in dark mode
Browser native `::selection` overlay rendered concurrently with CodeMirror's `.cm-selectionBackground`, creating unreadable dark blotches in dark mode. Fixed by setting `.cm-content ::selection { background: transparent !important }` and applying clean semi-transparent background rules on `.cm-selectionBackground`.

### 7.4 SQLite nested connection checkout deadlocks
`update_document` and `get_note` previously invoked `get_document()` while still holding open an active transaction on another connection handle, risking SQLite busy timeout deadlocks. Fixed by executing follow-up queries on the same connection handle.

### 7.5 AI chat SSE streaming removed (garbage outputs + citation leaks)
The DSPy `streamify` endpoint parsed incremental JSON deltas as cumulative snapshots with regex unescaping, corrupting every streamed answer; its `else:`-dedented dispatch also ran QA streaming on `/latex` and `/fix` requests (unbound-module crash after a full blob). Deleted entirely — one sync DSPy path in `send_chat_message` (`/latex` / `/fix` / QA branches, retrieval pre-run in the handler, no nested threads in `dspy.context`). Never re-add token streaming by parsing partial DSPy JSON; if streaming returns, yield dumb slices of the finished string. Related: `[p. N]` markers are gated by `has_pdf_context` — models otherwise copy citation style into LaTeX code (see `_strip_page_citations`).

### 7.6 AI layer bug sweep (fixed — don't regress)
Round-two review of the uncommitted DSPy layer. Each item below was a real defect, reproduced before fixing.

**Destructive / correctness**
- `latex_patch` responses were **auto-applied** to the editor (`ChatPanel` dispatched `rsrch:latex-apply` on every AI reply). With no selection this replaced the user's whole document, with no confirmation and no undo affordance. Auto-apply removed; the toolbar buttons are the only path. **Never write to the user's document without an explicit click.**
- `SafeLatexModule` assigned the fence-stripped code to `result.latex_code` only on the *successful* attempt, so a retry-exhausted return shipped ```` ```latex ```` fences into `code_patch` — written verbatim into the `.tex` file. Stripping now happens every attempt.
- `has_balanced_environments` counted braces inside `%` comments, so valid LaTeX with a stray brace in a comment failed validation and burned 3 LM calls. Comments are stripped before counting (both braces and `\begin`/`\end` tokens).
- `ChatSendRequest.document_ids` was capped at 3 while the context picker had no cap → attaching a 4th doc was a hard 422 surfaced as "check your connection". Cap is now `MAX_ATTACHED_DOCS = 6` on both sides, with a picker limit message.

**Retrieval / prompt**
- `/fix` shipped the literal `"/fix "` prefix inside `error_log` and never sent the offending source lines (the model got 30k chars of document head instead). Command parsing is now a `partition(" ")` before dispatch, and `✨ Fix with AI` attaches ±12 real lines via the private `rsrch:latex-ask-ai-fix` hop.
- Persona was smuggled in as a fake `"System: …"` entry in `chat_history`. `GroundedPaperQA` now has a real `system` input field.
- `search_chunks` regex was `[^\w\s]`-free (`[^a-zA-Z0-9\s]`), silently deleting accented/non-Latin characters; now `\w` + `re.UNICODE`. Terms are also quoted before `MATCH` so user text can't produce a malformed expression, and `OperationalError` degrades to `[]` instead of 500-ing chat.
- Quick-action chips sent bare prompts ("Summarize this document.") that reduce to one stopword-ish FTS term → arbitrary chunks. They now prefill the composer with an editable, more specific prompt.
- LaTeX context was labelled `[p. 1 | title]`, inventing a page number for a source file. Now `[LaTeX source: <filename>]`.
- `hasLatexContext` tested `title.endsWith('.tex')`, but titles are `note_title || baseName(name)` — the extension is *stripped*, so the LaTeX chip branch was unreachable. Always branch on `doc_type`, never on a filename suffix.
- `listContextDocs()` used `?? workspaces[0]` while `activeWorkspace` used `|| workspaces[0]`, so the picker could list a different workspace than the `≡ Add workspace` chip. Unified.

**Citations**
- `_extract_page_citations` and the frontend badge regex only matched `[p. N]`; `[pp. 10-12]` and `[p. 1, p. 2]` (which `_strip_page_citations` explicitly handled) produced no badges. All three now share one pattern and expand ranges into individual pages.
- `cited_pages` was response-only, so reloading chat history lost every badge. Persisted in a `chat_messages.cited_pages` column (migrated in `init_db`, decoded on read). `code_patch`/`action_type` stay response-only by design — they are transient.
- Pages already rendered as inline badges were repeated in the `cited_pages` chip row. The row now shows only the remainder.
- `transformCitations` returned unkeyed strings inside an array (React key warnings). Fixed; the global regex's `lastIndex` is also reset between calls.

**Resource / hygiene**
- `asyncio.create_task(_index_document_chunks(...))` was unreferenced, so a long chunking job could be GC'd mid-execution. Added `_spawn_background` with a strong-reference set, cancelled and drained in `lifespan`.
- `chunker.chunk_pdf` never closed the PyMuPDF handle → a file-handle leak per indexed PDF. Now closed in `finally`.
- Pre-chunking PDFs stayed unindexed unless someone ran `reindex_pdfs.py` manually, silently degrading chat to `extracted_text` truncation. `lifespan` now runs `_backfill_chunks()` in the background (idempotent).
- Removed dead imports (`anyio.from_thread.run` in `retriever.py`, `has_balanced_environments` in `diagnostics.py`), removed the never-produced `reasoning` field from `ChatMessage`, pinned `dspy-ai>=3.4.0` in `requirements.txt` to match `pyproject.toml`.
- `DocViewer`/`LiveMarkdownEditor` already listened for `rsrch:scroll-to-page` — verified, no change needed.

## 8. Changelog

### Sep 27–28, 2026 (uncommitted — see `AI-Refractor.md` for the debug record)
- **AI chat rebuild (DSPy + FTS5, no streaming):** `backend/ai/` (Gemini bridge, `GroundedPaperQA` / `SafeLatexGenerator` / `FixTectonicError` signatures, CoT modules, LaTeX validators), page-aware `chunker.py` + `document_chunks`/`document_chunks_fts` BM25 index with background ingest on upload and startup backfill. Sync `POST /api/chats/{id}/messages` with `/latex` / `/fix` / QA branches; `cited_pages` persisted in `chat_messages`, `code_patch`/`action_type` response-only; citation markers gated to PDF context.
- **Chat context picker:** `+ Add Context` popover (workspace PDF/TeX attach without opening) + `≡ <workspace>` whole-workspace retrieval chips; `workspace_ids` plumbed `ChatPanel → api → ChatSendRequest → get_workspace_documents()` (≤6 docs total, explicit first).
- **ChatPanel UX:** textarea input, quick-action chips, clickable `[p. N]` badges → viewer scroll, LaTeX Copy/Insert/Replace toolbar.
- **AI bug sweep (§7.6):** removed `latex_patch` auto-apply, fixed fence leakage on retry exhaustion, comment-aware LaTeX validation, aligned the attach cap with the picker, real source lines for `/fix`, `system` signature field, unicode-safe + quoted FTS queries, persisted citations, and background-task/handle-leak fixes. Added `backend/tests/test_ai_layer.py` (14 tests).

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
- **Phase 1: Workspace Assets & Images:**
  - Integrated `AssetsPanel.tsx` in the right sidebar for drag-and-drop workspace asset management.
  - Added backend endpoints `GET`/`POST /api/workspaces/{ws_id}/assets` (with `.sty`, `.cls`, `.bst` root routing and standard image `figures/` handling) to `server.py`.
  - Updated `compiler.py` to seamlessly copy the `assets/` directory into the isolated build sandbox so Tectonic resolves relative paths correctly.
  - Implemented CodeMirror drag-and-drop event interception to auto-upload and insert `\includegraphics{}` macros for images and PDFs.
- **Phase 2: Academic Citation & Bibliography System:**
  - Implemented `BibtexPanel.tsx` as a dedicated right sidebar tab for managing `references.bib` with debounced auto-saving.
  - Backed by `GET`/`PUT /api/workspaces/{ws_id}/bibtex` endpoints storing directly to the workspace `assets/` directory (picked up by Tectonic automatically).
  - Wrote a custom regex parser for `.bib` contents and integrated it via `@codemirror/autocomplete` into `CodeMirrorLatexEditor.tsx`, presenting a smart inline dropdown for `\cite{...}` commands containing paper title, author, and year.
  - Bridged `BibtexPanel` and `CodeMirrorLatexEditor` with a custom window event (`rsrch:bibtex-updated`) for instant autocomplete dictionary refetching without full page reloads.
  - Standardized UI paddings, header breadcrumbs, and layout flex properties across `NotesPanel`, `AssetsPanel`, and `BibtexPanel`. Added a custom `IconRef` for the bibliography sidebar tab.
