import dspy


class GroundedPaperQA(dspy.Signature):
    """Answer the user's research question using ONLY the provided paper excerpts.
    Ground every claim with [p. X] page references. If the answer cannot be
    determined from the excerpts, say so explicitly."""

    system: str = dspy.InputField(
        desc="Persona and output-style instructions the assistant must follow"
    )
    context: list[str] = dspy.InputField(
        desc="Paper excerpts formatted as '[Page X | Section Y]: content'"
    )
    chat_history: list[str] = dspy.InputField(
        desc="Recent conversation messages (excluding the current question) for continuity"
    )
    question: str = dspy.InputField(desc="User's research question")

    reasoning: str = dspy.OutputField(
        desc="Step-by-step analysis of the evidence before answering"
    )
    answer: str = dspy.OutputField(
        desc="Academic answer in Markdown with [p. X] citations and LaTeX math"
    )
    cited_pages: list[int] = dspy.OutputField(
        desc="Unique page numbers referenced in the answer"
    )


class SafeLatexGenerator(dspy.Signature):
    """Generate a valid LaTeX snippet based on the user's instructions.
    Ensure that all environments (e.g., \\begin{...} \\end{...}) and brackets are perfectly balanced.
    Never include [p. X] page citations or reference markers in the code.
    Return ONLY the LaTeX code block."""

    context: list[str] = dspy.InputField(desc="The existing LaTeX document context")
    instruction: str = dspy.InputField(desc="User's instruction for generating LaTeX")

    latex_code: str = dspy.OutputField(desc="Valid LaTeX code block snippet")


class FixTectonicError(dspy.Signature):
    """Analyze a tectonic compiler error log and generate a fix.
    Given the error message and the surrounding LaTeX code, identify the issue
    and provide the corrected LaTeX snippet that resolves the error."""

    error_log: str = dspy.InputField(desc="Compiler error log from Tectonic")
    latex_context: str = dspy.InputField(
        desc="The actual LaTeX source lines around the reported error"
    )

    explanation: str = dspy.OutputField(desc="Brief explanation of the error and the fix")
    corrected_code: str = dspy.OutputField(desc="The corrected LaTeX snippet")