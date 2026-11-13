import pymupdf
import re

# Target chunk size handed to `_split_at_paragraphs`. Also the hard ceiling:
# individual paragraphs longer than this are split on sentence boundaries.
MAX_CHUNK_CHARS = 1500
DEFAULT_CHUNK_OVERLAP = 200

def _detect_section_title(text: str) -> str | None:
    """Heuristic to find section titles like '1. Introduction', '3.1 Methods', or 'Abstract'."""
    lines = text.strip().split('\n')
    for line in lines[:3]:
        line = line.strip()
        if not line:
            continue
        # Numbered sections ("1. Introduction", "3.1 Methods"), all caps
        # headings, or short title-case lines, optionally with a colon suffix.
        core = line.split(':')[0].strip()
        if (len(line) < 100 and
            (line.isupper()
             or re.match(r'^(\d+(\.\d+)*\.?\s+).+', line)
             or re.match(r'^[A-Z][a-zA-Z0-9\s\-,\(\)]+$', core))):
            return line
    return None

def _split_at_paragraphs(
    text: str,
    max_chunk_size: int = MAX_CHUNK_CHARS,
    overlap: int = DEFAULT_CHUNK_OVERLAP,
) -> list[str]:
    """Split text into chunks by paragraphs, respecting a maximum chunk size."""
    paragraphs = re.split(r'\n\s*\n', text)
    chunks = []
    current_chunk = []
    current_len = 0

    def _append_segment(segment: str) -> None:
        nonlocal current_chunk, current_len
        seg_len = len(segment)
        if current_len + seg_len > max_chunk_size and current_chunk:
            chunks.append('\n\n'.join(current_chunk))
            overlap_text = current_chunk[-1] if current_chunk and len(current_chunk[-1]) <= overlap else ""
            current_chunk = [overlap_text, segment] if overlap_text else [segment]
            current_len = len(overlap_text) + seg_len + (2 if overlap_text else 0)
        else:
            current_chunk.append(segment)
            current_len += seg_len + 2

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue

        while len(para) > max_chunk_size:
            split_at = max(
                para.rfind('. ', 0, max_chunk_size),
                para.rfind('\n', 0, max_chunk_size),
            )
            if split_at <= 0:
                split_at = max_chunk_size
            head, para = para[:split_at + 1].strip(), para[split_at + 1:].strip()
            _append_segment(head)
            if not para:
                break
        if not para:
            continue

        _append_segment(para)

    if current_chunk:
        chunks.append('\n\n'.join(current_chunk))
        
    return chunks

def extract_pdf_pages(file_path: str) -> tuple[list[str], int]:
    """Read a PDF once into `(page_texts, page_count)` cleanly closing the handle."""
    doc = pymupdf.open(file_path)
    try:
        page_count = doc.page_count
        pages = [doc.load_page(i).get_text("text") or "" for i in range(page_count)]
        return pages, page_count
    finally:
        # Release the OS file handle even if a page fails to parse.
        doc.close()


def chunk_pages(page_texts: list[str]) -> list[dict]:
    """Split extracted per-page texts into page-aware text chunks."""
    chunks = []
    current_section = None

    for page_num, text in enumerate(page_texts):
        if not text.strip():
            continue

        detected_section = _detect_section_title(text)
        if detected_section:
            current_section = detected_section

        for chunk in _split_at_paragraphs(text, max_chunk_size=MAX_CHUNK_CHARS):
            stripped = chunk.strip()
            if stripped:
                chunks.append({
                    "page": page_num + 1,
                    "text": stripped,
                    "section": current_section,
                })

    return chunks


def chunk_pdf(file_path: str) -> list[dict]:
    """
    Parse a PDF and split it into page-aware text chunks.
    Returns a list of dicts: {"page": int, "text": str, "section": str | None}
    """
    pages, _ = extract_pdf_pages(file_path)
    return chunk_pages(pages)
