"""Server util tests: PDF magic bytes, rate limiter, PDF extraction."""

import uuid

import pytest
from fastapi import HTTPException

import server
from config import settings


def _chat_id():
    return f"chat_test_{uuid.uuid4().hex[:8]}"


@pytest.fixture
def isolated_chats():
    seen = []
    yield seen.append
    for chat_id in seen:
        server._chat_hits.pop(chat_id, None)


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


def test_allows_up_to_limit_then_429(isolated_chats):
    chat_id = _chat_id()
    isolated_chats(chat_id)
    for _ in range(settings.chat_rate_limit):
        server.check_chat_rate_limit(chat_id)
    with pytest.raises(HTTPException) as exc_info:
        server.check_chat_rate_limit(chat_id)
    assert exc_info.value.status_code == 429


def test_rate_limit_is_per_key(isolated_chats):
    chat_a, chat_b = _chat_id(), _chat_id()
    isolated_chats(chat_a)
    isolated_chats(chat_b)
    for _ in range(settings.chat_rate_limit):
        server.check_chat_rate_limit(chat_a)
    # Other chat unaffected by A's exhaustion.
    server.check_chat_rate_limit(chat_b)


def test_extract_pdf_roundtrip(tmp_path):
    import pymupdf

    path = str(tmp_path / "t.pdf")
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 72), "hello rsrch")
    doc.save(path)
    doc.close()

    text, pages = server._extract_pdf(path)
    assert pages == 1
    assert "hello" in text


def test_extract_pdf_missing_file_returns_empty():
    text, pages = server._extract_pdf("/nonexistent/missing.pdf")
    assert (text, pages) == ("", 1)
