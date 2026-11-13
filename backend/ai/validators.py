import re

_ENV_TOKEN_RE = re.compile(r'\\(begin|end)\{([^}]+)\}')
# LaTeX comments run to end of line; braces inside them are not structural.
_COMMENT_RE = re.compile(r'(?<!\\)%[^\n]*')
_ESCAPED_BRACE_RE = re.compile(r'\\[{}]')


def has_balanced_environments(latex_code: str) -> bool:
    """
    Checks if LaTeX environments (\\begin{...} and \\end{...}) and brackets are balanced.
    Returns True if balanced, False otherwise.

    LaTeX comments (`% ...`) are stripped before counting braces so an unbalanced
    brace in a comment does not fail an otherwise valid document.
    """
    uncommented = _COMMENT_RE.sub("", latex_code or "")

    # --- Environments (comments ignored; they can contain stray \begin/\end) ---
    stack: list[str] = []

    for match in _ENV_TOKEN_RE.finditer(uncommented):
        kind, env_name = match.group(1), match.group(2)
        if kind == "begin":
            stack.append(env_name)
        else:
            if not stack or stack.pop() != env_name:
                return False  # Unmatched or mismatched \end

    if stack:
        return False  # Unmatched \begin

    # --- Braces ---
    # Ignore escaped braces \{ and \} before counting.
    clean_code = _ESCAPED_BRACE_RE.sub("", uncommented)

    brace_count = 0
    for char in clean_code:
        if char == '{':
            brace_count += 1
        elif char == '}':
            brace_count -= 1
            if brace_count < 0:
                return False

    return brace_count == 0