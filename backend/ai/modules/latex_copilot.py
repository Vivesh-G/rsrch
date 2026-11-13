import re
import dspy
from ai.signatures import FixTectonicError, SafeLatexGenerator
from ai.validators import has_balanced_environments
from citations import sanitize_output

MAX_RETRIES = 3


def strip_code_fences(code: str) -> str:
    """Remove markdown ```latex / ``` fences and leaked DSPy delimiters."""
    cleaned = sanitize_output(code or "")
    if not cleaned:
        return ""

    fence_match = re.search(r"```(?:latex|tex)?\s*\n?(.*?)\n?```", cleaned, re.DOTALL)
    if fence_match:
        cleaned = fence_match.group(1).strip()
    else:
        for prefix in ("```latex", "```tex", "```"):
            if cleaned.startswith(prefix):
                cleaned = cleaned[len(prefix):].strip()
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3].strip()

    return sanitize_output(cleaned)


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
            code = strip_code_fences(result.latex_code)
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


class FixTectonicModule(dspy.Module):
    def __init__(self):
        super().__init__()
        self.fixer = dspy.ChainOfThought(FixTectonicError)

    def forward(self, error_log: str, latex_context: str):
        result = self.fixer(error_log=error_log, latex_context=latex_context)
        result.corrected_code = strip_code_fences(getattr(result, "corrected_code", "") or "")
        result.explanation = sanitize_output(getattr(result, "explanation", "") or "")
        return result