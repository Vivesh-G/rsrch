import fitz  # PyMuPDF
import re

# Target chunk size handed to `_split_at_paragraphs`. Also the hard ceiling:
# individual paragraphs longer than this are split on sentence boundaries.
MAX_CHUNK_CHARS = 1500

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

def _split_at_paragraphs(text: str, max_chunk_size: int = 1500, overlap: int = 200) -> list[str]:
    """Split text into chunks by paragraphs, respecting a maximum chunk size."""
    paragraphs = re.split(r'\n\s*\n', text)
    chunks = []
    current_chunk = []
    current_len = 0
    
    for para in paragraphs:
        para = para.strip()
        if not para:
            continue

        # Hard-split single paragraphs that exceed the max size on sentence
        # boundaries so one long paragraph can't blow the chunk budget.
        while len(para) > max_chunk_size:
            split_at = max(
                para.rfind('. ', 0, max_chunk_size),
                para.rfind('\n', 0, max_chunk_size),
            )
            if split_at <= 0:
                split_at = max_chunk_size
            head, para = para[:split_at + 1].strip(), para[split_at + 1:].strip()
            if current_len + len(head) > max_chunk_size and current_chunk:
                chunks.append('\n\n'.join(current_chunk))
                overlap_text = current_chunk[-1] if current_chunk and len(current_chunk[-1]) <= overlap else ""
                current_chunk = [overlap_text, head] if overlap_text else [head]
                current_len = len(overlap_text) + len(head) + (2 if overlap_text else 0)
            else:
                current_chunk.append(head)
                current_len += len(head) + 2 # +2 for \n\n
            if not para:
                break
        if not para:
            continue

        para_len = len(para)

        # Remainder (now guaranteed <= max_chunk_size) joins the running chunk.
        if current_len + para_len > max_chunk_size and current_chunk:
            chunks.append('\n\n'.join(current_chunk))
            # Start new chunk with some overlap from previous paragraphs
            # This is a naive overlap (just taking the last paragraph)
            overlap_text = current_chunk[-1] if current_chunk and len(current_chunk[-1]) <= overlap else ""
            current_chunk = [overlap_text, para] if overlap_text else [para]
            current_len = len(overlap_text) + para_len + (2 if overlap_text else 0)
        else:
            current_chunk.append(para)
            current_len += para_len + 2 # +2 for \n\n
            
    if current_chunk:
        chunks.append('\n\n'.join(current_chunk))
        
    return chunks

def chunk_pdf(file_path: str) -> list[dict]:
    """
    Parse a PDF and split it into page-aware text chunks.
    Returns a list of dicts: {"page": int, "text": str, "section": str | None}
    """
    chunks = []
    doc = fitz.open(file_path)

    try:
        current_section = None

        for page_num in range(len(doc)):
            page = doc[page_num]
            text = page.get_text("text")

            if not text.strip():
                continue

            detected_section = _detect_section_title(text)
            if detected_section:
                current_section = detected_section

            page_chunks = _split_at_paragraphs(text, max_chunk_size=MAX_CHUNK_CHARS)

            for chunk in page_chunks:
                if not chunk.strip():
                    continue
                chunks.append({
                    "page": page_num + 1,
                    "text": chunk.strip(),
                    "section": current_section
                })
    finally:
        # Release the OS file handle even if a page fails to parse.
        doc.close()

    return chunks
