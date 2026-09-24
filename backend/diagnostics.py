import re
from pydantic import BaseModel

class Diagnostic(BaseModel):
    severity: str
    message: str
    file: str | None = None
    line: int | None = None
    column: int | None = None
    source: str = "tectonic"

def parse_diagnostics(stderr: str, log_content: str) -> list[Diagnostic]:
    diagnostics = []
    seen = set()
    
    def add_diag(diag: Diagnostic):
        key = (diag.severity, diag.line, diag.message)
        if key not in seen:
            seen.add(key)
            diagnostics.append(diag)
    
    # 1. Parse stderr for Tectonic errors (supports Windows drive letters e.g. C:\...)
    stderr_pattern = re.compile(r"error:\s+((?:[a-zA-Z]:)?[^:]+):(\d+)(?::(\d+))?:\s+(.+)")
    for line in stderr.splitlines():
        if match := stderr_pattern.search(line):
            add_diag(Diagnostic(
                severity="error",
                file=match.group(1).strip(),
                line=int(match.group(2)),
                column=int(match.group(3)) if match.group(3) else None,
                message=match.group(4).strip()
            ))

    # 2. Parse standard LaTeX / TeX log
    lines = log_content.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        
        # TeX errors start with "! "
        if line.startswith("! "):
            msg = line[2:].strip()
            if msg.startswith("LaTeX Error:"):
                msg = msg[12:].strip()
            line_no = None
            j = i + 1
            while j < min(i + 8, len(lines)):
                if "l." in lines[j]:
                    if match := re.search(r"l\.(\d+)", lines[j]):
                        line_no = int(match.group(1))
                        break
                j += 1
            add_diag(Diagnostic(
                severity="error",
                message=msg,
                line=line_no
            ))
            i = j
            
        elif line.startswith("LaTeX Warning:") or (line.startswith("Package") and "Warning:" in line):
            msg = line
            if line.startswith("LaTeX Warning:"):
                msg = line[14:].strip()
            line_no = None
            if match := re.search(r"on input line (\d+)", msg):
                line_no = int(match.group(1))
            add_diag(Diagnostic(
                severity="warning",
                message=msg,
                line=line_no
            ))
            
        elif line.startswith("Overfull") or line.startswith("Underfull"):
            line_no = None
            if match := re.search(r"lines (\d+)--(\d+)", line):
                line_no = int(match.group(1))
            add_diag(Diagnostic(
                severity="warning",
                message=line.strip(),
                line=line_no
            ))
            
        i += 1
        
    return diagnostics
