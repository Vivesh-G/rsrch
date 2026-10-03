import dspy
from ai.signatures import SafeLatexGenerator
from ai.validators import has_balanced_environments

MAX_RETRIES = 3

def _strip_code_fences(code: str) -> str:
    """Remove a leading ```latex / ``` opener and the trailing ``` fence."""
    code = (code or "").strip()
    if code.startswith("```latex"):
        code = code[len("```latex"):]
    elif code.startswith("```tex"):
        code = code[len("```tex"):]
    elif code.startswith("```"):
        code = code[len("```"):]
    if code.endswith("```"):
        code = code[: -len("```")]
    return code.strip()

class SafeLatexModule(dspy.Module):
    def __init__(self):
        super().__init__()
        self.generator = dspy.ChainOfThought(SafeLatexGenerator)

    def forward(self, context: list[str], instruction: str):
        # Try up to MAX_RETRIES times if environments are unbalanced. The
        # cleaned `code` is written back onto the prediction on EVERY attempt,
        # so the retry-exhausted return never leaks ```latex fences to callers.
        result = None
        code = ""
        for _attempt in range(MAX_RETRIES):
            result = self.generator(context=context, instruction=instruction)
            code = _strip_code_fences(result.latex_code)
            result.latex_code = code

            if has_balanced_environments(code):
                return result

            # Failed validation: warn and retry with a stricter instruction.
            instruction += (
                "\n\nCRITICAL: Your previous response had unbalanced LaTeX "
                "environments or braces. You MUST ensure every \\begin is matched "
                "with an \\end and all { } are balanced."
            )

        # Still invalid after MAX_RETRIES: return the last attempt with fences
        # already stripped (callers warn the user it may not compile).
        return result