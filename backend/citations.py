import re

# Matches [p. 3], [p. 3, p. 7], [pp. 10-12], [pp. 10–12] and combinations.
_CITATION_BODY = (
    r"\[p{1,2}s?\.\s*\d+(?:\s*[-\u2013]\s*\d+)?"
    r"(?:\s*,\s*(?:p{1,2}s?\.\s*)?\d+(?:\s*[-\u2013]\s*\d+)?)*\]"
)
PAGE_CITATION_RE = re.compile(_CITATION_BODY)
_STRIPPABLE_CITATION_RE = re.compile(r"[ \t]*" + _CITATION_BODY)


_DSPY_MARKER_RE = re.compile(r"\[\[\s*##.*?##\s*\]*\]?")
_DSPY_COMPLETED_RE = re.compile(r"\[\[\s*##\s*completed\b.*", flags=re.IGNORECASE)


def strip_page_citations(text: str) -> str:
    """Remove [p. N] / [p. N, p. M] / [pp. N-M] markers from generated text."""
    return _STRIPPABLE_CITATION_RE.sub("", text or "")


def sanitize_output(text: str) -> str:
    """Remove leaked DSPy delimiter tags from model text."""
    if not text:
        return ""
    cleaned = _DSPY_MARKER_RE.sub("", text)
    cleaned = _DSPY_COMPLETED_RE.sub("", cleaned)
    return cleaned.strip()


def extract_page_citations(text: str) -> list[int]:
    """Extract every page number inside [p. ...] markers, expanding ranges."""
    pages: set[int] = set()
    for marker in PAGE_CITATION_RE.finditer(text or ""):
        for chunk in marker.group().strip("[]").split(","):
            nums = [int(n) for n in re.findall(r"\d+", chunk)]
            if len(nums) == 2 and re.search(r"\d\s*[-\u2013]\s*\d", chunk):
                lo, hi = sorted(nums)
                if 0 < lo <= hi <= lo + 500:
                    pages.update(range(lo, hi + 1))
                    continue
            pages.update(nums)
    return sorted(pages)
