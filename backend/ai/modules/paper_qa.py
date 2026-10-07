import dspy
from ai.signatures import GroundedPaperQA


class GroundedPaperQAModule(dspy.Module):
    """CoT QA over `GroundedPaperQA`. Pre-retrieved passages are passed directly via `context`."""

    def __init__(self, document_ids: list[str] | None = None):
        super().__init__()
        self.cot = dspy.ChainOfThought(GroundedPaperQA)

    def forward(
        self,
        system: str,
        chat_history: list[str],
        question: str,
        context: list[str] | None = None,
    ):
        passages = list(context or [])
        return self.cot(
            system=system,
            context=passages,
            chat_history=chat_history,
            question=question,
        )