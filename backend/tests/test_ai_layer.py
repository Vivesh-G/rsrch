"""AI-layer regression tests: LaTeX validators, citation markers, DSPy modules.

These cover the fixes in Context.md §7.6 — fences leaking out of the LaTeX
generator, comment braces failing validation, narrow citation parsing, and
`cited_pages` persistence.

Sync tests only: they call `asyncio.run` internally so the suite passes with or
without pytest-asyncio installed.
"""

import asyncio
import sys
import uuid
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import database  # noqa: E402
from ai.signatures import FixTectonicError  # noqa: E402
from ai.modules.latex_copilot import SafeLatexModule, _strip_code_fences  # noqa: E402
from ai.modules.paper_qa import GroundedPaperQAModule  # noqa: E402
from ai.validators import has_balanced_environments  # noqa: E402
from server import _extract_page_citations, _strip_page_citations  # noqa: E402


# --- has_balanced_environments -------------------------------------------------

def test_balanced_basic():
    assert has_balanced_environments("\\begin{itemize}\\item a\\end{itemize}")
    assert has_balanced_environments("\\begin{equation}x\\end{equation}")
    assert has_balanced_environments("\\begin{tabular}{lc}a & b\\\\\\end{tabular}")


def test_balanced_rejects_mismatched():
    assert not has_balanced_environments("\\begin{itemize}\\item a")
    assert not has_balanced_environments("\\begin{a}x\\end{b}")
    assert not has_balanced_environments("\\section{X")
    assert not has_balanced_environments("\\section{X}}")
    assert not has_balanced_environments("no end: \\begin{x}")


def test_balanced_ignores_comments():
    # A stray brace inside a LaTeX comment is not a syntax error.
    assert has_balanced_environments(
        "\\section{X} % TODO: rebalance { later\n\\begin{itemize}\\item a\\end{itemize}"
    )
    # Nor are commented-out environments.
    assert has_balanced_environments("% \\begin{itemize}\n\\section{Y}")


# --- citation markers ----------------------------------------------------------

def test_strip_removes_all_marker_forms():
    assert _strip_page_citations("As shown [p. 3], loss drops.") == "As shown, loss drops."
    assert _strip_page_citations("See [p. 1, p. 2] and [pp. 10-12].") == "See and."
    # Leading whitespace is consumed so no double space is left behind.
    assert "  " not in _strip_page_citations("word [p. 4] word")


def test_strip_leaves_non_citations_alone():
    text = "The value $[3]$ and $x_{3}$ stay."
    assert _strip_page_citations(text) == text


def test_extract_handles_ranges_and_lists():
    assert _extract_page_citations("a [p. 3] b [pp. 10-12] c [p. 1, p. 2]") == [1, 2, 3, 10, 11, 12]
    assert _extract_page_citations("nothing here") == []


# --- DSPy modules (DummyLM, no network) ----------------------------------------

def _dummy_lm(responses):
    from dspy.utils import DummyLM
    return DummyLM(responses)


def test_latex_module_always_strips_fences():
    import dspy

    bad = "```latex\n\\begin{itemize}\n\\item one\n```"
    # Enough responses to exhaust MAX_RETRIES: the returned code must still be
    # fence-free, or the fences get written straight into the user's document.
    with dspy.context(lm=_dummy_lm([{"reasoning": "r", "latex_code": bad}] * 8)):
        result = SafeLatexModule()(context=[], instruction="make a list")
    assert "```" not in result.latex_code
    assert result.latex_code.startswith("\\begin{itemize}")


def test_latex_module_returns_clean_code():
    import dspy

    good = "```latex\n\\begin{itemize}\n\\item one\n\\end{itemize}\n```"
    with dspy.context(lm=_dummy_lm([{"reasoning": "r", "latex_code": good}] * 3)):
        result = SafeLatexModule()(context=[], instruction="make a list")
    assert result.latex_code == "\\begin{itemize}\n\\item one\n\\end{itemize}"


def test_diagnostics_strips_fences():
    import dspy

    good = "```latex\n\\item x\n```"
    resp = {"reasoning": "r", "explanation": "missing end", "corrected_code": good}
    with dspy.context(lm=_dummy_lm([resp] * 3)):
        result = dspy.ChainOfThought(FixTectonicError)(error_log="err", latex_context="ctx")
        cleaned = _strip_code_fences(result.corrected_code)
    assert cleaned == "\\item x"


def test_qa_module_does_not_mutate_caller_context():
    import dspy

    context = ["[p. 1 | D]: text"]
    with dspy.context(lm=_dummy_lm([{"reasoning": "r", "answer": "A", "cited_pages": [1]}] * 3)):
        GroundedPaperQAModule(document_ids=[])(
            system="sys", context=context, chat_history=[], question="q?"
        )
    assert context == ["[p. 1 | D]: text"]


# --- chat message persistence --------------------------------------------------

def test_cited_pages_persist_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(database, "DB_PATH", str(tmp_path / "test.db"))

    async def run():
        await database.init_db()
        ws = f"ws_{uuid.uuid4().hex[:8]}"
        await database.create_workspace(ws, "W")
        doc = f"doc_{uuid.uuid4().hex[:8]}"
        await database.create_document(doc, ws, "d.pdf", note_title="T", tag="G",
                                      file_path=None, page_count=1,
                                      extracted_text="", doc_type="pdf")
        chat = await database.create_chat(title="t", document_id=doc)
        saved = await database.add_chat_message(
            chat["id"], doc, role="assistant", content="hi", cited_pages=[3, 1, 3, "bad"]
        )
        assert saved["cited_pages"] == [1, 3]
        msgs = await database.get_chat_messages(chat["id"])
        assert msgs[-1]["cited_pages"] == [1, 3]
        assert isinstance(msgs[-1]["cited_pages"], list)

    asyncio.run(run())


def test_dedupe_pages_helper():
    assert database._dedupe_pages([3, 1, 3, "x", None]) == [1, 3]
    assert database._dedupe_pages(None) == []


def test_search_chunks_handles_unicode_and_quotes(tmp_path, monkeypatch):
    monkeypatch.setattr(database, "DB_PATH", str(tmp_path / "test.db"))

    async def run():
        await database.init_db()
        ws = f"ws_{uuid.uuid4().hex[:8]}"
        await database.create_workspace(ws, "W")
        doc = f"doc_{uuid.uuid4().hex[:8]}"
        await database.create_document(doc, ws, "d.pdf", note_title="T", tag="G",
                                      file_path=None, page_count=1,
                                      extracted_text="", doc_type="pdf")
        await database.store_chunks(doc, [{"page": 1, "section": "1", "text": "Transformers use attention."}])
        assert len(await database.search_chunks([doc], "attention", limit=5)) == 1
        # Quotes/operators must not blow up the MATCH expression.
        assert await database.search_chunks([doc], 'what about "OR" AND NOT?', limit=5) is not None
        # A term FTS5 cannot parse must degrade to [] rather than raise.
        assert isinstance(await database.search_chunks([doc], "NEAR(", limit=5), list)

    asyncio.run(run())


# --- request model bounds ------------------------------------------------------

def test_send_request_doc_cap():
    from models import ChatSendRequest

    six = [str(i) for i in range(6)]
    assert len(ChatSendRequest(message="m", document_ids=six).document_ids) == 6
    with pytest.raises(Exception):
        ChatSendRequest(message="m", document_ids=six + ["7"])