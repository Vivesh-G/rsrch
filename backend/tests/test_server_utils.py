"""Server util, rate-limiter, and PDF chunker tests."""

import uuid

from httpx import ASGITransport, AsyncClient
import pymupdf
import pytest

import chunker
import database
import server
from rate_limiter import ChatRateLimiter, RateLimitExceeded


@pytest.mark.parametrize(
    "data, expected",
    [
        (b"%PDF-1.4 hello", True),
        (b"  \r\n%PDF-1.7", True),  # leading whitespace tolerated
        (b"\xef\xbb\xbf%PDF-1.4", True),  # UTF-8 BOM tolerated
        (b"MZ\x90\x00evil", False),  # renamed executable rejected
        (b"", False),
    ],
)
def test_is_pdf_bytes(data, expected):
    assert server._is_pdf_bytes(data) is expected


def test_rate_limiter_enforces_limit_per_key_and_drop():
    limiter = ChatRateLimiter(limit=3, window_s=60.0)
    for _ in range(3):
        limiter.check("chat_a")
    with pytest.raises(RateLimitExceeded):
        limiter.check("chat_a")

    # Separate key is unaffected
    limiter.check("chat_b")

    # Dropping a key clears its window
    limiter.drop("chat_a")
    limiter.check("chat_a")


async def test_rate_limit_exception_maps_to_429(tmp_path, monkeypatch):
    monkeypatch.setattr(database, "DB_PATH", str(tmp_path / "rl.db"))
    await database.init_db()
    ws = f"ws_{uuid.uuid4().hex[:8]}"
    await database.create_workspace(ws, "W")
    chat = await database.create_chat(title="t", document_id=None)

    monkeypatch.setattr(server, "chat_limiter", ChatRateLimiter(limit=0, window_s=60.0))
    transport = ASGITransport(app=server.app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.post(f"/api/chats/{chat['id']}/messages", json={"message": "hello"})
    assert res.status_code == 429


def test_chunker_extract_and_chunk_pages_roundtrip(tmp_path):
    path = str(tmp_path / "t.pdf")
    doc = pymupdf.open()
    page1 = doc.new_page()
    page1.insert_text((72, 72), "1. Introduction\n\nhello rsrch")
    doc.new_page()  # blank page should yield no chunks
    page3 = doc.new_page()
    page3.insert_text((72, 72), "More details without a new heading.")
    doc.save(path)
    doc.close()

    pages, count = chunker.extract_pdf_pages(path)
    assert count == 3
    chunks = chunker.chunk_pages(pages)
    assert len(chunks) == 2
    assert chunks[0]["page"] == 1
    assert chunks[0]["section"] == "1. Introduction"
    assert "hello" in chunks[0]["text"]
    # Heading carries forward across pages until superseded
    assert chunks[1]["page"] == 3
    assert chunks[1]["section"] == "1. Introduction"


def test_chunk_pages_splits_long_paragraphs_within_ceiling():
    sentence = "Attention mechanisms scale smoothly. " * 12  # ~444 chars
    long_page = (sentence + "\n\n") * 6
    chunks = chunker.chunk_pages([long_page])
    assert len(chunks) > 1
    assert all(len(c["text"]) <= chunker.MAX_CHUNK_CHARS for c in chunks)


async def test_backfill_chunks_with_missing_pdf_does_not_raise(tmp_path, monkeypatch):
    """Regression: unindexed docs with missing PDF files must not abort backfill."""
    monkeypatch.setattr(database, "DB_PATH", str(tmp_path / "backfill.db"))
    await database.init_db()
    ws = f"ws_{uuid.uuid4().hex[:8]}"
    doc = f"doc_{uuid.uuid4().hex[:8]}"
    await database.create_workspace(ws, "W")
    await database.create_document(
        doc, ws, "d.pdf", note_title="T", tag="G",
        file_path=str(tmp_path / "missing.pdf"), page_count=1,
        extracted_text="", doc_type="pdf",
    )
    assert await database.get_unindexed_pdf_docs()
    await server._backfill_chunks()
