import dspy
from ai.signatures import GroundedPaperQA
from ai.retriever import FTS5RetrieverModule


class GroundedPaperQAModule(dspy.Module):
    """CoT QA over `GroundedPaperQA`.

    `document_ids` is only used when this module performs its own retrieval.
    `send_chat_message` always passes `document_ids=[]` and supplies pre-retrieved
    passages via `context` (retrieval runs in the request handler so DSPy stays on
    a single thread inside `dspy.context`).
    """

    def __init__(self, document_ids: list[str] | None = None):
        super().__init__()
        self.cot = dspy.ChainOfThought(GroundedPaperQA)
        self.document_ids = list(document_ids or [])

    def forward(
        self,
        system: str,
        chat_history: list[str],
        question: str,
        context: list[str] | None = None,
    ):
        # Copy so in-module retrieval never mutates the caller's list.
        passages = list(context or [])
        if self.document_ids:
            retriever = FTS5RetrieverModule(self.document_ids, k=10)
            retrieved = retriever(question)
            passages.extend(p.long_text for p in retrieved.passages)

        return self.cot(
            system=system,
            context=passages,
            chat_history=chat_history,
            question=question,
        )