import dspy
from database import get_all_settings
import os

async def get_dspy_lm(
    model_override: str | None = None, api_key_override: str | None = None
) -> dspy.LM:
    """Create a configured DSPy LM using the user's Gemini settings."""
    from config import settings as app_settings

    db_settings = await get_all_settings()
    api_key = (
        (api_key_override or "").strip()
        or db_settings.get("gemini_api_key", "").strip()
        or os.environ.get("GEMINI_API_KEY", "").strip()
    )

    model = (
        (model_override or "").strip()
        or (db_settings.get("gemini_model") or "").strip()
        or app_settings.gemini_model
    )

    try:
        temperature = float(db_settings.get("ai_temperature", 0.7))
    except (ValueError, TypeError):
        temperature = 0.7

    return dspy.LM(
        model=f"gemini/{model}",
        api_key=api_key,
        temperature=temperature,
    )
