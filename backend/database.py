import os
import time
import uuid
from typing import List, Optional, Dict, Any
from contextlib import asynccontextmanager
import aiosqlite

DB_DIR = os.path.join(os.path.dirname(__file__), "data")
DB_PATH = os.path.join(DB_DIR, "rschr.db")
PDF_DIR = os.path.join(DB_DIR, "pdfs")

os.makedirs(DB_DIR, exist_ok=True)
os.makedirs(PDF_DIR, exist_ok=True)

STARTER_NOTE_TEMPLATE = """## Getting started

Welcome! This is your note for this document.

- [ ] Summarize the main ideas
- [ ] Pull out key quotes
- [ ] Link related papers

> Tip: use **bold**, *italic*, `code`, and markdown shortcuts.
> Press Enter to move to the next line — formatting renders automatically."""


@asynccontextmanager
async def get_db():
    async with aiosqlite.connect(DB_PATH, timeout=30) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA foreign_keys = ON;")
        # WAL + busy timeout: the frontend autosaves notes (debounced PUTs)
        # while chat/uploads write concurrently — without this SQLite throws
        # "database is locked" under overlapping writes.
        try:
            await db.execute("PRAGMA journal_mode = WAL;")
            await db.execute("PRAGMA busy_timeout = 30000;")
        except Exception:
            pass
        yield db


async def init_db():
    async with get_db() as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS workspaces (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                expanded INTEGER DEFAULT 1,
                created_at REAL NOT NULL
            );
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS documents (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                name TEXT NOT NULL,
                note_title TEXT,
                tag TEXT DEFAULT 'General',
                bookmarked INTEGER DEFAULT 0,
                added_at REAL NOT NULL,
                file_path TEXT,
                page_count INTEGER DEFAULT 1,
                FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
            );
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS notes (
                document_id TEXT PRIMARY KEY,
                content TEXT DEFAULT '',
                updated_at REAL NOT NULL,
                FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
            );
        """)
        try:
            await db.execute("ALTER TABLE documents ADD COLUMN extracted_text TEXT DEFAULT ''")
        except Exception:
            pass

        await db.execute("""
            CREATE TABLE IF NOT EXISTS chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                document_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at REAL NOT NULL,
                FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
            );
        """)
        # Indexes for the hot paths: workspace doc lists, chat history,
        # and the LIKE search across document fields.
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_documents_workspace ON documents(workspace_id, added_at)"
        )
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_chat_doc ON chat_messages(document_id, created_at)"
        )
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_documents_name ON documents(name)"
        )
        await _ensure_chat_schema(db)
        await db.commit()

        # Seed default workspace if empty
        cursor = await db.execute("SELECT COUNT(*) as count FROM workspaces")
        row = await cursor.fetchone()
        if row and row["count"] == 0:
            default_ws_id = "ws_default"
            await db.execute(
                "INSERT INTO workspaces (id, name, expanded, created_at) VALUES (?, ?, ?, ?)",
                (default_ws_id, "My Workspace", 1, time.time()),
            )
            await db.commit()


# Workspace Operations
async def get_workspace(ws_id: str) -> Optional[Dict[str, Any]]:
    async with get_db() as db:
        cursor = await db.execute("SELECT * FROM workspaces WHERE id = ?", (ws_id,))
        row = await cursor.fetchone()
        if row:
            res = dict(row)
            res["expanded"] = bool(res["expanded"])
            return res
        return None


async def get_all_workspaces() -> List[Dict[str, Any]]:
    async with get_db() as db:
        cursor = await db.execute("SELECT * FROM workspaces ORDER BY created_at ASC")
        workspaces = [dict(row) for row in await cursor.fetchall()]
        for ws in workspaces:
            ws["expanded"] = bool(ws["expanded"])
            doc_cursor = await db.execute(
                "SELECT * FROM documents WHERE workspace_id = ? ORDER BY added_at ASC",
                (ws["id"],),
            )
            docs = []
            for d in await doc_cursor.fetchall():
                doc_dict = dict(d)
                doc_dict["bookmarked"] = bool(doc_dict["bookmarked"])
                doc_dict["has_file"] = bool(doc_dict.get("file_path"))
                docs.append(doc_dict)
            ws["docs"] = docs
        return workspaces


async def create_workspace(ws_id: str, name: str) -> Dict[str, Any]:
    now = time.time()
    async with get_db() as db:
        await db.execute(
            "INSERT INTO workspaces (id, name, expanded, created_at) VALUES (?, ?, ?, ?)",
            (ws_id, name, 1, now),
        )
        await db.commit()
    return {"id": ws_id, "name": name, "expanded": True, "created_at": now, "docs": []}


async def update_workspace(ws_id: str, name: Optional[str] = None, expanded: Optional[bool] = None) -> Optional[Dict[str, Any]]:
    async with get_db() as db:
        updates = []
        params = []
        if name is not None:
            updates.append("name = ?")
            params.append(name)
        if expanded is not None:
            updates.append("expanded = ?")
            params.append(1 if expanded else 0)
        if not updates:
            return None
        params.append(ws_id)
        await db.execute(f"UPDATE workspaces SET {', '.join(updates)} WHERE id = ?", params)
        await db.commit()
        
        cursor = await db.execute("SELECT * FROM workspaces WHERE id = ?", (ws_id,))
        row = await cursor.fetchone()
        if row:
            res = dict(row)
            res["expanded"] = bool(res["expanded"])
            return res
        return None


async def delete_workspace(ws_id: str) -> bool:
    async with get_db() as db:
        cursor = await db.execute("SELECT file_path FROM documents WHERE workspace_id = ?", (ws_id,))
        rows = await cursor.fetchall()
        for r in rows:
            if r["file_path"] and os.path.exists(r["file_path"]):
                try:
                    os.remove(r["file_path"])
                except Exception:
                    pass
        cursor = await db.execute("DELETE FROM workspaces WHERE id = ?", (ws_id,))
        await db.commit()
        return (cursor.rowcount or 0) > 0


# Document Operations
async def create_document(
    doc_id: str,
    workspace_id: str,
    name: str,
    note_title: Optional[str] = None,
    tag: str = "General",
    file_path: Optional[str] = None,
    page_count: int = 1,
    extracted_text: str = "",
) -> Dict[str, Any]:
    now = time.time()
    title = note_title or os.path.splitext(name)[0]
    starter_note = STARTER_NOTE_TEMPLATE.replace("this document", title)

    async with get_db() as db:
        await db.execute(
            """
            INSERT INTO documents (id, workspace_id, name, note_title, tag, bookmarked, added_at, file_path, page_count, extracted_text)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (doc_id, workspace_id, name, title, tag, 0, now, file_path, page_count, extracted_text),
        )
        await db.execute(
            """
            INSERT INTO notes (document_id, content, updated_at)
            VALUES (?, ?, ?)
            """,
            (doc_id, starter_note, now),
        )
        await db.commit()

    return {
        "id": doc_id,
        "workspace_id": workspace_id,
        "name": name,
        "note_title": title,
        "tag": tag,
        "bookmarked": False,
        "added_at": now,
        "has_file": bool(file_path),
        "page_count": page_count,
    }


async def get_document(doc_id: str) -> Optional[Dict[str, Any]]:
    async with get_db() as db:
        cursor = await db.execute("SELECT * FROM documents WHERE id = ?", (doc_id,))
        row = await cursor.fetchone()
        if row:
            doc = dict(row)
            doc["bookmarked"] = bool(doc["bookmarked"])
            doc["has_file"] = bool(doc.get("file_path"))
            return doc
        return None


async def update_document(
    doc_id: str,
    note_title: Optional[str] = None,
    tag: Optional[str] = None,
    bookmarked: Optional[bool] = None,
) -> Optional[Dict[str, Any]]:
    async with get_db() as db:
        updates = []
        params = []
        if note_title is not None:
            updates.append("note_title = ?")
            params.append(note_title)
        if tag is not None:
            updates.append("tag = ?")
            params.append(tag)
        if bookmarked is not None:
            updates.append("bookmarked = ?")
            params.append(1 if bookmarked else 0)
        if not updates:
            return await get_document(doc_id)
        params.append(doc_id)
        await db.execute(f"UPDATE documents SET {', '.join(updates)} WHERE id = ?", params)
        await db.commit()
    return await get_document(doc_id)


async def delete_document(doc_id: str) -> bool:
    async with get_db() as db:
        cursor = await db.execute("SELECT file_path FROM documents WHERE id = ?", (doc_id,))
        row = await cursor.fetchone()
        if row and row["file_path"] and os.path.exists(row["file_path"]):
            try:
                os.remove(row["file_path"])
            except Exception:
                pass
        cursor = await db.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
        await db.commit()
        return (cursor.rowcount or 0) > 0


# Note Operations
async def get_note(doc_id: str) -> Dict[str, Any]:
    async with get_db() as db:
        cursor = await db.execute("SELECT * FROM notes WHERE document_id = ?", (doc_id,))
        row = await cursor.fetchone()
        if row:
            return dict(row)
        doc = await get_document(doc_id)
        title = doc["note_title"] if doc else "document"
        content = STARTER_NOTE_TEMPLATE.replace("this document", title)
        now = time.time()
        await db.execute(
            "INSERT OR REPLACE INTO notes (document_id, content, updated_at) VALUES (?, ?, ?)",
            (doc_id, content, now),
        )
        await db.commit()
        return {"document_id": doc_id, "content": content, "updated_at": now}


async def save_note(doc_id: str, content: str) -> Dict[str, Any]:
    now = time.time()
    async with get_db() as db:
        await db.execute(
            "INSERT OR REPLACE INTO notes (document_id, content, updated_at) VALUES (?, ?, ?)",
            (doc_id, content, now),
        )
        await db.commit()
    return {"document_id": doc_id, "content": content, "updated_at": now}


# Search Operations
async def search_all(query: str) -> List[Dict[str, Any]]:
    q = f"%{query.strip().lower()}%"
    results = []
    async with get_db() as db:
        cursor = await db.execute("""
            SELECT d.id as doc_id, d.name as doc_name, d.note_title, d.tag, d.workspace_id,
                   w.name as ws_name, n.content as note_content
            FROM documents d
            JOIN workspaces w ON d.workspace_id = w.id
            LEFT JOIN notes n ON d.id = n.document_id
            WHERE LOWER(d.name) LIKE ? 
               OR LOWER(d.note_title) LIKE ? 
               OR LOWER(d.tag) LIKE ? 
               OR LOWER(n.content) LIKE ?
        """, (q, q, q, q))
        rows = await cursor.fetchall()
        for r in rows:
            match_type = "name"
            snippet = None
            if query.lower() in (r["note_title"] or "").lower():
                match_type = "title"
            elif query.lower() in (r["tag"] or "").lower():
                match_type = "tag"
            elif r["note_content"] and query.lower() in r["note_content"].lower():
                match_type = "note"
                idx = r["note_content"].lower().find(query.lower())
                start = max(0, idx - 30)
                end = min(len(r["note_content"]), idx + len(query) + 30)
                snippet = "..." + r["note_content"][start:end].replace("\n", " ") + "..."

            results.append({
                "document_id": r["doc_id"],
                "workspace_id": r["workspace_id"],
                "workspace_name": r["ws_name"],
                "document_name": r["doc_name"],
                "note_title": r["note_title"] or r["doc_name"],
                "tag": r["tag"],
                "snippet": snippet,
                "match_type": match_type,
            })
    return results


# Chat Operations — chats are global sessions, independent of documents.
# A chat may record an origin document (where it was started) and each
# message may record the context document used, but chats outlive docs:
# missing documents are skipped, never 404.
async def _ensure_chat_schema(db) -> None:
    cursor = await db.execute("PRAGMA table_info(chat_messages)")
    info = {r["name"]: r for r in await cursor.fetchall()}
    # Legacy schema forces every message onto a real document
    # (document_id NOT NULL + FK). Global chats need doc-less rows, so
    # rebuild the table once: data-preserving copy without those constraints.
    # (No FK on document_id anymore — chats deliberately outlive documents.)
    if "chat_id" not in info or info["document_id"]["notnull"]:
        has_chat_id = "chat_id" in info
        await db.execute("""
            CREATE TABLE chat_messages_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id TEXT,
                document_id TEXT,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at REAL NOT NULL
            );
        """)
        select_chat = "chat_id" if has_chat_id else "NULL AS chat_id"
        await db.execute(f"""
            INSERT INTO chat_messages_new (id, chat_id, document_id, role, content, created_at)
            SELECT id, {select_chat}, document_id, role, content, created_at FROM chat_messages
        """)
        await db.execute("DROP TABLE chat_messages")
        await db.execute("ALTER TABLE chat_messages_new RENAME TO chat_messages")

    await db.execute("""
        CREATE TABLE IF NOT EXISTS chats (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT 'New chat',
            document_id TEXT,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        );
    """)
    await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_chat_messages_chat ON chat_messages(chat_id, created_at)"
    )

    # One-time migration: legacy per-document rows (chat_id NULL) become one
    # chat per document, titled from the document.
    cursor = await db.execute(
        "SELECT DISTINCT document_id FROM chat_messages WHERE chat_id IS NULL"
    )
    legacy_docs = [r["document_id"] for r in await cursor.fetchall()]
    for doc_id in legacy_docs:
        dcur = await db.execute(
            "SELECT note_title, name FROM documents WHERE id = ?", (doc_id,)
        )
        drow = await dcur.fetchone()
        if drow:
            title = drow["note_title"] or os.path.splitext(drow["name"] or "")[0] or "Imported chat"
        else:
            title = "Imported chat"
        chat_id = f"chat_{uuid.uuid4().hex[:10]}"
        now = time.time()
        await db.execute(
            "INSERT INTO chats (id, title, document_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (chat_id, title, doc_id, now, now),
        )
        await db.execute(
            "UPDATE chat_messages SET chat_id = ? WHERE chat_id IS NULL AND document_id = ?",
            (chat_id, doc_id),
        )


async def list_chats() -> List[Dict[str, Any]]:
    async with get_db() as db:
        cursor = await db.execute("""
            SELECT c.id, c.title, c.document_id, c.created_at, c.updated_at,
                   COALESCE(d.note_title, d.name) AS origin_title,
                   (SELECT COUNT(*) FROM chat_messages m WHERE m.chat_id = c.id) AS message_count,
                   (SELECT m2.content FROM chat_messages m2
                     WHERE m2.chat_id = c.id ORDER BY m2.created_at DESC LIMIT 1) AS last_preview
            FROM chats c LEFT JOIN documents d ON d.id = c.document_id
            ORDER BY c.updated_at DESC
        """)
        return [dict(r) for r in await cursor.fetchall()]


async def create_chat(title: Optional[str], document_id: Optional[str]) -> Dict[str, Any]:
    now = time.time()
    chat_id = f"chat_{uuid.uuid4().hex[:10]}"
    clean_title = (title or "").strip() or "New chat"
    async with get_db() as db:
        if document_id:
            cur = await db.execute("SELECT id FROM documents WHERE id = ?", (document_id,))
            if not await cur.fetchone():
                document_id = None
        await db.execute(
            "INSERT INTO chats (id, title, document_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (chat_id, clean_title, document_id, now, now),
        )
        await db.commit()
    return {
        "id": chat_id,
        "title": clean_title,
        "document_id": document_id,
        "origin_title": None,
        "message_count": 0,
        "last_preview": None,
        "created_at": now,
        "updated_at": now,
    }


async def get_chat(chat_id: str) -> Optional[Dict[str, Any]]:
    async with get_db() as db:
        cursor = await db.execute("SELECT * FROM chats WHERE id = ?", (chat_id,))
        row = await cursor.fetchone()
        return dict(row) if row else None


async def update_chat_title(chat_id: str, title: str) -> None:
    async with get_db() as db:
        await db.execute(
            "UPDATE chats SET title = ?, updated_at = ? WHERE id = ?",
            (title, time.time(), chat_id),
        )
        await db.commit()


async def delete_chat(chat_id: str) -> bool:
    async with get_db() as db:
        await db.execute("DELETE FROM chat_messages WHERE chat_id = ?", (chat_id,))
        cursor = await db.execute("DELETE FROM chats WHERE id = ?", (chat_id,))
        await db.commit()
        return (cursor.rowcount or 0) > 0


async def get_chat_messages(chat_id: str, limit: int = 200) -> List[Dict[str, Any]]:
    async with get_db() as db:
        cursor = await db.execute(
            "SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY created_at ASC LIMIT ?",
            (chat_id, limit),
        )
        return [dict(r) for r in await cursor.fetchall()]


async def add_chat_message(
    chat_id: str, document_id: Optional[str], role: str, content: str
) -> Dict[str, Any]:
    now = time.time()
    async with get_db() as db:
        cursor = await db.execute(
            "INSERT INTO chat_messages (chat_id, document_id, role, content, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *",
            (chat_id, document_id, role, content, now),
        )
        row = await cursor.fetchone()
        await db.execute(
            "UPDATE chats SET updated_at = ? WHERE id = ?", (now, chat_id)
        )
        await db.commit()
        return dict(row) if row else {}
