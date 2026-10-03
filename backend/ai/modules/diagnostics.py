import dspy
from ai.signatures import FixTectonicError
from ai.modules.latex_copilot import _strip_code_fences

class FixTectonicErrorModule(dspy.Module):
    def __init__(self):
        super().__init__()
        self.diagnoser = dspy.ChainOfThought(FixTectonicError)

    def forward(self, error_log: str, latex_context: str):
        result = self.diagnoser(error_log=error_log, latex_context=latex_context)
        result.corrected_code = _strip_code_fences(result.corrected_code)
        return result