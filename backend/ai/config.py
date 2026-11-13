from dataclasses import dataclass
from typing import Mapping
import dspy
from config import (
    DEFAULT_AI_PERSONA,
    DEFAULT_AI_TEMPERATURE,
    DEFAULT_USER_AFFILIATION,
    DEFAULT_USER_NAME,
    settings as app_settings,
)


@dataclass(frozen=True)
class ResolvedAIConfig:
    api_key: str
    model: str
    temperature: float
    persona: str
    user_name: str
    affiliation: str


def resolve_ai_config(
    db_settings: Mapping[str, str] | None = None,
    model_override: str | None = None,
    api_key_override: str | None = None,
) -> ResolvedAIConfig:
    """Single place for resolving AI parameters across request, stored settings, and app config."""
    stored = db_settings or {}

    api_key = (
        (api_key_override or "").strip()
        or str(stored.get("gemini_api_key", "")).strip()
        or app_settings.gemini_api_key
    )

    model_raw = (
        (model_override or "").strip()
        or str(stored.get("gemini_model") or "").strip()
        or app_settings.gemini_model
    )
    model = app_settings.gemini_model if model_raw.lower() in ("", "none") else model_raw

    try:
        temperature = float(stored.get("ai_temperature", DEFAULT_AI_TEMPERATURE))
    except (ValueError, TypeError):
        temperature = DEFAULT_AI_TEMPERATURE

    persona = stored.get("ai_persona", DEFAULT_AI_PERSONA)
    user_name = stored.get("user_name", DEFAULT_USER_NAME)
    affiliation = stored.get("user_affiliation", DEFAULT_USER_AFFILIATION)

    return ResolvedAIConfig(
        api_key=api_key,
        model=model,
        temperature=temperature,
        persona=persona,
        user_name=user_name,
        affiliation=affiliation,
    )


def get_dspy_lm(config: ResolvedAIConfig) -> dspy.LM:
    """Create a configured DSPy LM using the resolved Gemini settings."""
    return dspy.LM(
        model=f"gemini/{config.model}",
        api_key=config.api_key,
        temperature=config.temperature,
    )
