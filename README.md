# Rsrch

A minimalist research workspace for reading PDFs, taking markdown notes, and querying documents with AI.

Rsrch organizes papers into workspaces with a side-by-side view featuring an embedded PDF reader, a live markdown editor, and an AI chat assistant powered by Google Gemini.

---

## Features

- **Workspaces & Documents**: Group PDFs and LaTeX projects into workspaces, tag them, bookmark favorites, and filter across documents and note contents instantly.
- **Live LaTeX Authoring & Compilation**: Built-in CodeMirror 6 LaTeX editor with live inline math previews, autocomplete slash commands, and a headless Tectonic backend engine compiling PDFs in real time.
- **Interactive SyncTeX (Forward & Inverse Sync)**: Seamlessly jump from the compiled PDF preview directly to the corresponding LaTeX source block, or click a line in the editor to instantly scroll the PDF to the matching spatial location.
- **Embedded PDF Viewer**: WebAssembly-based PDF reader with fast page navigation, text selection tools, highlighting, and dynamic context menus.
- **Live Markdown Notes**: ContentEditable note editor with slash commands (`/h1`, `/todo`, `/code`, etc.), auto-saving to local storage and SQLite, and `.md` file export.
- **Document-Aware AI Chat**: Ask questions against attached PDFs or generate LaTeX code using Google Gemini with sliding-window rate limiting, session history, and one-click "Replace Selection".
- **Dark & Light Modes**: Clean UI with persistent theme toggle and resizable panels.

---

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite, EmbedPDF (`pdfium.wasm`)
- **Backend**: FastAPI, Uvicorn, Python 3.11+, aiosqlite (SQLite with WAL mode), Tectonic LaTeX Engine
- **PDF Processing**: PyMuPDF (`fitz`) for text extraction
- **AI Integration**: Google GenAI SDK

---

## Getting Started

### Prerequisites

- Node.js 18+ or [Bun](https://bun.sh/)
- Python 3.11+ (or [uv](https://github.com/astral-sh/uv))
- A Google Gemini API key

### 1. Install Dependencies

**Frontend:**
```bash
npm install
# or
bun install
```

**Backend:**
```bash
python -m venv .venv

# Windows (PowerShell):
.venv\Scripts\Activate.ps1
# macOS/Linux:
source .venv/bin/activate

# Install requirements with pip or uv:
uv sync
# or: pip install fastapi uvicorn aiosqlite pymupdf google-genai python-dotenv python-multipart
```

### 2. Configure Environment

Create a `.env` file in the `backend/` directory:

```env
GEMINI_API_KEY=your_gemini_api_key_here
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
MAX_UPLOAD_MB=50
```

---

## Running the App

### Development (Two Processes)

Run the backend and frontend in separate terminals:

**Backend (FastAPI on port 8000):**
```bash
python backend/server.py
```

**Frontend (Vite on port 5173):**
```bash
npm run dev
# or
bun run dev
```

Open `http://localhost:5173` in your browser. Requests to `/api` are automatically proxied to the backend.

### Production (Single Process)

In production, FastAPI serves both the API and the built frontend static assets from a single port.

1. Build the frontend:
   ```bash
   npm run build
   # or
   bun run build
   ```

2. Start the server:
   ```bash
   python backend/server.py
   ```

Open `http://127.0.0.1:8000` in your browser.

---

## Environment Variables

| Variable | Location | Default | Description |
|---|---|---|---|
| `GEMINI_API_KEY` | `backend/.env` | None (required for chat) | Google Gemini API key |
| `CORS_ORIGINS` | Backend environment | `http://localhost:5173,http://127.0.0.1:5173` | Allowed CORS origins (comma-separated) |
| `MAX_UPLOAD_MB` | Backend environment | `50` | Maximum PDF file upload size in MB |
| `VITE_API_URL` | Frontend build-time | `""` (empty string) | API root URL (defaults to same origin) |

---

## Project Structure

```
rsrch/
├── backend/
│   ├── data/                 # SQLite database (rschr.db) and uploaded PDFs
│   ├── database.py           # Async SQLite queries and schema setup
│   ├── models.py             # Pydantic request/response models
│   ├── server.py             # FastAPI routes, rate limiter, and SPA serving
│   └── .env                  # Backend secrets and environment config
├── src/
│   ├── App.tsx               # Global application state and event handlers
│   ├── main.tsx              # React entry point
│   ├── index.css             # Base styles and theme variables
│   ├── components/
│   │   ├── TopBar.tsx        # Search, theme toggle, and chat panel button
│   │   ├── Sidebar.tsx       # Workspace tree and document navigation
│   │   ├── WorkspaceOverview.tsx # Document grid view when no document is active
│   │   ├── DocViewer.tsx     # EmbedPDF viewer with cache, highlights, and SyncTeX
│   │   ├── NotesPanel.tsx    # Switches between markdown notes and CodeMirror LaTeX editor
│   │   ├── LiveMarkdownEditor.tsx # ContentEditable markdown engine and slash menu
│   │   ├── CodeMirrorLatexEditor.tsx # CodeMirror 6 LaTeX engine with SyncTeX and KaTeX
│   │   ├── ChatPanel.tsx     # Gemini chat interface with context attachments
│   │   ├── ErrorBoundary.tsx # Isolated component crash boundaries
│   │   └── Resizer.tsx       # Drag resizers for split layout
│   ├── services/
│   │   └── api.ts            # Frontend fetch client and error handling
│   ├── types/
│   │   └── index.ts          # Core TypeScript types
│   └── utils/
│       └── search.ts         # Shared search filter logic
├── package.json
├── pyproject.toml
└── vite.config.ts
```

---

## API Endpoints

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/health` | Health check endpoint |
| `GET` | `/api/workspaces` | Get all workspaces and nested document metadata |
| `POST` | `/api/workspaces` | Create a new workspace |
| `PUT` | `/api/workspaces/{id}` | Rename or update expanded state of a workspace |
| `DELETE` | `/api/workspaces/{id}` | Delete a workspace and its files |
| `POST` | `/api/workspaces/{ws}/documents/upload` | Upload a PDF document and extract text |
| `POST` | `/api/workspaces/{ws}/documents/latex` | Create a new LaTeX document |
| `GET` | `/api/documents/{id}` | Get document metadata |
| `GET` | `/api/documents/{id}/file` | Stream PDF file bytes or compiled LaTeX PDF |
| `POST` | `/api/documents/{id}/compile` | Trigger LaTeX compilation |
| `GET` | `/api/documents/{id}/synctex` | Fetch SyncTeX layout mappings |
| `PUT` | `/api/documents/{id}` | Update document title, tag, or bookmark status |
| `DELETE` | `/api/documents/{id}` | Delete a document and its stored PDF |
| `GET` | `/api/documents/{id}/note` | Get the markdown note for a document |
| `PUT` | `/api/documents/{id}/note` | Save or update markdown note content |
| `GET` | `/api/chats` | List all chat sessions |
| `POST` | `/api/chats` | Create a chat session |
| `GET` | `/api/chats/{id}/messages` | Get message history for a chat |
| `POST` | `/api/chats/{id}/messages` | Send a chat message with document context |
| `DELETE` | `/api/chats/{id}` | Delete a chat session |

---

MVP Screenshot:
<img width="1847" height="1015" alt="image" src="https://github.com/user-attachments/assets/a3f5d251-3d95-40d0-8755-2acbd449d88e" />
<img width="1841" height="969" alt="image" src="https://github.com/user-attachments/assets/9e37ac98-5fef-46fb-b9a8-84a3c09a5099" />



## Notes

- **Database**: SQLite runs with `journal_mode=WAL` and a 30s busy timeout in `database.py` to prevent locks during concurrent saves and chat calls.
- **Wasm MIME type**: Windows Python `mimetypes` does not register `.wasm` by default. `server.py` explicitly adds `application/wasm` so the PDF engine loads properly when served from FastAPI.
- **Highlights**: `DocViewer.tsx` handles deduplication of imported PDF highlight IDs to prevent duplicate key errors in React.
- **State updates**: Handlers in `App.tsx` keep side effects outside state updaters to remain safe under React 19 `StrictMode`.

## Contribution
Feel free to test the app and contribute to it!

## License

This software is distributed under a **Modified MIT License (Non-Commercial / Personal Use Only)**. It is free to use and inspect for personal, educational, and non-commercial research purposes. Any commercial use, redistribution for profit, SaaS hosting, or incorporation into commercial products requires a separate commercial license. See [LICENSE](LICENSE) for terms.

---

Copyright © 2026 Vivesh G. All rights reserved.
