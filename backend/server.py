import os
import uuid
import asyncio
import mimetypes
from typing import List, Optional
from contextlib import asynccontextmanager
import logging

from fastapi import FastAPI, HTTPException, Request, UploadFile, File, Form, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path, PureWindowsPath

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
    get_all_settings,
    set_settings,
    search_chunks,
    get_workspace_documents,
    dedupe_pages,
    store_chunks,
    get_unindexed_pdf_docs,
)
from config import (
    CHAT_MAX_DOCS,
    CHAT_MAX_WORKSPACES,
    DEFAULT_AUTO_COMPILE_DELAY,
    DEFAULT_EDITOR_FONT_SIZE,
    DEFAULT_EDITOR_LINE_NUMBERS,
    DEFAULT_EDITOR_WORD_WRAP,
    settings,
)
from models import (
    BibtexUpdate,
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
    SettingsResponse,
    SettingsUpdate,
    TestKeyPayload,
)

from compiler import get_build_artifact, prune_all_builds, run_compile
from chunker import chunk_pages, chunk_pdf, extract_pdf_pages
import httpx
import dspy
from ai.config import get_dspy_lm, resolve_ai_config
from ai.modules.latex_copilot import FixTectonicModule, SafeLatexModule
from ai.modules.paper_qa import GroundedPaperQAModule
from rate_limiter import ChatRateLimiter, RateLimitExceeded
from citations import (
    strip_page_citations,
    sanitize_output,
    extract_page_citations,
)

logger = logging.getLogger("rsrch.server")

# Background fire-and-forget tasks must be strongly referenced: CPython only
# holds a weak reference to a running task, so an unreferenced task can be
# garbage-collected mid-execution and silently cancelled.
_background_tasks: set["asyncio.Task"] = set()


def _spawn_background(coro, *, name: str) -> "asyncio.Task":
    """Run `coro` as a task that cannot be GC'd before it finishes."""
    task = asyncio.ensure_future(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    task.set_name(name)
    return task


chat_limiter = ChatRateLimiter(
    limit=settings.chat_rate_limit,
    window_s=settings.chat_rate_window_s,
)


async def _stream_upload_to_path(
    file: UploadFile, dest: Path, max_bytes: int
) -> tuple[int, bytes]:
    """Stream an UploadFile to `dest` with bounded memory and clean size-cap cleanup."""
    total = 0
    first_chunk = b""
    too_large = False
    try:
        with open(dest, "wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                if not first_chunk:
                    first_chunk = chunk
                total += len(chunk)
                if total > max_bytes:
                    too_large = True
                    break
                out.write(chunk)
    finally:
        await file.close()
    if too_large:
        try:
            dest.unlink(missing_ok=True)
        except OSError:
            pass
        raise HTTPException(status_code=413, detail="File too large")
    return total, first_chunk


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
    settings.ensure_dirs()
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

    # Self-heal the FTS index: PDFs uploaded before chunking existed have no
    # rows, which silently degrades chat to `extracted_text` truncation.
    # Runs in the background so boot is never blocked, and is idempotent.
    _spawn_background(_backfill_chunks(), name="backfill-chunks")
    yield
    # Let in-flight index tasks finish (or cancel) on shutdown.
    for task in list(_background_tasks):
        task.cancel()
    if _background_tasks:
        await asyncio.gather(*_background_tasks, return_exceptions=True)


app = FastAPI(title="Rsrch API", version="1.0.0", lifespan=lifespan)


@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(_request: Request, exc: RateLimitExceeded):
    return JSONResponse(status_code=429, content={"detail": str(exc)})

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
    saved_path = settings.pdf_dir / f"{doc_id}.pdf"
    settings.pdf_dir.mkdir(parents=True, exist_ok=True)

    # Streamed upload: 1 MB chunks, enforce size cap as we go so a
    # 50 MB+ body never sits fully in RAM twice. First chunk carries
    # the magic-byte check (BOM/whitespace tolerant).
    total, first_chunk = await _stream_upload_to_path(
        file, saved_path, settings.max_upload_bytes
    )
    if total == 0:
        saved_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="Empty file")
    if not _is_pdf_bytes(first_chunk):
        saved_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="Only PDF files are accepted")

    # CPU-bound parse off the event loop so one big PDF doesn't stall all
    # other requests; read pages once and reuse them for both text and FTS chunks.
    try:
        pages, page_count = await asyncio.to_thread(extract_pdf_pages, str(saved_path))
    except Exception as e:
        logger.warning("Failed to extract PDF text from %s: %s", saved_path, e)
        pages, page_count = [], 1
    extracted_text = "".join(pages)[: settings.max_extracted_chars]

    doc = await create_document(
        doc_id=doc_id,
        workspace_id=ws_id,
        name=file_name,
        note_title=clean_title,
        tag=clean_tag,
        file_path=str(saved_path),
        page_count=page_count,
        extracted_text=extracted_text,
        doc_type="pdf",
    )

    async def _index_document_chunks(d_id: str, page_texts: list[str]):
        try:
            chunks = await asyncio.to_thread(chunk_pages, page_texts)
            await store_chunks(d_id, chunks)
            logger.info("Indexed %d chunks for %s", len(chunks), d_id)
        except Exception:
            # Non-fatal: chat falls back to documents.extracted_text.
            logger.exception("Failed to index chunks for %s", d_id)

    _spawn_background(
        _index_document_chunks(doc_id, pages),
        name=f"index-chunks:{doc_id[:8]}",
    )

    return doc


async def _backfill_chunks() -> None:
    """Chunk PDFs that predate the FTS index (see lifespan)."""
    try:
        pending = await get_unindexed_pdf_docs()
    except Exception:
        logger.exception("Chunk backfill: could not list unindexed PDFs")
        return
    if not pending:
        return
    logger.info("Chunk backfill: %d PDF(s) need indexing", len(pending))
    for row in pending:
        path = row.get("file_path")
        if not path or not os.path.exists(path):
            continue
        try:
            chunks = await asyncio.to_thread(chunk_pdf, path)
            await store_chunks(row["id"], chunks)
            logger.info("Chunk backfill: indexed %d chunks for %s", len(chunks), row["id"])
        except Exception:
            logger.exception("Chunk backfill failed for %s", row["id"])


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

    assets_dir = settings.workspace_assets_dir(ws_id)
    if not assets_dir.exists():
        return {"assets": []}

    assets = [
        {"path": filepath.relative_to(assets_dir).as_posix()}
        for filepath in assets_dir.rglob("*")
        if filepath.is_file()
    ]
    return {"assets": assets}

@app.post("/api/workspaces/{ws_id}/assets")
async def upload_workspace_assets(ws_id: str, files: List[UploadFile] = File(...), path: str = Form("figures")):
    ws = await get_workspace(ws_id)
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")

    # Prevent directory traversal (incl. absolute paths: on Windows
    # `base / "C:/evil"` discards base and writes to C:/evil, and the
    # pre-existing ".." substring check misses that entirely).
    raw_path = (path or "").strip()
    if raw_path.startswith(("/", "\\")):
        raise HTTPException(status_code=400, detail="Invalid path")
    clean_path = raw_path.strip("/")
    if (
        ".." in Path(clean_path).parts
        or Path(clean_path).is_absolute()
        or PureWindowsPath(clean_path).is_absolute()
    ):
        raise HTTPException(status_code=400, detail="Invalid path")

    assets_root = settings.workspace_assets_dir(ws_id)
    target_dir = assets_root / clean_path
    if not target_dir.resolve().is_relative_to(assets_root.resolve()):
        raise HTTPException(status_code=400, detail="Invalid path")
    target_dir.mkdir(parents=True, exist_ok=True)

    uploaded = []
    for file in files:
        if not file.filename:
            continue
        # Sanitize filename: strip directories, block traversal / absolute
        # paths (was: file_target_dir / file.filename allowed "../evil").
        safe_name = Path(file.filename).name.strip()
        if not safe_name or safe_name in (".", ".."):
            raise HTTPException(status_code=400, detail="Invalid filename")
        if "/" in safe_name or "\\" in safe_name:
            raise HTTPException(status_code=400, detail="Invalid filename")

        file_target_dir = (
            assets_root
            if safe_name.lower().endswith((".sty", ".cls", ".bst"))
            else target_dir
        )
        file_target_dir.mkdir(parents=True, exist_ok=True)
        save_path = file_target_dir / safe_name

        await _stream_upload_to_path(file, save_path, settings.max_upload_bytes)

        rel_path = save_path.relative_to(assets_root).as_posix()
        uploaded.append({"path": rel_path, "filename": safe_name})

    return {"status": "success", "uploaded": uploaded}


@app.get("/api/workspaces/{ws_id}/bibtex")
async def get_bibtex(ws_id: str):
    ws = await get_workspace(ws_id)
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")
    bib_path = settings.workspace_assets_dir(ws_id) / "references.bib"
    if bib_path.exists():
        return {"content": bib_path.read_text(encoding="utf-8", errors="replace")}
    return {"content": ""}


@app.put("/api/workspaces/{ws_id}/bibtex")
async def save_bibtex(ws_id: str, data: BibtexUpdate):
    ws = await get_workspace(ws_id)
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")
    assets_dir = settings.workspace_assets_dir(ws_id)
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
    synctex_path = await asyncio.to_thread(
        get_build_artifact, doc_id, ".synctex.gz", source_content
    )
    if not synctex_path:
        raise HTTPException(status_code=404, detail="SyncTeX not found")

    return FileResponse(
        path=str(synctex_path),
        media_type="text/plain",
        filename=f"{doc_id}.synctex",
        headers={"Content-Encoding": "gzip", "Cache-Control": "no-store"},
    )


@app.get("/api/documents/{doc_id}/file")
async def get_doc_file(doc_id: str):
    doc = await get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    if doc.get("doc_type") == "latex":
        note = await get_note(doc_id)
        source_content = note.get("content", "")
        pdf_path = await asyncio.to_thread(
            get_build_artifact, doc_id, ".pdf", source_content
        )
        if not pdf_path:
            await run_compile(doc_id, source_content, workspace_id=doc["workspace_id"])
            pdf_path = await asyncio.to_thread(
                get_build_artifact, doc_id, ".pdf", source_content
            )
            if not pdf_path:
                # No successful build exists yet (e.g. brand-new doc with
                # invalid default content). 404 keeps the viewer in its
                # loading/empty state instead of a 500 crash loop; the
                # real diagnostics come via POST /compile.
                raise HTTPException(status_code=404, detail="PDF not compiled yet")
        return FileResponse(
            path=str(pdf_path),
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


@app.get("/api/documents/{doc_id}/note", response_model=NoteResponse)
async def read_doc_note(doc_id: str):
    doc = await get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    return await get_note(doc_id)


@app.put("/api/documents/{doc_id}/note", response_model=NoteResponse)
async def save_doc_note(doc_id: str, data: NoteBase):
    doc = await get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    return await save_note(doc_id, data.content)


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
    return await get_chat_messages(chat_id, limit=limit)


@app.post("/api/chats/{chat_id}/messages", response_model=ChatSendResponse)
async def send_chat_message(chat_id: str, request: ChatSendRequest):
    chat = await get_chat(chat_id)
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")

    chat_limiter.check(chat_id)

    # Resolve context docs (skip missing — chats outlive documents).
    # Explicit document_ids first (deduped, capped at CHAT_MAX_DOCS); then
    # attached workspaces fill the remainder with their PDF/LaTeX docs up to
    # CHAT_MAX_DOCS total.
    context_docs = []
    seen_doc_ids: set = set()
    for doc_id in (request.document_ids or [])[:CHAT_MAX_DOCS]:
        if doc_id in seen_doc_ids:
            continue
        doc = await get_document(doc_id)
        if doc:
            seen_doc_ids.add(doc["id"])
            context_docs.append(doc)
    for ws_id in (request.workspace_ids or [])[:CHAT_MAX_WORKSPACES]:
        if len(context_docs) >= CHAT_MAX_DOCS:
            break
        try:
            ws_docs = await get_workspace_documents(ws_id)
        except Exception as ws_err:
            logger.warning("Workspace context resolve failed for %s: %s", ws_id, ws_err)
            continue
        for ws_doc in ws_docs:
            if len(context_docs) >= CHAT_MAX_DOCS:
                break
            if ws_doc["id"] in seen_doc_ids:
                continue
            seen_doc_ids.add(ws_doc["id"])
            context_docs.append(ws_doc)
    primary_doc_id = context_docs[0]["id"] if context_docs else chat.get("document_id")
    # Page citations ([p. N]) are only meaningful with PDF context. Rows with
    # a missing doc_type are legacy PDFs, so they count as PDF context.
    has_pdf_context = any(
        (d.get("doc_type") or "pdf") != "latex" for d in context_docs
    )

    await add_chat_message(chat_id, primary_doc_id, role="user", content=request.message)

    db_settings = await get_all_settings()
    ai_cfg = resolve_ai_config(
        db_settings,
        model_override=request.model,
        api_key_override=request.api_key,
    )

    if not ai_cfg.api_key:
        fallback_msg = (
            "**Gemini API Key Required**\n\n"
            "Please configure your Gemini API Key in **Settings** (click your profile or the gear icon in the top right) to enable AI research assistance.\n\n"
            "You can get a free key from [Google AI Studio](https://aistudio.google.com/app/apikey)."
        )
        saved_msg = await add_chat_message(chat_id, primary_doc_id, role="assistant", content=fallback_msg)
        return {"message": saved_msg}

    persona_prefix = f"You are assisting {ai_cfg.user_name}"
    if ai_cfg.affiliation:
        persona_prefix += f" ({ai_cfg.affiliation})"

    if ai_cfg.persona == "academic":
        persona_style = (
            "Provide rigorous, academically sound explanations with accurate citations. "
            "Use LaTeX ONLY for mathematical equations or variables. "
            "Do NOT wrap regular text, percentages, or plain numbers in math mode ($...$). "
            "Use standard Markdown for formatting (e.g., **bold**, *italics*)."
        )
    elif ai_cfg.persona == "concise":
        persona_style = "Be direct, concise, and prioritize high-density key points or summaries."
    elif ai_cfg.persona == "pedagogical":
        persona_style = "Explain concepts clearly step-by-step with intuitive examples and derivations."
    else:
        persona_style = ""

    formatted_context = []
    if context_docs:
        # Even split of the char budget across every context doc.
        per_doc = max(1, settings.chat_context_chars // len(context_docs))
        # LaTeX docs: the source IS the context. Label them by file name (which
        # carries the .tex extension) so the model can talk about "main.tex".
        for doc in context_docs:
            if doc.get("doc_type") == "latex":
                note = await get_note(doc["id"])
                text = (note.get("content", "") or "")[:per_doc]
                label = doc.get("name") or doc.get("note_title") or "document.tex"
                formatted_context.append(f"[LaTeX source: {label}]: {text}")
        pdf_docs = [d for d in context_docs if d.get("doc_type") != "latex"]
        if pdf_docs:
            pdf_ids = [d["id"] for d in pdf_docs]
            try:
                chunk_hits = await search_chunks(pdf_ids, request.message, limit=8)
            except Exception as search_err:
                logger.warning("Chunk search failed, using extracted_text fallback: %s", search_err)
                chunk_hits = []
            if chunk_hits:
                per_hit = max(1, settings.chat_context_chars // len(chunk_hits))
                labels = {d["id"]: (d.get("note_title") or d.get("name") or "Document") for d in pdf_docs}
                for hit in chunk_hits:
                    section = hit.get("section") or ""
                    head = f"[p. {hit.get('page', '?')} | {labels.get(hit.get('document_id'), 'Document')}"
                    if section:
                        head += f" | {section}"
                    head += "]"
                    formatted_context.append(f"{head}: {(hit.get('text_content') or '')[:per_hit]}")
            else:
                for doc in pdf_docs:
                    fallback = (doc.get("extracted_text") or "")[:per_doc]
                    if fallback.strip():
                        label = doc.get("note_title") or doc.get("name") or "Document"
                        formatted_context.append(f"[p. ? | {label}]: {fallback}")

    # Bounded history: most recent N of THIS chat, chronological.
    history = await get_chat_messages(chat_id, limit=settings.chat_history_limit)
    formatted_history = [f"{m['role'].capitalize()}: {m['content']}" for m in history]

    dspy_lm = get_dspy_lm(config=ai_cfg)
    msg_text = request.message.strip()

    # `/fix` must never leak its command prefix into the compiler error log.
    command = ""
    if msg_text.startswith("/latex") or msg_text.startswith("/fix"):
        command, _, remainder = msg_text.partition(" ")
        instruction = remainder.strip()
    else:
        instruction = msg_text

    def _generate():
        # One thread owns the DSPy context: no nested thread hops inside.
        with dspy.context(lm=dspy_lm):
            if command == "/latex":
                latex_result = SafeLatexModule()(
                    context=list(formatted_context),
                    instruction=instruction,
                )
                latex_code = sanitize_output(strip_page_citations(latex_result.latex_code or ""))
                return {
                    "answer": f"Here is the generated LaTeX:\n\n```latex\n{latex_code}\n```",
                    "cited_pages": [],
                    "code_patch": latex_code,
                    "action_type": "latex_patch",
                }
            if command == "/fix":
                fix_result = FixTectonicModule()(
                    error_log=instruction,
                    latex_context="\n".join(formatted_context),
                )
                fixed_code = sanitize_output(strip_page_citations(fix_result.corrected_code or ""))
                fix_expl = fix_result.explanation or ""
                if not has_pdf_context:
                    fix_expl = strip_page_citations(fix_expl)
                return {
                    "answer": f"{fix_expl}\n\n```latex\n{fixed_code}\n```",
                    "cited_pages": [],
                    "code_patch": fixed_code,
                    "action_type": "latex_patch",
                }
            # Retrieval already ran in this request; passes context directly.
            qa_result = GroundedPaperQAModule()(
                system=f"{persona_prefix}. {persona_style}".strip(". "),
                context=list(formatted_context),
                chat_history=formatted_history,
                question=msg_text,
            )
            answer_text = (getattr(qa_result, "answer", "") or "").strip()
            if not has_pdf_context:
                answer_text = strip_page_citations(answer_text)
                cited_pages: list[int] = []
            else:
                cited_pages = dedupe_pages(getattr(qa_result, "cited_pages", None) or [])
                if not cited_pages:
                    cited_pages = extract_page_citations(answer_text)
            return {
                "answer": answer_text,
                "cited_pages": cited_pages,
                "code_patch": None,
                "action_type": None,
            }

    try:
        generated = await asyncio.wait_for(
            asyncio.to_thread(_generate), timeout=settings.chat_timeout_s
        )
    except asyncio.TimeoutError:
        generated = {
            "answer": "Sorry, the model took too long to respond. Please try again.",
            "cited_pages": [],
            "code_patch": None,
            "action_type": None,
        }
    except Exception as e:
        logger.warning("Gemini API error on chat %s: %s", chat_id, e)
        generated = {
            "answer": f"Sorry, I encountered an error communicating with Gemini API: {e}",
            "cited_pages": [],
            "code_patch": None,
            "action_type": None,
        }

    model_reply = sanitize_output((generated.get("answer") or "").strip())
    if not model_reply:
        model_reply = "Sorry, I received an empty response from the model."

    cited_pages = dedupe_pages(generated.get("cited_pages") or [])
    # `cited_pages` is persisted on the row; `code_patch`/`action_type` stay
    # response-only (transient — the UI acts on them once, then they're gone).
    saved_msg = await add_chat_message(
        chat_id,
        primary_doc_id,
        role="assistant",
        content=model_reply,
        cited_pages=cited_pages,
    )
    if generated.get("code_patch"):
        saved_msg["code_patch"] = generated["code_patch"]
    if generated.get("action_type"):
        saved_msg["action_type"] = generated["action_type"]

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
    chat_limiter.drop(chat_id)
    return {"success": True, "id": chat_id}


def mask_key(k: str) -> str:
    if not k:
        return ""
    if len(k) <= 8:
        return "••••" + k[-2:]
    return k[:4] + "••••••••" + k[-4:]


def _parse_int(value: str | None, default: int) -> int:
    try:
        return int(value) if value is not None else default
    except (TypeError, ValueError):
        return default


def _parse_bool(value: str | None, default: bool) -> bool:
    return default if value is None else value.lower() in ("true", "1", "yes")


@app.get("/api/settings", response_model=SettingsResponse)
async def get_app_settings():
    db_settings = await get_all_settings()
    ai_cfg = resolve_ai_config(db_settings)

    return SettingsResponse(
        user_name=ai_cfg.user_name,
        user_affiliation=ai_cfg.affiliation,
        gemini_model=ai_cfg.model,
        gemini_api_key_set=bool(ai_cfg.api_key),
        gemini_api_key_masked=mask_key(ai_cfg.api_key),
        ai_temperature=ai_cfg.temperature,
        ai_persona=ai_cfg.persona,
        auto_compile_delay=_parse_int(db_settings.get("auto_compile_delay"), DEFAULT_AUTO_COMPILE_DELAY),
        editor_font_size=_parse_int(db_settings.get("editor_font_size"), DEFAULT_EDITOR_FONT_SIZE),
        editor_word_wrap=_parse_bool(db_settings.get("editor_word_wrap"), DEFAULT_EDITOR_WORD_WRAP),
        editor_line_numbers=_parse_bool(db_settings.get("editor_line_numbers"), DEFAULT_EDITOR_LINE_NUMBERS),
    )


@app.put("/api/settings", response_model=SettingsResponse)
async def update_app_settings(update: SettingsUpdate):
    to_save = {}
    for field_name in ("user_name", "user_affiliation", "gemini_model", "gemini_api_key"):
        val = getattr(update, field_name)
        if val is not None:
            to_save[field_name] = val.strip()
    for field_name in ("ai_temperature", "ai_persona", "auto_compile_delay", "editor_font_size"):
        val = getattr(update, field_name)
        if val is not None:
            to_save[field_name] = val
    for field_name in ("editor_word_wrap", "editor_line_numbers"):
        val = getattr(update, field_name)
        if val is not None:
            to_save[field_name] = str(val).lower()

    if to_save:
        await set_settings(to_save)

    return await get_app_settings()


@app.post("/api/settings/test-key")
async def test_api_key(payload: Optional[TestKeyPayload] = None):
    try:
        db_settings = await get_all_settings()
    except Exception as e:
        logger.warning("Failed to read settings: %s", e)
        db_settings = {}
    ai_cfg = resolve_ai_config(
        db_settings,
        api_key_override=payload.api_key if payload else None,
    )
    key = ai_cfg.api_key

    if not key:
        return {"valid": False, "error": "No API key provided or configured"}

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                "https://generativelanguage.googleapis.com/v1beta/models",
                params={"key": key, "pageSize": "1"},
            )
            if resp.status_code == 200:
                return {"valid": True, "message": "API key verified successfully!"}
            err_data = resp.json().get("error", {}) if resp.headers.get("content-type", "").startswith("application/json") else {}
            err_str = err_data.get("message", f"Verification failed (status {resp.status_code})")
            if "API key not valid" in err_str or "API_KEY_INVALID" in err_str or resp.status_code == 400:
                err_str = "API key is invalid. Please verify your key from Google AI Studio."
            return {"valid": False, "error": err_str}
    except Exception as e:
        logger.warning("API key verification failed: %s", e)
        return {"valid": False, "error": str(e)}



# Production frontend serving. Paths come from config.settings so exe
# bundles can relocate dist/ via RSRCH_DIST_DIR. Python's mimetypes on
# Windows doesn't know .wasm, which breaks WebAssembly.instantiateStreaming.
mimetypes.add_type("application/wasm", ".wasm")

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
        if full.is_relative_to(settings.dist_dir.resolve()) and full.is_file():
            return FileResponse(str(full))
        return FileResponse(str(settings.frontend_index))


def start():
    import uvicorn
    uvicorn.run("server:app", host="127.0.0.1", port=8000, reload=False)


if __name__ == "__main__":
    start()
