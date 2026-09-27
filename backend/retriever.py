import sqlite3
import sqlite_utils
from typing import List, Optional, Dict, Any, Union
import dspy

class DocumentContextRetriever(dspy.Retrieve):
    """
    A custom DSPy Retriever that creates an ephemeral SQLite FTS5 index
    for the specific documents attached to a chat context.
    It chunks the text and uses BM25 to retrieve the most relevant sections.
    """
    def __init__(self, context_docs: List[Dict[str, Any]], k: int = 3):
        super().__init__(k=k)
        self.db = sqlite_utils.Database(memory=True)
        self.k = k
        self._index_docs(context_docs)

    def _chunk_text(self, text: str, chunk_size: int = 1500, overlap: int = 200) -> List[str]:
        chunks = []
        if not text:
            return chunks
        start = 0
        text_length = len(text)
        while start < text_length:
            end = start + chunk_size
            chunks.append(text[start:end])
            start += chunk_size - overlap
        return chunks

    def _index_docs(self, context_docs: List[Dict[str, Any]]):
        chunks_data = []
        for doc in context_docs:
            doc_id = doc.get("id", "")
            title = doc.get("note_title") or doc.get("name") or "Document"

            # Use 'content' for LaTeX, 'extracted_text' for PDFs
            text = ""
            if doc.get("doc_type") == "latex":
                text = doc.get("content", "")
            else:
                text = doc.get("extracted_text", "")

            chunks = self._chunk_text(text)
            for i, chunk in enumerate(chunks):
                chunks_data.append({
                    "doc_id": doc_id,
                    "title": title,
                    "chunk_id": i,
                    "text": chunk
                })

        if chunks_data:
            self.db["chunks"].insert_all(chunks_data)
            self.db["chunks"].enable_fts(["text", "title"], fts_version="FTS5")

    def forward(self, query_or_queries: Union[str, List[str]], k: Optional[int] = None, **kwargs) -> dspy.Prediction:
        k = k if k is not None else self.k
        queries = [query_or_queries] if isinstance(query_or_queries, str) else query_or_queries

        results = []
        if "chunks" not in self.db.table_names():
            return dspy.Prediction(passages=[])

        for query in queries:
            try:
                # Escape FTS special characters to prevent OperationalError on normal questions
                import re
                safe_query = re.sub(r'[^\w\s]', ' ', query).strip()
                if not safe_query:
                    continue

                # sqlite-utils handles bm25 and ordering automatically with search()
                # If the query is empty or invalid, it might throw an error.
                rows = list(self.db["chunks"].search(safe_query, limit=k))

                for row in rows:
                    title = row["title"]
                    text = row["text"]
                    snippet = f"[{title}]\n{text}"
                    results.append(snippet)
            except Exception as e:
                import logging
                logging.getLogger("rsrch.server").warning(f"FTS5 Search error on query '{query}': {e}")
                pass

        # Deduplicate and return top k
        unique_results = list(dict.fromkeys(results))[:k]
        return dspy.Prediction(passages=unique_results)
