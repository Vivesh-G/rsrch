# Rsrch — Maintainer Context

> Read this before changing anything. It maps every moving part, what each
> function does, and where to look when something breaks or needs a feature.

## 1. What this is

Research workspace app: workspaces → PDF documents → side-by-side PDF viewer
+ markdown notes + per-document AI chat (Gemini). Two processes in dev, one in prod.

| Piece | Tech | Port |
|---|---|---|
| Frontend | React 19 + TypeScript + Vite, EmbedPDF (pdfium) viewer | 5173 (dev) |
| Backend | FastAPI + aiosqlite, PyMuPDF extraction, Gemini chat | 8000 |

Dev: `vite` (proxies `/api` → 127.0.0.1:8000, see `vite.config.ts`) + backend
(`uvicorn server:app` from `backend/`). Prod: `vite build`, then serve —
`backend/server.py` auto-serves `../dist` (SPA + `/assets`, `.wasm` MIME
registered) when the dir exists, so one process is enough.

Env vars (no defaults unless stated):

| Var | Where | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | backend `.env` / env | Chat model auth (`genai.Client()` reads it) |
| `CORS_ORIGINS` | backend env | Comma list; default `http://localhost:5173,http://127.0.0.1:5173` |
| `MAX_UPLOAD_MB` | backend env | PDF size cap; default `50` |
| `VITE_API_URL` | frontend build-time | Origin of API when split from frontend; default `''` (same origin / Vite proxy) |

SQLite lives at `backend/data/rschr.db`, PDFs at `backend/data/pdfs/` — both gitignored
(`**/data/`, `*.db`, `*.pdf`); the DB was committed once by accident and has been untracked
(`git rm --cached`, file kept on disk). Never re-add data files to git.

## 2. Repo map

```
src/
  App.tsx                  # all global state + handlers (the brain)
  main.tsx                 # StrictMode root (dev double-effects apply!)
  services/api.ts          # fetch wrapper: req(), timeouts, API_BASE
  types/index.ts           # Workspace, DocumentItem, NoteData, ChatMessage
  utils/search.ts          # docMatchesQuery — THE shared search predicate
  components/
    TopBar.tsx             # search input (local state + 150ms debounce), theme, chat toggle
    Sidebar.tsx            # workspace tree, per-doc rows, inline rename
    WorkspaceOverview.tsx  # doc cards grid (no doc open)
    DocViewer.tsx          # EmbedPDF viewer (lazy-loaded chunk)
    NotesPanel.tsx         # title/tag/meta + LiveMarkdownEditor + save/download
    LiveMarkdownEditor.tsx # contentEditable markdown engine, slash menu
    ChatPanel.tsx          # per-doc chat UI
    ErrorBoundary.tsx      # class boundary w/ resetKey
    Modals.tsx / Resizer.tsx / Icons.tsx / KeyboardShortcutsModal.tsx
backend/
  server.py                # routes, upload/chat bounds, SPA serving
  database.py              # all SQL (WAL, indexes, rowcount deletes)
  models.py                # pydantic schemas
```

## 3. Backend

### `server.py` — routes

| Method + path | Handler | Does | Errors |
|---|---|---|---|
| `GET /api/health` | `health` | liveness | — |
| `GET /api/workspaces` | `list_workspaces` | all workspaces + embedded docs | — |
| `POST /api/workspaces` | `create_ws` | `ws_<8hex>` + name | 422 |
| `PUT /api/workspaces/{id}` | `update_ws` | name/expanded | 404 |
| `DELETE /api/workspaces/{id}` | `delete_ws` | + deletes PDF files | 404 if no row |
| `POST /api/workspaces/{ws}/documents/upload` | `upload_document` | validate → store → extract → row + starter note | 404 ws / 413 size / 400 non-PDF |
| `GET /api/documents/{id}` | `get_doc` | metadata | 404 |
| `GET /api/documents/{id}/file` | `get_doc_file` | PDF bytes (`Accept-Ranges`) | 404 |
| `PUT /api/documents/{id}` | `update_doc` | note_title/tag/bookmarked | 404 |
| `DELETE /api/documents/{id}` | `delete_doc` | + deletes file | 404 if no row |
| `GET /api/documents/{id}/note` | `read_doc_note` | note (creates starter on miss) | — |
| `PUT /api/documents/{id}/note` | `save_doc_note` | upsert note | — |
| `GET /api/search` | `search` | name/title/tag/note LIKE search | — (**unused by UI**; UI filters client-side) |
| `GET /api/chats` | `list_chat_sessions` | all chats, `updated_at DESC`, with `message_count`, `last_preview`, `origin_title` | — |
| `POST /api/chats` | `create_chat_session` | `{title?, document_id?}`; unknown doc → null origin (never 404) | 422 |
| `GET /api/chats/{id}/messages` | `get_chat_msgs` | ordered messages, `limit` clamped 1–500 (default 200) | 404 chat |
| `POST /api/chats/{id}/messages` | `send_chat_message` | rate-limit → resolve ≤3 context docs (missing skipped) → store user msg → bounded history → Gemini → store reply → auto-title | 404 / 429 / 422 |
| `DELETE /api/chats/{id}` | `delete_chat_session` | messages + chat + rate window | 404 if no row |

### `server.py` — non-route functions

- `get_genai_client()` — lazily creates ONE `genai.Client()` (module `_genai_client`). Touch when: auth changes, model swap, mocking tests.
- `check_chat_rate_limit(doc_id)` — in-memory sliding window, 20 req / 60s / doc → 429. Resets on restart (by design). Touch when: limits abused or too strict.
- `_extract_pdf(path)` — **blocking** PyMuPDF full-text parse; must only run via `asyncio.to_thread` (upload does). Touch when: extraction wrong/pages miscounted.
- `lifespan` — runs `init_db()` on startup. `start()` — uvicorn, `reload=False`.
- SPA block (`DIST_DIR`, `spa_root`, `spa_fallback`) — serves `../dist` if present; `.wasm` MIME registered (Windows mimetypes lacks it — without this the PDF engine fails to init in prod). Catch-all is registered **last** so `/api/*` wins; `api/*`, `docs`, `openapi.json` never fall through to index.html; path-traversal guarded (`normpath` + prefix check). Touch when: prod assets 404 / `ERR_FILE_NOT_FOUND` (see §7.1).

### Bounds (top of `server.py`)

`MAX_UPLOAD_BYTES` (50MB) · `MAX_EXTRACTED_CHARS` 200k · `CHAT_CONTEXT_CHARS` 30k ·
`CHAT_HISTORY_LIMIT` 20 · `CHAT_TIMEOUT_S` 90 · `CHAT_RATE_LIMIT` 20/min/chat (`_chat_hits`
sweeps expired windows on every check + drops the entry on chat delete, so it can't grow).
Model string `'gemini-3.5-flash-lite'` is inline in `send_chat_message` — change it there.
Chat context = up to 3 attached docs, budget split evenly, each labeled `[title]`; missing
docs skipped; no docs → generic (doc-less) answer. Untitled chats auto-title from the first
message (first line, 40 chars).

### `database.py` — functions

- `get_db()` — per-op connection, `foreign_keys=ON`, `journal_mode=WAL`, `busy_timeout=30s`. Touch when: "database is locked".
- `init_db()` — creates tables, `extracted_text` migration, chat indexes, seeds `ws_default`.
- `get_all_workspaces()` — workspaces + embedded docs (`bookmarked`→bool, `has_file` from `file_path`). N+1 queries; fine at this scale.
- `get_workspace(id)` — single row or None (used by upload validation).
- `create_workspace / update_workspace` (`update_workspace` returns None when no fields → 404).
- `delete_workspace / delete_document` — remove file from disk, then DELETE; return `rowcount > 0` (0 → 404 upstream). Cascades (notes, chat) via FK.
- `create_document(...)` — row + starter note; returns metadata **without** `file_path` (never leak abs paths to client).
- `get_document / update_document` — note `update_document` with no fields re-reads.
- `get_note` (auto-creates starter) / `save_note` (upsert).
- `search_all` — `LOWER LIKE` across name/title/tag/note + snippet. No FTS; add FTS5 if slow.
- Chats (global sessions, isolated from docs): `_ensure_chat_schema` (creates `chats`, rebuilds `chat_messages` once to drop legacy `NOT NULL`/FK on `document_id`, backfills one chat per doc that had legacy rows), `list_chats` (counts + preview + origin title, `updated_at DESC`), `create_chat` (unknown origin doc → null, never 404), `get_chat`, `update_chat_title` (auto-title), `delete_chat` (messages + chat, `rowcount`-based), `get_chat_messages(chat, limit)` (ASC, capped), `add_chat_message(chat, doc?, role, content)` + bumps `updated_at` (`RETURNING *`, needs SQLite ≥3.35). No FK from messages to docs — chats deliberately outlive deleted PDFs.

### `models.py`

`NoteBase/Response`, `DocumentBase/Update/Response`, `WorkspaceBase/Update/Response`,
`SearchResultItem/SearchResponse`, `ChatMessage` (now carries `id/chat_id/document_id`),
`ChatCreate`, `ChatSessionResponse`, `ChatSendRequest` (**message 1–4000 chars, ≤3 `document_ids`**),
`ChatSendResponse`. Validation errors surface as 422.

## 4. Frontend

### `services/api.ts`

- `API_BASE = (VITE_API_URL ?? '') + '/api'`. `getDocumentFileUrl(id)` returns the file URL (used by viewer + downloads).
- `req(path, init?, timeoutMs)` — AbortController timeout (30s default, 120s upload/chat), throws `ApiError(status, detail)` parsed from FastAPI `detail`, `'Request timed out'` on abort. **All** backend calls go through it.
- `getWorkspaces` falls back to `[]` (App keeps local default ws); `getChatHistory` falls back to `[]`. Everything else throws to the caller.
- `uploadDocument` re-attaches `doc.file = file` so the viewer can open the buffer without refetching.

### `App.tsx` — state ownership (single source of truth)

| State | Updated by | Consumed by |
|---|---|---|
| `workspaces` | all CRUD handlers | Sidebar, Overview, activeDoc memo |
| `activeWsId / activeDocId` | select handlers | everything |
| `notesCache: Record<docId, md>` | `handleNoteChange` (instant) → debounced persist 800ms (localStorage + `saveNote`) | NotesPanel; Sidebar search **only while a query is active** (`sidebarNotesCache`, else stable `EMPTY_NOTES_CACHE` — this is what stops per-keystroke sidebar renders) |
| `searchQuery` (+ `useDeferredValue`) | TopBar (150ms debounce) | Sidebar, Overview filters |
| widths, `sidebarCollapsed`, `isChatOpen`, modals, `saveStatus/lastSavedTime` | resizers / UI | layout |

Key handlers: `handleAddFiles` (uploads all, then commits workspaces + notes + activation **once** — never per-file), `doDeleteWorkspace` (single-pass + `queueMicrotask` for dependent selects), `doDeleteDoc` (also clears note cache + localStorage), `handleToggleBookmark` (optimistic + fire-and-forget), `handleTitleChange` (immediate tree update + 500ms debounced PUT), `handleRenameDoc` (discrete commits), `handleTagChange` (400ms debounce), `handleNoteChange` (instant UI + 800ms persist), `handleAddToNoteFromPdf` (**pure updater** — persistence outside; StrictMode double-invoke would double-save otherwise), `handleManualSave` (Ctrl+S + save btn, clears pending debounce), `resolveDocTitle` (ref-based, stable identity for chat chips), `handleToggleChat` (closing clears `rschr-chat-id` so toggles land blank; refresh never runs it), resizers (rAF-throttled; chat resizer reads live notes width via ref).

UI state persists across refresh via `usePersistentState` (`readStored` + write-through effect): `rschr-ws` / `rschr-doc` (selection, reconciled against loaded workspaces — stale ids fall back), `rschr-sidecol`, `rschr-sidew` / `rschr-notesw` / `rschr-chatw` (layout), `rschr-chat-open` (panel visibility), `rschr-chat-id` (open chat, owned by ChatPanel). Workspace expand flags persist server-side (`updateWorkspace`); the initial fetch reconciles rather than resets.

Note-load effect deps are `[activeDocId, activeDocName]` with a `cancelled` flag and cache-first check (localStorage → backend → starter template).

### Components

- **`TopBar`** — local input state (60fps) + 150ms debounce to App. Ctrl+K skips editable targets. Theme persists to `rschr-theme` localStorage; pre-paint script in `index.html` + `matchMedia` fallback avoids flash; `body.dark` is synced from state by effect (single source of truth). Memo'd.
- **`Sidebar`** — `loweredNotes` memo (only when querying) + `filteredWorkspaces` via `docMatchesQuery`. Caret = expand-only (`stopPropagation`); row = expand + select (select clears `activeDocId` → overview). Inline rename (Enter/blur commit, Esc cancel). Memo'd but invalidated by `workspaces`/`notesCache` identity — hence `sidebarNotesCache`.
- **`WorkspaceOverview`** — same `docMatchesQuery` (name/title/tag/**note body**) + distinct "no matches" vs "welcome" empty states. Cards are click-divs (no keyboard role — a11y gap if you touch this).
- **`utils/search.ts — docMatchesQuery(doc, query, loweredNote?)`** — change search semantics here and BOTH views follow. (Backend `/api/search` is separate/dead UI-wise.)
- **`DocViewer`** (lazy chunk `DocViewer-*.js` + `pdfium.wasm` + `worker-engine-*`, all load on first PDF open):
  - `plugins` is module-level (remounting `EmbedPDF` resets everything — never move it into a component).
  - `DocumentKeeper` — opens `doc.file` buffer or backend URL under `doc.id`, once per doc, and KEEPS docs open across switches (closing on switch used to re-parse every PDF + race fails under stress). Synchronous `openingRef` guard = StrictMode-safe; full-unmount effect closes all. Engine store is per-documentId by design, so scroll/zoom/annotations survive switches; page restore is then a fast fallback.
  - `HighlightRestorer` — deferred 400ms import, **idempotent**: exports current store, repairs duplicate ids (`deleteAnnotation` + re-add one survivor), imports only missing ids; persist dedupes before `localStorage.setItem` with quota guard. See §7.2 for why.
  - `SelectionMenu` — Add-to-note / Highlight (`hl_*` ids + `commit()`) / Copy; clipboard failure → toast, never throw.
  - `LoadedViewer` — mounts only when `isLoaded` (hooks throw otherwise). Deliberately NOT remounted per doc (`key` removed): remounting the viewport/scroller/gesture subtree against persisted engine state caused revisit-only breakage (shifted layout, dead touchpad zoom); docs switch via `documentId` props instead, per-doc UI (tint map, restored-pages set, transient resets) handled in-component. Scroll restore: immediate attempt + 250ms poll gated on measurable layout (`getLayout().virtualItems.length > 0`), then one `scrollToPage(behavior:'instant')`; `onLayoutChange` (replays last layout) + `onLayoutReady` are extra triggers. Never gate on `currentPage` — the plugin sets the number optimistically even when the viewport can't move yet. Page persisted per change (`rshr-page-*`), drag-over guards ignore non-file drags, `rsrch:scroll-to-page` event contract with notes, `renderPage` is `useCallback([doc?.id, tintMode, …])` — keep it stable or every zoom tick re-renders all pages.
  - `DocViewer` memo comparator ignores `tag/added_at/page_count` (viewer doesn't render them) — update it if it ever does.
- **`NotesPanel`** — tag dropdown, word count, save btn (`onManualSave(noteContent)`), download btn (`<title>.md` blob + persist same snapshot). Memo comparator covers `has_file/file` (open/download behavior).
- **`LiveMarkdownEditor`** — uncontrolled contentEditable lines (`dataset.source` ↔ rendered HTML). `esc()` MUST keep quote-escaping (attribute-breakout XSS otherwise). `updateWordCount` → parent `onChange` debounced 250ms; word-count callback skipped when unchanged. Full slash-command registry (`commands` memo), block selection, paste/split/merge, broad Ctrl/Cmd shortcuts — see `KeyboardShortcutsModal` copy when changing keybindings. Debounce timer cleaned on unmount.
- **`ChatPanel`** — global, doc-independent. Opens on a **blank draft** on toggle (panel unmount clears nothing; App clears the stored id on intentional close), restores the open chat after a **refresh** (`rschr-chat-id` verified against the fetched list, deleted chats fall back blank). History view lists past chats (title · origin · count · date · preview) with two-tap delete; opening a chat loads its messages and derives context chips from them. Context = explicit attach chips (`+ current PDF` button, × to remove, empty = general chat). Send on a draft creates the chat first; message keys `id ?? created_at-idx`; `created_at` normalized to backend seconds. No error toast on send failure (known gap). Props are `activeDocId/activeDocTitle/resolveDocTitle` (strings + stable callback — never pass `workspaces` or it re-renders per keystroke).
- **`ErrorBoundary`** (`resetKey` clears error on doc switch) wraps DocViewer, ChatPanel, NotesPanel separately in `App.tsx` — a panel crash shows a fallback, never blanks the app. Logs `componentStack` to console.

### Cross-cutting contracts

- localStorage: `rsrch-note-{docId}` (note md) · `rshr-page-{docId}` (page num —sic, keeps historic typo) · `rsrch-pdf-highlights-{docId}` (deduped annotation transfers) · `rschr-theme` · UI-persistence keys `rschr-ws`, `rschr-doc`, `rschr-sidecol`, `rschr-sidew`, `rschr-notesw`, `rschr-chatw`, `rschr-chat-open`, `rschr-chat-id`.
- Event: `window 'rsrch:scroll-to-page' {detail:{page}}` — editor `[p. N]` badges → viewer smooth-scroll + pulse.
- Filenames: `baseName()` strips `.pdf`; download names strip `\ / : * ? " < > |`.

## 5. Feature recipes (where to cut)

| Want | Touch |
|---|---|
| New backend endpoint | `models.py` schema → `database.py` fn → `server.py` route (before SPA block!) → `api.ts` method |
| New global state | `App.tsx` useState + stable `useCallback` + memoized `style` (else memo'd children rerender) |
| Change search semantics | `utils/search.ts` only |
| Change LLM / prompt | `send_chat_message` in `server.py` (+ bounds at top); chat UI is `ChatPanel`, storage is `chats`/`chat_messages` |
| Chat history / retention | `get_chat_messages` limit, `list_chats` ordering; no pruning job exists — add one if tables grow |
| New note markdown syntax | `inline()/renderBlock()` in `LiveMarkdownEditor.tsx` (keep `esc()` first!) |
| New viewer toolbar btn | `LoadedViewer` toolbar; page-level needs `renderPage` deps |
| New panel next to notes/chat | `App.tsx` layout + `Resizer` + width state + `ErrorBoundary` wrapper |

## 6. Verify

`npx tsc -b` must be clean · `npx vite build` must succeed · backend: `python -m py_compile backend/*.py` + `import server` from venv. (ESLint is broken repo-wide: `typescript-eslint` vs TS 7 — pre-existing, don't chase it.)

## 7. Incident log (solved — don't regress)

### 7.1 `net::ERR_FILE_NOT_FOUND`
Chrome logs this for `file://` subresource loads and missing prod assets — never for FastAPI 404s (those log as 404). Trigger was always **PDF-open time**: that's when the lazy `DocViewer` chunk, `pdfium.wasm`, `worker-engine` and `/api/.../file` load. Causes: opening `dist/index.html` directly, or a static host without `.wasm` MIME / missing chunks (backend never served `dist/`). Fix: `server.py` serves `../dist` + registers `application/wasm`; run one process. If it recurs: DevTools → click the failing request → the URL distinguishes missing-asset (path) from backend-down (`ERR_CONNECTION_REFUSED`) from missing-PDF-row (404 JSON).

### 7.2 Duplicate annotation keys (`two children with the same key <uuid>`) + multiplying highlights
Library reducer appends imported uids blindly; our old code re-imported exports containing the PDF's **embedded** foreign highlights → same id rendered N×, growing every cycle. Fixed by idempotent import + store repair + deduped persist (`HighlightRestorer`). Never call `importAnnotations` with unfiltered exports.

### 7.3 Past state bugs (invariants to keep)
Pure state updaters (StrictMode double-invokes them — no I/O inside) · stable callback identities for memo'd children · capability objects excluded from effect deps (identity churn) · `saveTimeoutRef`/all timers cleaned on unmount · clipboard guarded (insecure contexts) · object URLs revoked + anchors appended (Firefox/Safari) · chat history race-guarded · CORS explicit origins (wildcard+credentials is rejected) · deletes are `rowcount`-based (0 → 404) · SQLite WAL + busy timeout (autosave vs chat lock) · `reload=False` in prod.

## 8. Changelog

### Sep 22, 2026
- **Architecture: Movable Layout System:** 
  - Integrated `framer-motion` `Reorder.Group` in `App.tsx` governed by a new `panelOrder` state array (`['viewer', 'chat', 'notes']`). The `Sidebar` is intentionally excluded and statically locked to the left.
  - Introduced a `PanelWrapper` component to map the `panelOrder` IDs to their respective flex containers (`Reorder.Item`).
  - **Render-Prop Drag Injection:** We used a render-prop pattern in `PanelWrapper` (`children: (dragHandle: ReactNode) => ReactNode`) to pass the `Reorder.Item`'s `dragControls` into the deeply nested panel headers. This elegantly bypassed the `ErrorBoundary` wrappers which otherwise severed the connection between the layout container and the nested header.
- **Architecture: Resizer Performance Tuning:** 
  - Disabled full bounding-box `layout` animations in `framer-motion` by passing `layout="position"` to the `Reorder.Item`s. By only animating the x/y transform coordinates during drops, we completely removed the extreme visual lag caused by framer-motion constantly interpolating flex width/height during standard resizer dragging.
- **UI & Layout Integrity:** 
  - The introduction of `Reorder.Item` wrappers broke implicit `flex-grow` heights, causing broken scrollbars and visible gaps. Explicitly applying `height: 100%` overrides inside the flex containers restored full vertical bounds.
  - **Sidebar UX:** Added a 3px dark-gray visual hint for the collapsed sidebar. Reworked the invisible hover trigger's coordinate mapping: since the parent `.sidebar.collapsed` uses a CSS `transform`, `position: fixed` elements inside it behave as `position: absolute`. The trigger was changed to `absolute` with `left: calc(100% - 14px)` so hovering anywhere against the very left edge of the screen correctly pops the drawer out.
- **Header & State Cleanups:** 
  - Removed the bulky editable title block from `NotesPanel`, stripping out its internal `titleDraft` and debouncing state to flatten the component. The header is now a single concise line (`[DragHandle] Notes / [Title] [Save] [Download]`).
- **Brand Identity & Spacing:** 
  - Created a new dynamic black-and-white duotone SVG logo (`IconLogo` in `Icons.tsx`) and added it to the `TopBar`. Fixed its internal SVG viewBox bounds to securely map 32x32 dimensions to perfectly align its optical center with the "Rsrch" brand text.
  - Reduced the global `.app` shell gap from `var(--space-2)` to `4px` for a tighter fit between the navbar and workspace.
