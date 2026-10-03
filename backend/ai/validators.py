import re

_BEGIN_RE = re.compile(r'\\begin\{([^}]+)\}')
_END_RE = re.compile(r'\\end\{([^}]+)\}')
_TOKEN_RE = re.compile(r'\\(?:begin|end)\{[^}]+\}')
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
    # --- Environments (comments ignored; they can contain stray \begin/\end) ---
    stack: list[str] = []

    for match in _TOKEN_RE.finditer(_COMMENT_RE.sub("", latex_code or "")):
        token = match.group()
        if token.startswith('\\begin'):
            env_match = _BEGIN_RE.match(token)
            if env_match:
                stack.append(env_match.group(1))
        elif token.startswith('\\end'):
            env_match = _END_RE.match(token)
            if not env_match:
                return False  # Malformed \end{...}
            if not stack:
                return False  # Unmatched \end
            if stack.pop() != env_match.group(1):
                return False  # Mismatched environments

    if stack:
        return False  # Unmatched \begin

    # --- Braces ---
    # Ignore escaped braces \{ and \} before counting.
    clean_code = _ESCAPED_BRACE_RE.sub("", _COMMENT_RE.sub("", latex_code or ""))

    brace_count = 0
    for char in clean_code:
        if char == '{':
            brace_count += 1
        elif char == '}':
            brace_count -= 1
            if brace_count < 0:
                return False

    return brace_count == 0