import os
import glob
import uuid
import asyncio
import time
import mimetypes
from collections import deque
from typing import List, Optional, Dict, Deque, cast
from contextlib import asynccontextmanager
import logging

from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

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
)
from config import settings
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

from compiler import run_compile, get_build_key, prune_all_builds
import pymupdf
from google import genai

logger = logging.getLogger("rsrch.server")

# All tunables live in config.settings (loaded once from backend/.env at
# startup, frozen until restart). No os.getenv / load_dotenv here.
MAX_UPLOAD_BYTES = settings.max_upload_bytes
MAX_EXTRACTED_CHARS = settings.max_extracted_chars
CHAT_CONTEXT_CHARS = settings.chat_context_chars
CHAT_HISTORY_LIMIT = settings.chat_history_limit
CHAT_TIMEOUT_S = settings.chat_timeout_s
CHAT_RATE_LIMIT = settings.chat_rate_limit
CHAT_RATE_WINDOW_S = settings.chat_rate_window_s

_genai_client = None

def get_genai_client():
    global _genai_client
    if _genai_client is None:
        _genai_client = genai.Client()
    return _genai_client

_chat_hits: Dict[str, Deque[float]] = {}
_chat_sweep_at = 0.0


def check_chat_rate_limit(chat_id: str) -> None:
    """Per-key sliding window. O(1): only touches this chat's deque.
    Global expiry now runs at most once per window to bound dict growth.
    """
    global _chat_sweep_at
    now = time.monotonic()
    hits = _chat_hits.setdefault(chat_id, deque())
    while hits and now - hits[0] > CHAT_RATE_WINDOW_S:
        hits.popleft()
    if len(hits) >= CHAT_RATE_LIMIT:
        raise HTTPException(status_code=429, detail="Too many chat requests, slow down")
    hits.append(now)

    if now - _chat_sweep_at > CHAT_RATE_WINDOW_S:
        _chat_sweep_at = now
        for key in list(_chat_hits):
            if key == chat_id:
                continue
            q = _chat_hits[key]
            while q and now - q[0] > CHAT_RATE_WINDOW_S:
                q.popleft()
            if not q:
                del _chat_hits[key]


def _extract_pdf(saved_path: str) -> tuple[str, int]:
    """Blocking pymupdf parse — always run in a worker thread."""
    log = logging.getLogger("rsrch.pdf")
    parts: list[str] = []
    page_count = 1
    try:
        with pymupdf.open(saved_path) as pdf_document:
            page_count = pdf_document.page_count
            for page_num in range(page_count):
                page = pdf_document.load_page(page_num)
                parts.append(cast(str, page.get_text()))
    except Exception as e:
        log.warning("Failed to extract PDF text from %s: %s", saved_path, e)
    return "".join(parts), page_count


def _is_pdf_bytes(data: bytes) -> bool:
    """Magic-byte check tolerant of leading whitespace/BOM.

    Some producers prepend whitespace or a UTF-8 BOM before %PDF-;
    strict contents[:5] rejected those valid files.
    """
    stripped = data.lstrip(b"\x00 \t\r\n\x0c ")
    # Strip UTF-8 BOM explicitly (lstrip above can't express multi-byte cleanly).
    if stripped.startswith(b"\xef\xbb\xbf"):
        stripped = stripped[3:]
    return stripped.startswith(b"%PDF-")

@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    # Reclaim disk from the pre-cap era: enforce per-doc/global bounds once
    # at startup, off the event loop so boot isn't blocked by huge folders.
    try:
        stats = await asyncio.to_thread(prune_all_builds)
        if stats.get("deleted_dirs"):
            logger.info(
                "Pruned %s stale LaTeX builds (%.1f MB freed)",
                stats["deleted_dirs"],
                stats["freed_bytes"] / 1048576,
            )
    except Exception as e:
        logger.warning("Build prune skipped: %s", e)
    yield


app = FastAPI(title="Rsrch API", version="1.0.0", lifespan=lifespan)

# CORS origins are frozen in config.settings (backend/.env -> CORS_ORIGINS).
# NOTE: a wildcard origin cannot be combined with credentials (browsers
# reject it) — lock this to the local dev server in production.
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
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

    if not file_name.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are accepted")

    # Clamp unbounded form fields before they reach the DB.
    clean_tag = (tag or "General").strip()[:30] or "General"
    clean_title = note_title.strip()[:120] if note_title and note_title.strip() else None

    # Never persist attacker-controlled extensions (.html/.svg/.exe);
    # stored bytes are validated PDFs, always saved as .pdf.
    saved_path = str(settings.pdf_dir / f"{doc_id}.pdf")
    settings.pdf_dir.mkdir(parents=True, exist_ok=True)

    # Streamed upload: 1 MB chunks, enforce size cap as we go so a
    # 50 MB+ body never sits fully in RAM twice. First chunk carries
    # the magic-byte check (BOM/whitespace tolerant).
    import aiofiles

    total = 0
    first_chunk: bytes | None = None
    try:
        async with aiofiles.open(saved_path, "wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                if first_chunk is None:
                    first_chunk = chunk
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="File too large")
                await out.write(chunk)
    finally:
        await file.close()
    if total == 0:
        try:
            os.remove(saved_path)
        except OSError:
            pass
        raise HTTPException(status_code=400, detail="Empty file")
    if not _is_pdf_bytes(first_chunk or b""):
        try:
            os.remove(saved_path)
        except OSError:
            pass
        raise HTTPException(status_code=400, detail="Only PDF files are accepted")

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
    await run_compile(doc_id, note.get("content", ""), workspace_id=ws_id)
    
    return doc

@app.get("/api/workspaces/{ws_id}/assets")
async def list_workspace_assets(ws_id: str):
    ws = await get_workspace(ws_id)
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")
        
    assets_dir = settings.data_dir / "workspaces" / ws_id / "assets"
    if not assets_dir.exists():
        return {"assets": []}
        
    assets = []
    # Using glob to find all files recursively
    for filepath in assets_dir.rglob("*"):
        if filepath.is_file():
            # Get relative path for frontend
            rel_path = filepath.relative_to(assets_dir).as_posix()
            assets.append({"path": rel_path})
            
    return {"assets": assets}

@app.post("/api/workspaces/{ws_id}/assets")
async def upload_workspace_assets(ws_id: str, files: List[UploadFile] = File(...), path: str = Form("figures")):
    ws = await get_workspace(ws_id)
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")
        
    # Prevent directory traversal
    clean_path = path.strip().strip("/")
    if ".." in clean_path:
        raise HTTPException(status_code=400, detail="Invalid path")
        
    target_dir = settings.data_dir / "workspaces" / ws_id / "assets" / clean_path
    target_dir.mkdir(parents=True, exist_ok=True)
    
    import aiofiles
    uploaded = []
    for file in files:
        if not file.filename:
            continue
            
        file_target_dir = target_dir
        if file.filename.lower().endswith(('.sty', '.cls', '.bst')):
            file_target_dir = settings.data_dir / "workspaces" / ws_id / "assets"
            
        file_target_dir.mkdir(parents=True, exist_ok=True)
        save_path = file_target_dir / file.filename
        
        async with aiofiles.open(str(save_path), "wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                await out.write(chunk)
        
        rel_path = save_path.relative_to(settings.data_dir / "workspaces" / ws_id / "assets").as_posix()
        uploaded.append({"path": rel_path, "filename": file.filename})
        
    return {"status": "success", "uploaded": uploaded}

class BibtexUpdate(BaseModel):
    content: str

@app.get("/api/workspaces/{ws_id}/bibtex")
async def get_bibtex(ws_id: str):
    ws = await get_workspace(ws_id)
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")
    bib_path = settings.data_dir / "workspaces" / ws_id / "assets" / "references.bib"
    if bib_path.exists():
        return {"content": bib_path.read_text(encoding="utf-8", errors="replace")}
    return {"content": ""}

@app.put("/api/workspaces/{ws_id}/bibtex")
async def save_bibtex(ws_id: str, data: BibtexUpdate):
    ws = await get_workspace(ws_id)
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")
    assets_dir = settings.data_dir / "workspaces" / ws_id / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)
    bib_path = assets_dir / "references.bib"
    bib_path.write_text(data.content, encoding="utf-8")
    return {"status": "success"}


@app.get("/api/documents/{doc_id}", response_model=DocumentResponse)
async def get_doc(doc_id: str):
    doc = await get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    return doc


@app.get("/api/documents/{doc_id}/synctex")
async def get_doc_synctex(doc_id: str):
    doc = await get_document(doc_id)
    if not doc or doc.get("doc_type") != "latex":
        raise HTTPException(status_code=404, detail="Document not found or not LaTeX")

    note = await get_note(doc_id)
    source_content = note.get("content", "")
    build_key = get_build_key(source_content, f"{doc_id}.tex")
    synctex_path = str(settings.latex_builds_dir / build_key / f"{doc_id}.synctex.gz")
    
    if not await asyncio.to_thread(os.path.exists, synctex_path):
        # Fallback to the latest successful build
        pattern = str(settings.latex_builds_dir / "*" / f"{doc_id}.synctex.gz")
        st_files = await asyncio.to_thread(glob.glob, pattern)
        if st_files:
            synctex_path = await asyncio.to_thread(max, st_files, key=os.path.getmtime)
        else:
            raise HTTPException(status_code=404, detail="SyncTeX not found")
            
    return FileResponse(
        path=synctex_path,
        media_type="text/plain",
        filename=f"{doc_id}.synctex",
        headers={"Content-Encoding": "gzip", "Cache-Control": "no-store"}
    )

@app.get("/api/documents/{doc_id}/file")
async def get_doc_file(doc_id: str):
    doc = await get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    if doc.get("doc_type") == "latex":
        note = await get_note(doc_id)
        source_content = note.get("content", "")
        build_key = get_build_key(source_content, f"{doc_id}.tex")
        pdf_path = str(settings.latex_builds_dir / build_key / f"{doc_id}.pdf")
        # Filesystem probes run off the event loop (was: blocking
        # os.path.exists / glob.glob inline in the async handler).
        if not await asyncio.to_thread(os.path.exists, pdf_path):
            result = await run_compile(doc_id, source_content, workspace_id=doc["workspace_id"])
            if result.status != "success":
                # Fallback to the latest successful build
                pattern = str(settings.latex_builds_dir / "*" / f"{doc_id}.pdf")
                pdfs = await asyncio.to_thread(glob.glob, pattern)
                if pdfs:
                    pdf_path = await asyncio.to_thread(max, pdfs, key=os.path.getmtime)
                else:
                    # No successful build exists yet (e.g. brand-new doc with
                    # invalid default content). 404 keeps the viewer in its
                    # loading/empty state instead of a 500 crash loop; the
                    # real diagnostics come via POST /compile.
                    raise HTTPException(status_code=404, detail="PDF not compiled yet")
            elif not await asyncio.to_thread(os.path.exists, pdf_path):
                raise HTTPException(status_code=404, detail="PDF not compiled yet")
        return FileResponse(
            path=pdf_path,
            media_type="application/pdf",
            filename=doc["name"].replace(".tex", ".pdf"),
            headers={"Accept-Ranges": "bytes", "Cache-Control": "no-store"},
        )

    if not doc.get("file_path") or not await asyncio.to_thread(
        os.path.exists, doc["file_path"]
    ):
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
    
    result = await run_compile(doc_id, source_content, workspace_id=doc["workspace_id"])
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

    # Bounded history: most recent N of THIS chat, chronological.
    # get_chat_messages returns the tail in order — no extra slicing.
    history = await get_chat_messages(chat_id, limit=CHAT_HISTORY_LIMIT)

    def _generate():
        client = get_genai_client()
        contents = []
        for msg in history:
            role = "model" if msg["role"] == "assistant" else "user"
            contents.append({"role": role, "parts": [{"text": msg["content"]}]})

        response = client.models.generate_content(
            model=settings.gemini_model,
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
        logger.warning("Gemini API error on chat %s: %s", chat_id, e)
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


# Production frontend serving. Paths come from config.settings so exe
# bundles can relocate dist/ via RSRCH_DIST_DIR. Python's mimetypes on
# Windows doesn't know .wasm, which breaks WebAssembly.instantiateStreaming.
mimetypes.add_type("application/wasm", ".wasm")

DIST_DIR = str(settings.dist_dir)
if settings.dist_dir.is_dir():
    app.mount(
        "/assets",
        StaticFiles(directory=str(settings.frontend_assets_dir)),
        name="frontend-assets",
    )

    @app.get("/", include_in_schema=False)
    async def spa_root():
        return FileResponse(str(settings.frontend_index))

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
        full = (settings.dist_dir / path).resolve()
        try:
            is_inside = full.is_relative_to(settings.dist_dir.resolve())
        except AttributeError:  # Python < 3.9 fallback
            is_inside = str(full).startswith(str(settings.dist_dir.resolve()))
        if is_inside and full.is_file():
            return FileResponse(str(full))
        return FileResponse(str(settings.frontend_index))


def start():
    import uvicorn
    uvicorn.run("server:app", host="127.0.0.1", port=8000, reload=False)


if __name__ == "__main__":
    start()
