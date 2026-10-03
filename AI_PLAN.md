# Rsrch — AI Research Co-Pilot Implementation Plan

> **Vision:** Transform Rsrch's AI Chat into a high-precision **Academic Research & LaTeX Co-Author** powered by **DSPy orchestration**, **SQLite FTS5 BM25 retrieval**, and **real-time SSE streaming** — all local-first, zero external services beyond the Gemini API.

---

## 1. System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          RSRCH AI ARCHITECTURE                             │
│                                                                            │
│  [ React 19 Frontend ]                                                     │
│  ├── ChatPanel.tsx         → SSE stream receiver, citation [p.X] badges    │
│  ├── DocViewer.tsx         → "Fix with AI" button on compiler errors       │
│  └── CodeMirrorLatexEditor → Insert / Replace / Copy code actions          │
│                                                                            │
│                              ▲                                             │
│                              │  SSE (status → token → meta → done)         │
│                              ▼                                             │
│                                                                            │
│  [ FastAPI Backend ]                                                       │
│  ├── POST /api/chats/{id}/stream   (new SSE endpoint)                      │
│  ├── POST /api/chats/{id}/messages (existing, kept for non-stream)         │
│  └── backend/ai/                   (new DSPy module directory)             │
│      ├── config.py          → dspy.LM wrapping Gemini via genai SDK        │
│      ├── retriever.py       → FTS5RetrieverModule (BM25 keyword search)    │
│      ├── signatures.py      → GroundedPaperQA, SafeLatexGenerator, etc.    │
│      └── modules/           → CoT programs, assertions, validators         │
│                                                                            │
│                              ▲                                             │
│                              │  FTS5 BM25 Ranked Queries                   │
│                              ▼                                             │
│                                                                            │
│  [ SQLite: backend/data/rsrch.db ]                                         │
│  ├── documents              → existing (+ extracted_text already stored)   │
│  ├── document_chunks        → NEW: page-aware text chunks                  │
│  └── document_chunks_fts    → NEW: FTS5 virtual table for BM25 search     │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Key design decisions:**
- **FTS5 BM25 only** — no dense vector embeddings, no `sqlite-vec`. BM25 excels at academic search (exact terms, math symbols, theorem names, citation keys). Zero binary dependencies beyond what's already installed.
- **DSPy for orchestration** — declarative signatures enable CoT, ReAct, and future multi-hop reasoning without rewriting prompt plumbing. The framework's assertion system gives self-healing LaTeX generation.
- **SSE streaming first** — the existing synchronous `_generate()` blocks for up to 90s with only a "Thinking..." spinner. Streaming is the single highest-impact UX improvement.

---

## 2. Technology Stack

| Layer | Technology | Rationale |
|---|---|---|
| **LLM Orchestration** | **DSPy** | Declarative signatures, CoT/ReAct programs, `dspy.Assert` for self-healing. Extensible to multi-hop and prompt optimization. |
| **LLM Provider** | **Gemini (google-genai SDK)** | Already integrated. DSPy's `dspy.LM` wraps it. |
| **Retrieval** | **SQLite FTS5 (BM25)** | Built into SQLite — zero dependencies. Fast exact-match on math variables (`$\alpha$`), acronyms, theorem names, citation keys. |
| **PDF Extraction** | **PyMuPDF (`pymupdf`)** | Already used in `_extract_pdf()`. Upgrade to per-page chunking with section detection. |
| **Streaming** | **FastAPI `StreamingResponse`** | SSE with `text/event-stream`. <300ms time-to-first-token. |
| **Frontend** | **React 19 + KaTeX + remark-math** | Already in place. Add SSE receiver and citation badge component. |

### New Dependencies

| Package | Purpose | Size |
|---|---|---|
| `dspy` | LLM orchestration framework | ~15 MB |

> That's it. FTS5 is built into SQLite. Everything else is already installed.

---

## 3. Data Layer — Chunking & FTS5 Index

### 3.1 Schema Additions (in `backend/database.py` → `init_db()`)

```sql
-- Page-aware document chunks
CREATE TABLE IF NOT EXISTS document_chunks (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    page_number INTEGER NOT NULL,
    section_title TEXT DEFAULT '',
    content TEXT NOT NULL,
    char_count INTEGER NOT NULL,
    created_at REAL NOT NULL,
    FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chunks_doc
    ON document_chunks(document_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_chunks_page
    ON document_chunks(document_id, page_number);

-- FTS5 for BM25 keyword search (standalone table, NOT external-content mode)
-- Standalone avoids the trigger-sync fragility of content= tables.
CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks_fts USING fts5(
    chunk_id,         -- stored for join-back
    content,
    section_title,
    tokenize='porter unicode61'
);
```

**Why standalone FTS5 (not `content=`):** External-content FTS5 requires manual triggers for INSERT/DELETE sync. If any code path uses `INSERT OR REPLACE`, bulk `DELETE`, or a migration, FTS5 silently goes stale with no error. Standalone mode stores its own copy (~2x storage) but is bulletproof. For academic papers (avg ~50KB text), the storage cost is negligible.

### 3.2 Chunking Strategy (new: `backend/chunker.py`)

```python
import pymupdf
from dataclasses import dataclass

@dataclass
class Chunk:
    page_number: int
    section_title: str
    content: str
    char_count: int

def chunk_pdf(pdf_path: str, max_chars: int = 2000, overlap_chars: int = 400) -> list[Chunk]:
    """Page-first chunking: split at page boundaries, then subdivide large pages.
    
    Why page-first (not sliding window):
    - Preserves page_number naturally — no cross-page tracking needed.
    - Academic papers are already structured by page; section breaks
      almost always coincide with page transitions.
    - Overlap between pages captures sentences that span the break.
    """
    chunks = []
    with pymupdf.open(pdf_path) as doc:
        for page_num in range(doc.page_count):
            page = doc.load_page(page_num)
            text = page.get_text().strip()
            if not text:
                continue

            # Detect section title from first bold/large text on page
            section = _detect_section_title(page)

            # If page text fits in one chunk, emit it whole
            if len(text) <= max_chars:
                chunks.append(Chunk(
                    page_number=page_num + 1,
                    section_title=section,
                    content=text,
                    char_count=len(text),
                ))
            else:
                # Split large pages at paragraph boundaries
                for sub in _split_at_paragraphs(text, max_chars, overlap_chars):
                    chunks.append(Chunk(
                        page_number=page_num + 1,
                        section_title=section,
                        content=sub,
                        char_count=len(sub),
                    ))
    return chunks

def _detect_section_title(page) -> str:
    """Extract likely section heading from page's first text block."""
    blocks = page.get_text("dict")["blocks"]
    for block in blocks[:3]:
        if "lines" not in block:
            continue
        for line in block["lines"]:
            for span in line["spans"]:
                if span["flags"] & 2**4 or span["size"] > 12:  # bold flag
                    text = span["text"].strip()
                    if 3 < len(text) < 80:
                        return text
    return ""

def _split_at_paragraphs(text: str, max_chars: int, overlap: int) -> list[str]:
    """Split text at double-newlines, respecting max_chars with overlap."""
    paragraphs = text.split("\n\n")
    chunks = []
    current = ""
    for para in paragraphs:
        if len(current) + len(para) + 2 > max_chars and current:
            chunks.append(current.strip())
            current = current[-overlap:] + "\n\n" + para
        else:
            current = (current + "\n\n" + para) if current else para
    if current.strip():
        chunks.append(current.strip())
    return chunks
```

### 3.3 Ingestion Pipeline

**Trigger:** Background task after PDF upload (non-blocking to the upload response).

**Integration point:** After `_extract_pdf()` in `server.py:273`, spawn a background task:

```python
# In upload_document(), after create_document():
asyncio.create_task(_index_document_chunks(doc_id, saved_path))
```

```python
async def _index_document_chunks(doc_id: str, pdf_path: str) -> None:
    """Background: chunk PDF and populate FTS5 index."""
    try:
        chunks = await asyncio.to_thread(chunk_pdf, pdf_path)
        await store_chunks(doc_id, chunks)
    except Exception as e:
        logger.warning("Chunk indexing failed for %s: %s", doc_id, e)
```

**Cleanup:** When a document is deleted, `ON DELETE CASCADE` handles `document_chunks`. The standalone FTS5 table needs an explicit DELETE:

```python
async def delete_document_chunks(doc_id: str) -> None:
    async with get_db() as db:
        cursor = await db.execute(
            "SELECT id FROM document_chunks WHERE document_id = ?", (doc_id,)
        )
        chunk_ids = [r["id"] for r in await cursor.fetchall()]
        if chunk_ids:
            placeholders = ",".join("?" for _ in chunk_ids)
            await db.execute(
                f"DELETE FROM document_chunks_fts WHERE chunk_id IN ({placeholders})",
                chunk_ids,
            )
        await db.commit()
```

### 3.4 BM25 Retrieval Function (in `backend/database.py`)

```python
async def search_chunks(
    document_ids: list[str],
    query: str,
    top_k: int = 8,
) -> list[dict]:
    """FTS5 BM25 search scoped to specific documents."""
    async with get_db() as db:
        placeholders = ",".join("?" for _ in document_ids)
        cursor = await db.execute(f"""
            SELECT
                dc.id, dc.document_id, dc.page_number,
                dc.section_title, dc.content, dc.char_count,
                fts.rank AS bm25_score
            FROM document_chunks_fts fts
            JOIN document_chunks dc ON dc.id = fts.chunk_id
            WHERE fts.document_chunks_fts MATCH ?
              AND dc.document_id IN ({placeholders})
            ORDER BY fts.rank
            LIMIT ?
        """, [query, *document_ids, top_k])
        return [dict(r) for r in await cursor.fetchall()]
```

---

## 4. DSPy Framework (`backend/ai/`)

### 4.1 Directory Structure

```
backend/ai/
├── __init__.py           # Exports: run_qa, run_latex_gen, run_fix_error
├── config.py             # dspy.LM initialization with Gemini
├── retriever.py          # FTS5RetrieverModule (wraps search_chunks)
├── signatures.py         # Typed I/O signatures
├── validators.py         # LaTeX bracket balance, env matching
└── modules/
    ├── paper_qa.py       # GroundedPaperQA (CoT + page citations)
    ├── latex_copilot.py  # SafeLatexGenerator (Assert for syntax)
    └── diagnostics.py    # FixTectonicError (compiler doctor)
```

### 4.2 DSPy-Gemini Bridge (`backend/ai/config.py`)

```python
import dspy
from database import get_all_settings
import os

async def get_dspy_lm(model_override: str | None = None) -> dspy.LM:
    """Create a configured DSPy LM using the user's Gemini settings."""
    db_settings = await get_all_settings()
    db_key = db_settings.get("gemini_api_key", "").strip()
    env_key = os.environ.get("GEMINI_API_KEY", "").strip()
    api_key = db_key or env_key

    model = model_override or db_settings.get("gemini_model") or "gemini-2.5-flash"

    try:
        temperature = float(db_settings.get("ai_temperature", 0.7))
    except (ValueError, TypeError):
        temperature = 0.7

    return dspy.LM(
        model=f"google/genai/{model}",
        api_key=api_key,
        temperature=temperature,
    )
```

### 4.3 Signatures

#### Grounded Paper Q&A
```python
class GroundedPaperQA(dspy.Signature):
    """Answer the user's research question using ONLY the provided paper excerpts.
    Ground every claim with [p. X] page references. If the answer cannot be
    determined from the excerpts, say so explicitly."""

    context: list[str] = dspy.InputField(
        desc="Paper excerpts formatted as '[Page X | Section Y]: content'"
    )
    chat_history: list[str] = dspy.InputField(
        desc="Recent conversation messages for continuity"
    )
    question: str = dspy.InputField(desc="User's research question")

    reasoning: str = dspy.OutputField(
        desc="Step-by-step analysis of the evidence before answering"
    )
    answer: str = dspy.OutputField(
        desc="Academic answer in Markdown with [p. X] citations and LaTeX math"
    )
    cited_pages: list[int] = dspy.OutputField(
        desc="Unique page numbers referenced in the answer"
    )
```

#### Safe LaTeX Generator
```python
class SafeLatexGenerator(dspy.Signature):
    """Generate compilable LaTeX code that integrates with the user's
    existing document. Output ONLY the LaTeX snippet, no wrapping document class."""

    instruction: str = dspy.InputField(desc="What to generate or modify")
    context_code: str = dspy.InputField(desc="Surrounding LaTeX from the editor")
    bib_keys: list[str] = dspy.InputField(
        desc="Available citation keys from references.bib"
    )

    latex_code: str = dspy.OutputField(desc="Compilable LaTeX snippet")
    explanation: str = dspy.OutputField(desc="Brief explanation of the markup")
```

#### Tectonic Error Fixer
```python
class FixTectonicError(dspy.Signature):
    """Diagnose a LaTeX compilation error and produce a corrected code patch."""

    error_message: str = dspy.InputField(desc="Compiler diagnostic message")
    error_line: int = dspy.InputField(desc="Line number of the error")
    source_context: str = dspy.InputField(
        desc="±10 lines around the error in the .tex source"
    )

    diagnosis: str = dspy.OutputField(desc="Root cause explanation")
    fixed_code: str = dspy.OutputField(desc="Corrected LaTeX replacement lines")
```

### 4.4 Modules with Assertions

```python
# backend/ai/modules/paper_qa.py
import dspy
from ai.signatures import GroundedPaperQA

class GroundedPaperQAModule(dspy.Module):
    def __init__(self):
        self.cot = dspy.ChainOfThought(GroundedPaperQA)

    def forward(self, context, chat_history, question):
        result = self.cot(
            context=context,
            chat_history=chat_history,
            question=question,
        )
        dspy.Assert(
            len(result.cited_pages) > 0 or len(context) == 0,
            "Answer uses document context but cites no pages. "
            "Add [p. X] references for each claim."
        )
        return result
```

```python
# backend/ai/modules/latex_copilot.py
import dspy
from ai.signatures import SafeLatexGenerator
from ai.validators import has_balanced_environments

class SafeLatexModule(dspy.Module):
    def __init__(self):
        self.generate = dspy.Predict(SafeLatexGenerator)

    def forward(self, instruction, context_code, bib_keys):
        result = self.generate(
            instruction=instruction,
            context_code=context_code,
            bib_keys=bib_keys,
        )
        dspy.Assert(
            has_balanced_environments(result.latex_code),
            "Generated LaTeX has unmatched \\begin/\\end tags or "
            "unclosed braces. Please correct and rebalance."
        )
        return result
```

### 4.5 Validators (`backend/ai/validators.py`)

```python
import re

def has_balanced_environments(latex: str) -> bool:
    """Check that every \\begin{X} has a matching \\end{X} and braces balance."""
    begins = re.findall(r'\\begin\{(\w+)\}', latex)
    ends = re.findall(r'\\end\{(\w+)\}', latex)
    if sorted(begins) != sorted(ends):
        return False
    depth = 0
    for ch in latex:
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
        if depth < 0:
            return False
    return depth == 0
```

---

## 5. SSE Streaming Protocol

### 5.1 New Endpoint

#### `POST /api/chats/{chat_id}/stream`

**Request Body:**
```json
{
    "message": "Explain the loss formulation in Section 3",
    "document_ids": ["doc_abc123"],
    "model": "gemini-2.5-flash"
}
```

**Response:** `text/event-stream; charset=utf-8`

### 5.2 Event Types

| Event | Payload | Purpose |
|---|---|---|
| `status` | `{"stage": "retrieving", "message": "Searching paper sections..."}` | Pipeline step indicator |
| `token` | `{"t": "The loss"}` | Incremental text token |
| `meta` | `{"cited_pages": [3, 7], "action": {"type": "latex_patch", "code": "..."}}` | Post-generation metadata |
| `done` | `{"message_id": 42, "created_at": 1727450000}` | Stream end + persistence confirmation |
| `error` | `{"error": "Rate limit exceeded"}` | Graceful failure |

### 5.3 Backend Implementation (in `backend/server.py`)

```python
from fastapi.responses import StreamingResponse
import json

@app.post("/api/chats/{chat_id}/stream")
async def stream_chat_message(chat_id: str, request: ChatSendRequest):
    chat = await get_chat(chat_id)
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")

    check_chat_rate_limit(chat_id)

    # Resolve context docs (same logic as existing send_chat_message)
    context_docs = []
    for doc_id in (request.document_ids or [])[:3]:
        doc = await get_document(doc_id)
        if doc:
            context_docs.append(doc)
    primary_doc_id = context_docs[0]["id"] if context_docs else chat.get("document_id")

    # Persist user message immediately
    await add_chat_message(chat_id, primary_doc_id, role="user", content=request.message)

    async def event_stream():
        full_response = ""
        cited_pages = []

        try:
            # 1. Retrieve relevant chunks
            yield _sse("status", {"stage": "retrieving", "message": "Searching document sections..."})

            doc_ids = [d["id"] for d in context_docs]
            chunks = await search_chunks(doc_ids, request.message, top_k=8) if doc_ids else []

            # 2. Format context for the model
            context = [
                f"[Page {c['page_number']} | {c['section_title']}]: {c['content']}"
                for c in chunks
            ]

            yield _sse("status", {"stage": "generating", "message": "Generating response..."})

            # 3. Stream Gemini response
            async for token_text in _stream_gemini_response(
                request, context, chat_id, context_docs
            ):
                full_response += token_text
                yield _sse("token", {"t": token_text})

            # 4. Extract cited pages from response
            cited_pages = _extract_page_citations(full_response)

            # 5. Persist assistant message
            saved = await add_chat_message(
                chat_id, primary_doc_id, role="assistant", content=full_response
            )

            yield _sse("meta", {"cited_pages": cited_pages})
            yield _sse("done", {"message_id": saved["id"], "created_at": saved["created_at"]})

        except Exception as e:
            logger.warning("Stream error for chat %s: %s", chat_id, e)
            if not full_response:
                full_response = f"Sorry, I encountered an error: {e}"
                await add_chat_message(
                    chat_id, primary_doc_id, role="assistant", content=full_response
                )
            yield _sse("error", {"error": str(e)})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def _extract_page_citations(text: str) -> list[int]:
    import re
    return sorted(set(int(m) for m in re.findall(r'\[p\.\s*(\d+)\]', text)))


async def _stream_gemini_response(request, context, chat_id, context_docs):
    """Async generator yielding text tokens from Gemini's streaming API."""
    db_settings = await get_all_settings()
    system_instruction = _build_system_instruction(db_settings, context_docs, context)
    history = await get_chat_messages(chat_id, limit=CHAT_HISTORY_LIMIT)

    effective_key = _resolve_api_key(request, db_settings)
    effective_model = _resolve_model(request, db_settings)

    def _stream_sync():
        client = genai.Client(api_key=effective_key)
        contents = []
        for msg in history:
            role = "model" if msg["role"] == "assistant" else "user"
            contents.append({"role": role, "parts": [{"text": msg["content"]}]})

        response = client.models.generate_content_stream(
            model=effective_model,
            contents=contents,
            config={
                'system_instruction': system_instruction,
                'temperature': float(db_settings.get("ai_temperature", 0.7)),
            },
        )
        for chunk in response:
            if chunk.text:
                yield chunk.text

    # Bridge sync generator → async generator via queue
    import asyncio
    queue = asyncio.Queue()

    async def _producer():
        def _run():
            for token in _stream_sync():
                queue.put_nowait(token)
            queue.put_nowait(None)
        await asyncio.to_thread(_run)

    task = asyncio.create_task(_producer())
    while True:
        token = await asyncio.wait_for(queue.get(), timeout=CHAT_TIMEOUT_S)
        if token is None:
            break
        yield token
    await task
```

### 5.4 Existing Endpoint Preserved

The current `POST /api/chats/{chat_id}/messages` stays as-is for backward compatibility. The frontend migrates to `/stream` but falls back to the JSON endpoint if SSE fails.

---

## 6. Frontend Changes

### 6.1 `src/services/api.ts` — SSE Stream Client

```typescript
async *streamChatMessage(
    chatId: string,
    message: string,
    documentIds: string[] = [],
): AsyncGenerator<{ event: string; data: any }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120_000);

    try {
        const res = await fetch(`${API_BASE}/chats/${enc(chatId)}/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, document_ids: documentIds }),
            signal: ctrl.signal,
        });

        if (!res.ok) throw new Error(`Stream failed (${res.status})`);
        if (!res.body) throw new Error('No response body');

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            let currentEvent = '';
            for (const line of lines) {
                if (line.startsWith('event: ')) {
                    currentEvent = line.slice(7).trim();
                } else if (line.startsWith('data: ') && currentEvent) {
                    try {
                        yield { event: currentEvent, data: JSON.parse(line.slice(6)) };
                    } catch {}
                    currentEvent = '';
                }
            }
        }
    } finally {
        clearTimeout(timer);
    }
}
```

### 6.2 `src/components/ChatPanel.tsx` — Streaming UI

**Replace `handleSend`** (currently at line 271) with streaming version:

```typescript
const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isWaiting) return;

    const text = input.trim().slice(0, 4000);
    setMessages(prev => [...prev, { role: 'user', content: text, created_at: Date.now() / 1000 }]);
    setInput('');
    setIsWaiting(true);
    scrollToBottom();

    try {
        let chatId = activeChatIdRef.current;
        if (!chatId) {
            const created = await api.createChat({ document_id: attachedIds[0] ?? activeDocId });
            chatId = created.id;
            setActiveChatId(chatId);
        }

        // Streaming assistant bubble
        let streamedContent = '';
        const streamMsgId = `stream-${Date.now()}`;
        setMessages(prev => [...prev, {
            role: 'assistant', content: '', created_at: Date.now() / 1000, id: streamMsgId,
        }]);

        for await (const { event, data } of api.streamChatMessage(chatId, text, attachedIds)) {
            if (activeChatIdRef.current !== chatId) break;
            switch (event) {
                case 'status':
                    setStreamStatus(data.message);
                    break;
                case 'token':
                    streamedContent += data.t;
                    setMessages(prev => prev.map(m =>
                        m.id === streamMsgId ? { ...m, content: streamedContent } : m
                    ));
                    scrollToBottom();
                    break;
                case 'meta':
                    if (data.cited_pages?.length) {
                        setMessages(prev => prev.map(m =>
                            m.id === streamMsgId ? { ...m, cited_pages: data.cited_pages } : m
                        ));
                    }
                    break;
                case 'done':
                    setMessages(prev => prev.map(m =>
                        m.id === streamMsgId ? { ...m, id: data.message_id } : m
                    ));
                    break;
                case 'error':
                    streamedContent += `\n\n⚠️ ${data.error}`;
                    setMessages(prev => prev.map(m =>
                        m.id === streamMsgId ? { ...m, content: streamedContent } : m
                    ));
                    break;
            }
        }
        setStreamStatus(null);
    } catch (err) {
        // Fallback to non-streaming
        try {
            const responseMsg = await api.sendChatMessage(activeChatIdRef.current!, text, attachedIds);
            setMessages(prev => [...prev, responseMsg]);
        } catch {
            setMessages(prev => [...prev, {
                role: 'assistant',
                content: 'Send failed — please check your connection and try again.',
                created_at: Date.now() / 1000,
            }]);
        }
    } finally {
        setIsWaiting(false);
        scrollToBottom();
        void refreshChats();
    }
};
```

**Input upgrade** — replace `<input type="text">` (line 416) with auto-expanding `<textarea>`:

```tsx
<textarea
    className="chat-input"
    placeholder={attachedIds.length > 0 ? 'Ask about the attached PDFs...' : 'Ask anything...'}
    value={input}
    onChange={(e) => setInput(e.target.value.slice(0, 4000))}
    onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend(e);
        }
    }}
    rows={1}
    style={{ resize: 'none', maxHeight: 160, overflow: 'auto' }}
    disabled={isWaiting}
/>
```

### 6.3 Citation Badges in `MemoizedMessageList`

```tsx
// Custom ReactMarkdown component for [p. X] patterns:
function transformCitations(children: React.ReactNode): React.ReactNode {
    return React.Children.map(children, child => {
        if (typeof child !== 'string') return child;
        const parts = child.split(/(\[p\.\s*\d+\])/g);
        return parts.map((part, i) => {
            const match = part.match(/\[p\.\s*(\d+)\]/);
            if (match) {
                const page = parseInt(match[1]);
                return (
                    <button key={i} className="citation-badge"
                        onClick={() => window.dispatchEvent(
                            new CustomEvent('rsrch:scroll-to-page', { detail: { page } })
                        )}
                    >
                        p. {page}
                    </button>
                );
            }
            return part;
        });
    });
}
```

### 6.4 `src/types/index.ts` Extension

```typescript
export interface ChatMessage {
    id?: number | string;
    chat_id?: string;
    document_id?: string | null;
    role: 'user' | 'assistant';
    content: string;
    created_at: number;
    cited_pages?: number[];     // NEW
    reasoning?: string;         // NEW
}
```

### 6.5 DocViewer — "Fix with AI" Button

In the compiler diagnostics banner, add next to each error:

```tsx
<button className="pdf-popup-btn"
    onClick={() => {
        window.dispatchEvent(new CustomEvent('rsrch:chat-append', {
            detail: {
                text: `Fix this LaTeX compilation error:\n\`\`\`\n${diag.message}\n\`\`\`\nLine ${diag.line}`,
            },
        }));
    }}
>
    ✨ Fix with AI
</button>
```

---

## 7. Phased Implementation Roadmap

```
 Phase 1 ─── SSE Streaming (no RAG)
   │         Biggest UX win. Can ship in one session.
   │         Replaces 90-second blocking wait with real-time tokens.
   ▼
 Phase 2 ─── Page-Aware Chunking + FTS5 BM25
   │         Zero new deps. Replaces 30k char truncation with
   │         ranked retrieval from the full document.
   ▼
 Phase 3 ─── DSPy Integration + Grounded QA
   │         CoT reasoning, page citations, structured output.
   │         Citation badges wired to DocViewer page scroll.
   ▼
 Phase 4 ─── LaTeX Co-Authoring & Compiler Doctor
             Self-healing LaTeX generation, "Fix with AI" button,
             Insert/Replace/Copy code actions.
```

---

### Phase 1: SSE Streaming (no RAG)

> **Goal:** Replace the synchronous `_generate()` → JSON response with real-time SSE token streaming. No retrieval changes — use the same context-slicing logic that exists today.

**Backend:**
- [ ] Add `POST /api/chats/{chat_id}/stream` endpoint in `server.py`
- [ ] Implement `_stream_gemini_response()` using `generate_content_stream()` (genai SDK already supports this)
- [ ] Implement async queue bridge (sync genai generator → async SSE generator)
- [ ] Wire `_sse()` helper for event formatting
- [ ] Keep existing `POST /api/chats/{id}/messages` as fallback

**Frontend:**
- [ ] Add `streamChatMessage()` async generator to `api.ts`
- [ ] Replace `handleSend` in `ChatPanel.tsx` with streaming version
- [ ] Add `streamStatus` state for pipeline status banner
- [ ] Replace `<input type="text">` with auto-expanding `<textarea>` (Enter=send, Shift+Enter=newline)
- [ ] Add streaming indicator CSS (pulsing dot replaces "Thinking...")
- [ ] Fallback: catch SSE failure → retry via existing JSON endpoint

**Acceptance:**
- [ ] First token visible in <300ms from send
- [ ] Response streams word-by-word in the chat bubble
- [ ] Shift+Enter creates newlines in input
- [ ] Network failure falls back to JSON endpoint gracefully

---

### Phase 2: Page-Aware Chunking + FTS5 BM25

> **Goal:** Replace the 30k-char `extracted_text` truncation with page-aware chunks indexed in FTS5. Queries retrieve the most relevant sections instead of dumping the first N chars.

**Backend:**
- [ ] Create `backend/chunker.py` with `chunk_pdf()`, `_detect_section_title()`, `_split_at_paragraphs()`
- [ ] Add `document_chunks` table + `document_chunks_fts` virtual table to `init_db()` in `database.py`
- [ ] Add `store_chunks()`, `delete_document_chunks()`, `search_chunks()` to `database.py`
- [ ] Add `_index_document_chunks()` background task, called from `upload_document()` in `server.py`
- [ ] Also call chunker for LaTeX documents (chunk the compiled/source text by `\section` boundaries)
- [ ] Update the SSE `/stream` endpoint: replace `extracted_text[:per_doc]` slicing with `search_chunks()` call
- [ ] Add `FTS5 REBUILD` at startup in `lifespan()` for index health
- [ ] Write tests: chunk a sample PDF, verify FTS5 returns ranked results

**Frontend:**
- [ ] Update status event display: show "Searching 3 relevant sections..." during retrieval phase

**Acceptance:**
- [ ] Query about page 20 of a 25-page paper returns the right chunks (not truncated at page 8)
- [ ] FTS5 search for `Transformer` returns exact-match chunks
- [ ] Document deletion cleanly removes chunks + FTS5 entries
- [ ] Upload performance: chunking completes in <2s for a 30-page PDF

---

### Phase 3: DSPy Integration + Grounded QA

> **Goal:** Replace raw prompt concatenation with DSPy's structured programs. Answers cite specific pages; the frontend renders clickable `[p. X]` badges.

**Backend:**
- [ ] Add `dspy` to `pyproject.toml` dependencies
- [ ] Create `backend/ai/config.py` — `get_dspy_lm()` using user's Gemini settings
- [ ] Create `backend/ai/retriever.py` — `FTS5RetrieverModule` wrapping `search_chunks()`
- [ ] Create `backend/ai/signatures.py` — `GroundedPaperQA`, `SafeLatexGenerator`, `FixTectonicError`
- [ ] Create `backend/ai/modules/paper_qa.py` — `GroundedPaperQAModule` with CoT + citation assertion
- [ ] Update SSE `/stream` endpoint: when chunks are available, route through `GroundedPaperQAModule`; without chunks, use direct Gemini streaming (existing behavior)
- [ ] Extract `cited_pages` from DSPy output → include in `meta` SSE event
- [ ] Write tests: verify DSPy module produces page citations, handles empty context

**Frontend:**
- [ ] Add `cited_pages` to `ChatMessage` type in `types/index.ts`
- [ ] Implement `transformCitations()` in `MemoizedMessageList` — render `[p. X]` as clickable badges
- [ ] Wire `rsrch:scroll-to-page` event → DocViewer page navigation
- [ ] Add `.citation-badge` CSS styles in `index.css`
- [ ] Optional: show `reasoning` as a collapsible "Show thinking" section in the chat bubble

**Acceptance:**
- [ ] Answers about specific sections include `[p. X]` citations
- [ ] Clicking `[p. 7]` scrolls the PDF viewer to page 7
- [ ] Questions with no document context still work (fallback to direct Gemini)
- [ ] DSPy assertion fires and retries when citations are missing

---

### Phase 4: LaTeX Co-Authoring & Compiler Doctor

> **Goal:** Self-healing LaTeX generation with `dspy.Assert`, "Fix with AI" integration with compiler diagnostics, and multi-action code toolbar.

**Backend:**
- [ ] Create `backend/ai/validators.py` — `has_balanced_environments()`
- [ ] Create `backend/ai/modules/latex_copilot.py` — `SafeLatexModule` with bracket assertion
- [ ] Create `backend/ai/modules/diagnostics.py` — `FixTectonicErrorModule`
- [ ] Add `/stream` mode detection: if message starts with a LaTeX instruction or error context, route to appropriate DSPy module
- [ ] Extract `action_type` and `code` from DSPy output → include in `meta` SSE event

**Frontend:**
- [ ] Add `✨ Fix with AI` button in DocViewer diagnostic banner (dispatches `rsrch:chat-append`)
- [ ] Upgrade code block toolbar in ChatPanel: **Insert at Caret** + **Replace Selection** + **Copy**
- [ ] Add contextual quick-action chips above input:
  - PDF mode: `📌 Summarize`, `📐 Explain Math`, `🔍 Critique`
  - LaTeX mode: `🔧 Fix Errors`, `✍️ Improve Writing`, `📚 Add Citation`
- [ ] Wire `meta.action.type === 'latex_patch'` → auto-populate "Replace Selection" button

**Acceptance:**
- [ ] Generated LaTeX has 100% balanced `\begin`/`\end` environments
- [ ] Clicking "Fix with AI" on a `missing }` error produces the correct single-line fix
- [ ] "Insert at Caret" injects code at the CodeMirror cursor position
- [ ] Assertion self-healing: deliberately unbalanced output retries and produces valid LaTeX

---

## 8. File Change Summary

| File | Changes |
|---|---|
| `backend/server.py` | Add `POST /stream` endpoint, `_sse()`, `_stream_gemini_response()`, `_index_document_chunks()` |
| `backend/database.py` | Add chunk tables to `init_db()`, add `store_chunks()`, `delete_document_chunks()`, `search_chunks()` |
| `backend/chunker.py` | **New** — `chunk_pdf()`, section detection, paragraph splitting |
| `backend/ai/__init__.py` | **New** — unified runner exports |
| `backend/ai/config.py` | **New** — `get_dspy_lm()` |
| `backend/ai/retriever.py` | **New** — `FTS5RetrieverModule` |
| `backend/ai/signatures.py` | **New** — all DSPy signatures |
| `backend/ai/validators.py` | **New** — LaTeX syntax validators |
| `backend/ai/modules/paper_qa.py` | **New** — `GroundedPaperQAModule` |
| `backend/ai/modules/latex_copilot.py` | **New** — `SafeLatexModule` |
| `backend/ai/modules/diagnostics.py` | **New** — `FixTectonicErrorModule` |
| `src/services/api.ts` | Add `streamChatMessage()` async generator |
| `src/components/ChatPanel.tsx` | Streaming `handleSend`, textarea, citation badges, code toolbar, status banner |
| `src/types/index.ts` | Add `cited_pages`, `reasoning` to `ChatMessage` |
| `src/index.css` | `.citation-badge`, `.stream-status`, `.chat-textarea` styles |
| `pyproject.toml` | Add `dspy` dependency |

---

## 9. Acceptance Criteria (End-to-End)

| # | Criterion | Metric |
|---|---|---|
| 1 | **Streaming latency** | First token visible in <300ms |
| 2 | **Retrieval completeness** | Query about page 20 of a 25-page paper returns correct chunks |
| 3 | **Citation grounding** | Answers include `[p. X]` citations when document context is attached |
| 4 | **Citation navigation** | Clicking `[p. 7]` scrolls PDF to page 7 in <100ms |
| 5 | **LaTeX safety** | Generated LaTeX has 100% balanced environments (assertion-enforced) |
| 6 | **Compiler doctor** | "Fix with AI" on `missing }` produces correct single-line patch |
| 7 | **Fallback resilience** | SSE failure → JSON endpoint fallback works transparently |
| 8 | **BM25 precision** | FTS5 search for `Transformer` returns chunks containing that exact term |
