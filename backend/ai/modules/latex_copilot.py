import re
import dspy
from ai.signatures import SafeLatexGenerator
from ai.validators import has_balanced_environments

MAX_RETRIES = 3

def _strip_code_fences(code: str) -> str:
    """Remove a leading ```latex / ``` opener and the trailing ``` fence, plus any leaked DSPy delimiters."""
    if not code:
        return ""
    code = code.strip()
    # Strip any trailing or internal DSPy delimiters e.g. [[ ## completed ## ]] or [[ ## ... ## ]]
    code = re.sub(r"\[\[\s*##.*?##\s*\]*\]?", "", code).strip()

    # If code contains markdown code fences, extract the enclosed block
    fence_match = re.search(r"```(?:latex|tex)?\s*\n?(.*?)\n?```", code, re.DOTALL)
    if fence_match:
        code = fence_match.group(1).strip()
    else:
        for prefix in ("```latex", "```tex", "```"):
            if code.startswith(prefix):
                code = code[len(prefix):].strip()
        if code.endswith("```"):
            code = code[:-3].strip()

    # Final cleanup of any trailing delimiter
    code = re.sub(r"\[\[\s*##.*?##\s*\]*\]?", "", code).strip()
    return code

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