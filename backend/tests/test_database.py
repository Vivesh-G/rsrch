"""Database tests against an isolated temp DB (real file, production code path)."""

import uuid

import pytest

import database


def _uid(prefix):
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


@pytest.fixture
async def test_db(tmp_path, monkeypatch):
    monkeypatch.setattr(database, "DB_PATH", str(tmp_path / "test.db"))
    await database.init_db()
    return database


async def _make_doc(db, workspace_id=None, **kwargs):
    ws = workspace_id or _uid("ws")
    if workspace_id is None:
        await db.create_workspace(ws, "W")
    doc = _uid("doc")
    params = dict(note_title="T", tag="G", file_path=None, page_count=1,
                  extracted_text="", doc_type="pdf")
    params.update(kwargs)
    await db.create_document(doc, ws, "d.pdf", **params)
    return ws, doc


async def test_workspaces_group_docs(test_db):
    db = test_db
    ws1, ws2, ws_empty = _uid("ws"), _uid("ws"), _uid("ws")
    for ws, name in ((ws1, "W1"), (ws2, "W2"), (ws_empty, "Empty")):
        await db.create_workspace(ws, name)
    await db.create_document(_uid("doc"), ws1, "a.pdf", note_title="A",
                             tag="G", file_path=None, page_count=1,
                             extracted_text="", doc_type="pdf")
    await db.create_document(_uid("doc"), ws1, "b.pdf", note_title="B",
                             tag="G", file_path=None, page_count=1,
                             extracted_text="", doc_type="pdf")
    doc_c = _uid("doc")
    await db.create_document(doc_c, ws2, "c.pdf", note_title="C",
                             tag="G", file_path=None, page_count=1,
                             extracted_text="", doc_type="pdf")

    by_id = {w["id"]: w for w in await db.get_all_workspaces()}
    assert len(by_id[ws1]["docs"]) == 2
    assert [d["id"] for d in by_id[ws2]["docs"]] == [doc_c]
    assert by_id[ws_empty]["docs"] == []
    assert by_id[ws1]["docs"][0]["note_title"] == "A"  # ordering preserved


async def test_get_note_creates_starter_once(test_db):
    db = test_db
    _, doc = await _make_doc(db, note_title="Paper", page_count=3)
    first = await db.get_note(doc)
    assert "Paper" in first["content"]
    assert await db.get_note(doc) == first


async def test_update_document_roundtrip(test_db):
    db = test_db
    _, doc = await _make_doc(db, tag="General")
    updated = await db.update_document(doc, tag="ML", bookmarked=True)
    assert updated["tag"] == "ML"
    assert updated["bookmarked"] is True
    # No-op update still returns the row on the same connection.
    assert (await db.update_document(doc))["tag"] == "ML"
    assert await db.update_document("doc_missing") is None


async def test_chat_history_returns_tail_chronological(test_db):
    db = test_db
    _, doc = await _make_doc(db)
    chat = await db.create_chat(title="t", document_id=doc)
    for i in range(1, 26):
        await db.add_chat_message(chat["id"], doc, role="user", content=f"msg-{i:02d}")

    tail = await db.get_chat_messages(chat["id"], limit=20)
    assert [m["content"] for m in tail] == [f"msg-{i:02d}" for i in range(6, 26)]

    head = await db.get_chat_messages(chat["id"], limit=200)
    assert len(head) == 25
    assert head[0]["content"] == "msg-01"
