import os
import glob
import uuid
import asyncio
import time
import mimetypes
from collections import deque
from typing import List, Optional, Dict, Deque
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from database import (
    init_db,
    get_all_workspaces,
    get_workspace,
    create_workspace,
    update_workspace,
    delete_workspace,
    create_document,
    get_document,
    update_document,
    delete_document,
    get_note,
    save_note,
    search_all,
    list_chats,
    create_chat,
    get_chat,
    update_chat_title,
    delete_chat,
    get_chat_messages,
    add_chat_message,
    PDF_DIR,
)
from models import (
    WorkspaceResponse,
    WorkspaceBase,
    WorkspaceUpdate,
    DocumentResponse,
    DocumentUpdate,
    NoteResponse,
    NoteBase,
    SearchResponse,
    ChatMessage,
    ChatCreate,
    ChatSessionResponse,
    ChatSendRequest,
    ChatSendResponse,
)

from compiler import run_compile, get_build_key
import pymupdf
from dotenv import load_dotenv
from google import genai

# Upload / extraction / chat bounds. Unbounded values here previously meant:
# whole-file reads into memory, event-loop-blocking PDF parsing, multi-MB
# DB rows, and the full document + full history re-sent to the model on
# every chat turn (token/cost blowup).
MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_MB", "50")) * 1024 * 1024
MAX_EXTRACTED_CHARS = 200_000
CHAT_CONTEXT_CHARS = 30_000
CHAT_HISTORY_LIMIT = 20
CHAT_TIMEOUT_S = 90
CHAT_RATE_LIMIT = 20  # requests per doc per minute
CHAT_RATE_WINDOW_S = 60

_genai_client = None

def get_genai_client():
    global _genai_client
    if _genai_client is None:
        _genai_client = genai.Client()
    return _genai_client

_chat_hits: Dict[str, Deque[float]] = {}

def check_chat_rate_limit(chat_id: str) -> None:
    now = time.monotonic()
    # Opportunistic sweep: drop windows that expired so the dict can't grow
    # one entry per chatted session forever.
    for key in list(_chat_hits):
        q = _chat_hits[key]
        while q and now - q[0] > CHAT_RATE_WINDOW_S:
            q.popleft()
        if not q:
            del _chat_hits[key]
    hits = _chat_hits.setdefault(chat_id, deque())
    if len(hits) >= CHAT_RATE_LIMIT:
        raise HTTPException(status_code=429, detail="Too many chat requests, slow down")
    hits.append(now)


def _extract_pdf(saved_path: str) -> tuple:
    """Blocking pymupdf parse — always run in a worker thread."""
    extracted_text = ""
    page_count = 1
    try:
        pdf_document = pymupdf.open(saved_path)
        page_count = pdf_document.page_count
        for page_num in range(page_count):
            page = pdf_document.load_page(page_num)
            extracted_text += page.get_text()
        pdf_document.close()
    except Exception as e:
        print(f"Failed to extract PDF text: {e}")
    return extracted_text, page_count

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
load_dotenv() # also load from current dir if exists


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    # Reclaim disk from the pre-cap era: enforce per-doc/global bounds once
    # at startup, off the event loop so boot isn't blocked by huge folders.
    try:
        from compiler import prune_all_builds
        stats = await asyncio.to_thread(prune_all_builds)
        if stats.get("deleted_dirs"):
            print(f"Pruned {stats['deleted_dirs']} stale LaTeX builds "
                  f"({stats['freed_bytes'] / 1048576:.1f} MB freed)")
    except Exception as e:
        print(f"Build prune skipped: {e}")
    yield


app = FastAPI(title="Rsrch API", version="1.0.0", lifespan=lifespan)

# Allow CORS for development Vite frontend.
# NOTE: a wildcard origin cannot be combined with credentials (browsers
# reject it) — lock this to the local dev server in production.
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health():
    return {"status": "ok", "app": "Rsrch"}


# Workspaces
@app.get("/api/workspaces", response_model=List[WorkspaceResponse])
async def list_workspaces():
    return await get_all_workspaces()


@app.post("/api/workspaces", response_model=WorkspaceResponse)
async def create_ws(data: WorkspaceBase):
    ws_id = f"ws_{uuid.uuid4().hex[:8]}"
    return await create_workspace(ws_id, data.name)


@app.put("/api/workspaces/{ws_id}", response_model=WorkspaceResponse)
async def update_ws(ws_id: str, data: WorkspaceUpdate):
    ws = await update_workspace(ws_id, name=data.name, expanded=data.expanded)
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")
    return ws


@app.delete("/api/workspaces/{ws_id}")
async def delete_ws(ws_id: str):
    success = await delete_workspace(ws_id)
    if not success:
        raise HTTPException(status_code=404, detail="Workspace not found")
    return {"success": True, "id": ws_id}


# Documents
@app.post("/api/workspaces/{ws_id}/documents/upload", response_model=DocumentResponse)
async def upload_document(
    ws_id: str,
    file: UploadFile = File(...),
    tag: Optional[str] = Form("General"),
    note_title: Optional[str] = Form(None),
):
    ws = await get_workspace(ws_id)
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")

    doc_id = f"doc_{uuid.uuid4().hex[:10]}"
    raw_name = (file.filename or "document.pdf")[:255]
    file_name = raw_name.strip() or "document.pdf"

    contents = await file.read()
    if len(contents) == 0:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File too large")
    # Magic-byte check: either signal alone rejects. The previous
    # `and` required BOTH a bad extension AND bad magic bytes, so a
    # renamed executable (evil.pdf + non-PDF bytes) sailed through.
    if not file_name.lower().endswith(".pdf") or contents[:5] != b"%PDF-":
        raise HTTPException(status_code=400, detail="Only PDF files are accepted")

    # Clamp unbounded form fields before they reach the DB.
    clean_tag = (tag or "General").strip()[:30] or "General"
    clean_title = note_title.strip()[:120] if note_title and note_title.strip() else None

    # Never persist attacker-controlled extensions (.html/.svg/.exe);
    # stored bytes are validated PDFs, always saved as .pdf.
    saved_path = os.path.join(PDF_DIR, f"{doc_id}.pdf")

    with open(saved_path, "wb") as f:
        f.write(contents)

    # CPU-bound parse off the event loop so one big PDF doesn't stall all
    # other requests; truncate so the DB row and chat context stay bounded.
    extracted_text, page_count = await asyncio.to_thread(_extract_pdf, saved_path)
    extracted_text = extracted_text[:MAX_EXTRACTED_CHARS]

    doc = await create_document(
        doc_id=doc_id,
        workspace_id=ws_id,
        name=file_name,
        note_title=clean_title,
        tag=clean_tag,
        file_path=saved_path,
        page_count=page_count,
        extracted_text=extracted_text,
        doc_type="pdf",
    )
    return doc


@app.post("/api/workspaces/{ws_id}/documents/latex", response_model=DocumentResponse)
async def create_latex_document(
    ws_id: str,
    name: str = Form(..., min_length=1),
):
    ws = await get_workspace(ws_id)
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")

    doc_id = f"doc_{uuid.uuid4().hex[:10]}"
    clean_name = name.strip()
    if not clean_name.lower().endswith(".tex"):
        clean_name += ".tex"

    doc = await create_document(
        doc_id=doc_id,
        workspace_id=ws_id,
        name=clean_name,
        note_title=clean_name,
        tag="General",
        file_path=None,
        page_count=1,
        extracted_text="",
        doc_type="latex",
    )
    
    note = await get_note(doc_id)
    await run_compile(doc_id, note.get("content", ""))
    
    return doc


@app.get("/api/documents/{doc_id}", response_model=DocumentResponse)
async def get_doc(doc_id: str):
    doc = await get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    return doc


@app.get("/api/documents/{doc_id}/file")
async def get_doc_file(doc_id: str):
    doc = await get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    if doc.get("doc_type") == "latex":
        note = await get_note(doc_id)
        source_content = note.get("content", "")
        build_key = get_build_key(source_content, f"{doc_id}.tex")
        pdf_path = os.path.join(os.path.dirname(__file__), "data", "latex_builds", build_key, f"{doc_id}.pdf")
        if not os.path.exists(pdf_path):
            result = await run_compile(doc_id, source_content)
            if result.status != "success":
                # Fallback to the latest successful build
                base_dir = os.path.join(os.path.dirname(__file__), "data", "latex_builds")
                pattern = os.path.join(base_dir, "*", f"{doc_id}.pdf")
                pdfs = glob.glob(pattern)
                if pdfs:
                    pdf_path = max(pdfs, key=os.path.getmtime)
                else:
                    # No successful build exists yet (e.g. brand-new doc with
                    # invalid default content). 404 keeps the viewer in its
                    # loading/empty state instead of a 500 crash loop; the
                    # real diagnostics come via POST /compile.
                    raise HTTPException(status_code=404, detail="PDF not compiled yet")
            else:
                if not os.path.exists(pdf_path):
                    raise HTTPException(status_code=404, detail="PDF not compiled yet")
        return FileResponse(
            path=pdf_path,
            media_type="application/pdf",
            filename=doc["name"].replace(".tex", ".pdf"),
            headers={"Accept-Ranges": "bytes", "Cache-Control": "no-store"},
        )

    if not doc.get("file_path") or not os.path.exists(doc["file_path"]):
        raise HTTPException(status_code=404, detail="PDF file not found")
    
    return FileResponse(
        path=doc["file_path"],
        media_type="application/pdf",
        filename=doc["name"],
        headers={"Accept-Ranges": "bytes"},
    )

@app.post("/api/documents/{doc_id}/compile")
async def compile_document(doc_id: str):
    doc = await get_document(doc_id)
    if not doc or doc.get("doc_type") != "latex":
        raise HTTPException(status_code=404, detail="LaTeX Document not found")
        
    note = await get_note(doc_id)
    source_content = note.get("content", "")
    
    result = await run_compile(doc_id, source_content)
    return result.model_dump()


@app.put("/api/documents/{doc_id}", response_model=DocumentResponse)
async def update_doc(doc_id: str, data: DocumentUpdate):
    doc = await update_document(
        doc_id=doc_id,
        note_title=data.note_title,
        tag=data.tag,
        bookmarked=data.bookmarked,
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    return doc


@app.delete("/api/documents/{doc_id}")
async def delete_doc(doc_id: str):
    success = await delete_document(doc_id)
    if not success:
        raise HTTPException(status_code=404, detail="Document not found")
    return {"success": True, "id": doc_id}


# Notes
@app.get("/api/documents/{doc_id}/note", response_model=NoteResponse)
async def read_doc_note(doc_id: str):
    return await get_note(doc_id)


@app.put("/api/documents/{doc_id}/note", response_model=NoteResponse)
async def save_doc_note(doc_id: str, data: NoteBase):
    return await save_note(doc_id, data.content)


# Search
@app.get("/api/search", response_model=SearchResponse)
async def search(q: str = Query(..., min_length=1)):
    results = await search_all(q)
    return {"query": q, "results": results}


# Chats — global sessions, isolated from documents. A chat records an
# origin document (where it was started) and each send may attach context
# documents; missing docs are skipped so chats outlive deleted PDFs.
@app.get("/api/chats", response_model=List[ChatSessionResponse])
async def list_chat_sessions():
    return await list_chats()


@app.post("/api/chats", response_model=ChatSessionResponse)
async def create_chat_session(data: ChatCreate):
    return await create_chat(title=data.title, document_id=data.document_id)


@app.get("/api/chats/{chat_id}/messages", response_model=List[ChatMessage])
async def get_chat_msgs(chat_id: str, limit: int = 200):
    chat = await get_chat(chat_id)
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")
    return await get_chat_messages(chat_id, limit=max(1, min(limit, 500)))


@app.post("/api/chats/{chat_id}/messages", response_model=ChatSendResponse)
async def send_chat_message(chat_id: str, request: ChatSendRequest):
    chat = await get_chat(chat_id)
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")

    check_chat_rate_limit(chat_id)

    # Resolve context docs (skip missing — chats outlive documents), cap 3.
    context_docs = []
    for doc_id in (request.document_ids or [])[:3]:
        doc = await get_document(doc_id)
        if doc:
            context_docs.append(doc)
    primary_doc_id = context_docs[0]["id"] if context_docs else chat.get("document_id")

    await add_chat_message(chat_id, primary_doc_id, role="user", content=request.message)

    if context_docs:
        per_doc = CHAT_CONTEXT_CHARS // len(context_docs)
        parts = []
        for doc in context_docs:
            if doc.get("doc_type") == "latex":
                note = await get_note(doc["id"])
                text = (note.get("content", "") or "")[:per_doc]
            else:
                text = (doc.get("extracted_text", "") or "")[:per_doc]
            label = doc.get("note_title") or doc.get("name") or "Document"
            parts.append(f"[{label}]\n{text}")
        context_block = "\n\n---\n\n".join(parts)
        system_instruction = (
            "You are a helpful AI assistant. Answer the user's questions "
            f"based on the following document context:\n\n{context_block}"
        )
    else:
        system_instruction = "You are a helpful AI assistant. Answer the user's questions."

    # Bounded history: last N turns of THIS chat (was: full doc history).
    history = await get_chat_messages(chat_id, limit=CHAT_HISTORY_LIMIT * 2 + 1)
    history = history[-CHAT_HISTORY_LIMIT:]

    def _generate():
        client = get_genai_client()
        contents = []
        for msg in history:
            role = "model" if msg["role"] == "assistant" else "user"
            contents.append({"role": role, "parts": [{"text": msg["content"]}]})

        response = client.models.generate_content(
            model='gemini-3.5-flash-lite',
            contents=contents,
            config={'system_instruction': system_instruction}
        )
        return response.text or ""

    try:
        model_reply = await asyncio.wait_for(
            asyncio.to_thread(_generate), timeout=CHAT_TIMEOUT_S
        )
        if not model_reply.strip():
            model_reply = "Sorry, I received an empty response from the model."
    except asyncio.TimeoutError:
        model_reply = "Sorry, the model took too long to respond. Please try again."
    except Exception as e:
        print(f"Gemini API Error: {e}")
        model_reply = "Sorry, I encountered an error communicating with Gemini API."

    saved_msg = await add_chat_message(chat_id, primary_doc_id, role="assistant", content=model_reply)

    # Auto-title untitled chats from the first user message.
    if not (chat.get("title") or "").strip() or chat.get("title") == "New chat":
        auto = request.message.strip().split("\n")[0][:40] or "New chat"
        await update_chat_title(chat_id, auto)

    return {"message": saved_msg}


@app.delete("/api/chats/{chat_id}")
async def delete_chat_session(chat_id: str):
    success = await delete_chat(chat_id)
    if not success:
        raise HTTPException(status_code=404, detail="Chat not found")
    # Drop its rate-limit window too.
    _chat_hits.pop(chat_id, None)
    return {"success": True, "id": chat_id}


# Production frontend serving. `vite build` emits ../dist; serving it from
# the API process removes the whole class of broken deploys behind
# net::ERR_FILE_NOT_FOUND (file:// opened index.html, static hosts without
# .wasm MIME for the pdfium engine, missing worker chunks). Python's
# mimetypes on Windows doesn't know .wasm, which breaks
# WebAssembly.instantiateStreaming — register it explicitly.
mimetypes.add_type("application/wasm", ".wasm")

DIST_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "dist"))
if os.path.isdir(DIST_DIR):
    app.mount(
        "/assets",
        StaticFiles(directory=os.path.join(DIST_DIR, "assets")),
        name="frontend-assets",
    )

    @app.get("/", include_in_schema=False)
    async def spa_root():
        return FileResponse(os.path.join(DIST_DIR, "index.html"))

    @app.get("/{path:path}", include_in_schema=False)
    async def spa_fallback(path: str):
        # API, docs and real files keep their behavior; everything else is
        # the SPA (client-side routing). Registered last so /api/* wins.
        if (
            path.startswith("api/")
            or path in ("docs", "redoc", "openapi.json")
            or path.startswith("docs/")
        ):
            raise HTTPException(status_code=404, detail="Not found")
        full = os.path.normpath(os.path.join(DIST_DIR, path))
        if full.startswith(DIST_DIR) and os.path.isfile(full):
            return FileResponse(full)
        return FileResponse(os.path.join(DIST_DIR, "index.html"))


def start():
    import uvicorn
    uvicorn.run("server:app", host="127.0.0.1", port=8000, reload=False)


if __name__ == "__main__":
    start()
