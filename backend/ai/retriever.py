import dspy
from database import search_chunks


class FTS5RetrieverModule(dspy.Retrieve):
    """DSPy `Retrieve` wrapper over the SQLite FTS5 chunk index.

    DEPRECATED for the chat path: `send_chat_message` runs `search_chunks`
    asynchronously in the request handler and passes the passages straight to
    `GroundedPaperQAModule(document_ids=[])`, so this class is never constructed
    with real ids from the app.

    If you do call it from inside async code, be aware that `dspy.Retrieve.forward`
    is synchronous: it bridges to the async `search_chunks` via a throwaway thread
    with a fresh event loop, which means it cannot share a connection or a
    transaction with the caller. Prefer pre-retrieving and passing
    `document_ids=[]`.
    """

    def __init__(self, document_ids: list[str], k: int = 5):
        super().__init__(k=k)
        self.document_ids = document_ids

    def forward(self, query_or_queries, k: int | None = None, **kwargs) -> dspy.Prediction:
        import asyncio
        import logging
        import threading

        k = k if k is not None else self.k
        queries = (
            [query_or_queries]
            if isinstance(query_or_queries, str)
            else list(query_or_queries)
        )

        all_chunks: list[dspy.Prediction] = []
        for query in queries:
            # Synchronous bridge for the async search (see class docstring).
            result_container: list[list[dict]] = []

            def run_sync(q: str = query) -> None:
                loop = asyncio.new_event_loop()
                try:
                    asyncio.set_event_loop(loop)
                    result_container.append(loop.run_until_complete(search_chunks(self.document_ids, q, k)))
                except Exception as exc:  # noqa: BLE001 - never kill the caller
                    logging.getLogger("rsrch.retriever").error("FTS5 retriever error: %s", exc)
                    result_container.append([])
                finally:
                    try:
                        loop.close()
                    finally:
                        asyncio.set_event_loop(None)

            thread = threading.Thread(target=run_sync, daemon=True)
            thread.start()
            thread.join()

            for row in result_container[0] if result_container else []:
                text = row.get("text_content") or ""
                page = row.get("page")
                section = row.get("section") or "Unknown"
                doc_id = row.get("document_id")
                all_chunks.append(
                    dspy.Prediction(
                        long_text=f"[Doc: {doc_id} | Page: {page} | Section: {section}]: {text}",
                        page=page,
                        section=section,
                    )
                )

        # Simple deduplication on the formatted passage text.
        seen: set[str] = set()
        unique_chunks: list[dspy.Prediction] = []
        for chunk in all_chunks:
            if chunk.long_text not in seen:
                seen.add(chunk.long_text)
                unique_chunks.append(chunk)

        return dspy.Prediction(passages=unique_chunks[:k])