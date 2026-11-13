"""AI-layer regression tests: LaTeX validators, citation markers, AI config, DSPy modules."""

import dataclasses
import uuid

import dspy
import pytest

import ai.config as ai_config
import database
from ai.modules.latex_copilot import FixTectonicModule, SafeLatexModule, strip_code_fences
from ai.modules.paper_qa import GroundedPaperQAModule
from ai.validators import has_balanced_environments
from citations import extract_page_citations, sanitize_output, strip_page_citations
from config import CHAT_MAX_DOCS
from models import ChatSendRequest


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


# --- citation markers & DSPy delimiter sanitization ----------------------------

def test_strip_removes_all_marker_forms():
    assert strip_page_citations("As shown [p. 3], loss drops.") == "As shown, loss drops."
    assert strip_page_citations("See [p. 1, p. 2] and [pp. 10-12].") == "See and."
    # Leading whitespace is consumed so no double space is left behind.
    assert "  " not in strip_page_citations("word [p. 4] word")


def test_strip_leaves_non_citations_alone():
    text = "The value $[3]$ and $x_{3}$ stay."
    assert strip_page_citations(text) == text


def test_extract_handles_ranges_and_lists():
    assert extract_page_citations("a [p. 3] b [pp. 10-12] c [p. 1, p. 2]") == [1, 2, 3, 10, 11, 12]
    assert extract_page_citations("nothing here") == []


def test_sanitize_output_removes_leaked_dspy_markers():
    raw = "[[ ## reasoning ## ]] Answer text.\n[[ ## completed ## ]]"
    assert sanitize_output(raw) == "Answer text."


# --- AI config resolution ------------------------------------------------------

def test_resolve_ai_config_precedence_and_fallbacks(monkeypatch):
    monkeypatch.setattr(
        ai_config,
        "app_settings",
        dataclasses.replace(
            ai_config.app_settings,
            gemini_api_key="env-key",
            gemini_model="gemini-3.5-flash-lite",
        ),
    )

    cfg = ai_config.resolve_ai_config(
        db_settings={
            "gemini_api_key": "db-key",
            "gemini_model": "none",
            "ai_temperature": "not-a-float",
            "user_name": "Ada",
        },
        api_key_override="req-key",
    )
    assert cfg.api_key == "req-key"
    assert cfg.model == "gemini-3.5-flash-lite"
    assert cfg.temperature == 0.7
    assert cfg.user_name == "Ada"

    lm = ai_config.get_dspy_lm(cfg)
    assert lm.model == "gemini/gemini-3.5-flash-lite"


# --- DSPy modules (DummyLM, no network) ----------------------------------------

def _dummy_lm(responses):
    from dspy.utils import DummyLM
    return DummyLM(responses)


def test_latex_module_always_strips_fences():
    bad = "```latex\n\\begin{itemize}\n\\item one\n```"
    with dspy.context(lm=_dummy_lm([{"reasoning": "r", "latex_code": bad}] * 8)):
        result = SafeLatexModule()(context=[], instruction="make a list")
    assert "```" not in result.latex_code
    assert result.latex_code.startswith("\\begin{itemize}")


def test_latex_module_returns_clean_code():
    good = "```latex\n\\begin{itemize}\n\\item one\n\\end{itemize}\n```"
    with dspy.context(lm=_dummy_lm([{"reasoning": "r", "latex_code": good}] * 3)):
        result = SafeLatexModule()(context=[], instruction="make a list")
    assert result.latex_code == "\\begin{itemize}\n\\item one\n\\end{itemize}"


def test_fix_tectonic_module_strips_fences_and_markers():
    good = "```latex\n\\item x\n```"
    resp = {
        "reasoning": "r",
        "explanation": "missing end [[ ## completed ## ]]",
        "corrected_code": good,
    }
    with dspy.context(lm=_dummy_lm([resp] * 3)):
        result = FixTectonicModule()(error_log="err", latex_context="ctx")
    assert result.corrected_code == "\\item x"
    assert result.explanation == "missing end"


def test_strip_code_fences_handles_inline_tex_fence():
    assert strip_code_fences("```tex\n\\alpha + \\beta\n```") == "\\alpha + \\beta"


def test_qa_module_does_not_mutate_caller_context():
    context = ["[p. 1 | D]: text"]
    with dspy.context(lm=_dummy_lm([{"reasoning": "r", "answer": "A", "cited_pages": [1]}] * 3)):
        GroundedPaperQAModule()(
            system="sys", context=context, chat_history=[], question="q?"
        )
    assert context == ["[p. 1 | D]: text"]


# --- chat message persistence --------------------------------------------------

async def test_cited_pages_persist_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(database, "DB_PATH", str(tmp_path / "test.db"))
    await database.init_db()
    ws = f"ws_{uuid.uuid4().hex[:8]}"
    await database.create_workspace(ws, "W")
    doc = f"doc_{uuid.uuid4().hex[:8]}"
    await database.create_document(
        doc, ws, "d.pdf", note_title="T", tag="G",
        file_path=None, page_count=1, extracted_text="", doc_type="pdf",
    )
    chat = await database.create_chat(title="t", document_id=doc)
    saved = await database.add_chat_message(
        chat["id"], doc, role="assistant", content="hi", cited_pages=[3, 1, 3, "bad"]
    )
    assert saved["cited_pages"] == [1, 3]
    msgs = await database.get_chat_messages(chat["id"])
    assert msgs[-1]["cited_pages"] == [1, 3]
    assert isinstance(msgs[-1]["cited_pages"], list)


def test_dedupe_pages_helper():
    assert database.dedupe_pages([3, 1, 3, "x", None]) == [1, 3]
    assert database.dedupe_pages(None) == []


async def test_search_chunks_handles_unicode_and_quotes(tmp_path, monkeypatch):
    monkeypatch.setattr(database, "DB_PATH", str(tmp_path / "test.db"))
    await database.init_db()
    ws = f"ws_{uuid.uuid4().hex[:8]}"
    await database.create_workspace(ws, "W")
    doc = f"doc_{uuid.uuid4().hex[:8]}"
    await database.create_document(
        doc, ws, "d.pdf", note_title="T", tag="G",
        file_path=None, page_count=1, extracted_text="", doc_type="pdf",
    )
    await database.store_chunks(doc, [{"page": 1, "section": "1", "text": "Transformers use attention."}])
    assert len(await database.search_chunks([doc], "attention", limit=5)) == 1
    # Quotes/operators must not blow up the MATCH expression.
    assert await database.search_chunks([doc], 'what about "OR" AND NOT?', limit=5) is not None
    # A term FTS5 cannot parse must degrade to [] rather than raise.
    assert isinstance(await database.search_chunks([doc], "NEAR(", limit=5), list)


# --- request model bounds ------------------------------------------------------

def test_send_request_doc_cap():
    capped = [str(i) for i in range(CHAT_MAX_DOCS)]
    assert len(ChatSendRequest(message="m", document_ids=capped).document_ids) == CHAT_MAX_DOCS
    with pytest.raises(Exception):
        ChatSendRequest(message="m", document_ids=capped + ["extra"])
