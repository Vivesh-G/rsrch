"""Central application configuration — single load, frozen for process lifetime.

Single source of truth for env + file config. Loaded exactly ONCE at import:
  1. load_dotenv(backend/.env) — one call. Local secrets/overrides, git-ignored.
  2. Read backend/.config (INI, [rsrch]) — one parse. Committed defaults.
  3. Precedence per key: real OS env > .env > .config > built-in default.
     Values are snapshotted into the Settings object below — no reloading.
  4. `settings` is a frozen dataclass — attribute assignment raises,
     so runtime code cannot mutate/reload config until process restart.

No other module may call load_dotenv, os.getenv (for tuned values), or
re-parse .config at request time — import `settings` instead.

Bundling note (executables): all writable/readonly locations come from
here. Override via env when frozen (PyInstaller/onefile):
  RSRCH_DATA_DIR  -> where rsChr.db / pdfs / latex_* live
  RSRCH_DIST_DIR  -> where the built frontend (dist/) lives
Otherwise defaults resolve relative to this file in dev, and relative
to sys.executable (+ sys._MEIPASS for read-only assets) when frozen.
"""

from __future__ import annotations

import configparser
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv


def _backend_dir() -> Path:
    return Path(__file__).resolve().parent


def _is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


# The ONE dotenv load + ONE .config parse in the whole backend.
_BACKEND_ENV = _backend_dir() / ".env"
load_dotenv(_BACKEND_ENV, override=False)

_FILE_DEFAULTS: dict[str, str] = {}


def _load_file_defaults() -> dict[str, str]:
    path = _backend_dir() / ".config"
    parser = configparser.ConfigParser()
    parser.optionxform = lambda optionstr: optionstr  # keep KEY case (MAX_UPLOAD_MB, not max_upload_mb)
    try:
        if path.is_file():
            parser.read(path, encoding="utf-8")
            if parser.has_section("rsrch"):
                return dict(parser.items("rsrch"))
    except (configparser.Error, OSError):
        pass
    return {}


_FILE_DEFAULTS = _load_file_defaults()


def _raw(name: str, default: str) -> str:
    """os.environ (OS env + .env) wins; then .config; then built-in default."""
    value = os.environ.get(name)
    if value is not None and value != "":
        return value
    value = _FILE_DEFAULTS.get(name)
    if value is not None and value.strip() != "":
        return value
    return default


def _get_int(name: str, default: int) -> int:
    try:
        return int(_raw(name, str(default)).strip())
    except (TypeError, ValueError):
        return default


def _get_str(name: str, default: str) -> str:
    value = _raw(name, default)
    return value if isinstance(value, str) and value else default


def _get_csv(name: str, default: str) -> tuple[str, ...]:
    raw = _raw(name, default)
    return tuple(part.strip() for part in raw.split(",") if part.strip())


def _data_dir() -> Path:
    override = _raw("RSRCH_DATA_DIR", "").strip()
    if override:
        return Path(override).expanduser()
    if _is_frozen():
        # Writable sibling of the exe: <exe-dir>/data
        return Path(sys.executable).resolve().parent / "data"
    return _backend_dir() / "data"


def _dist_dir() -> Path:
    override = _raw("RSRCH_DIST_DIR", "").strip()
    if override:
        return Path(override).expanduser()
    if _is_frozen():
        # PyInstaller onefile extracts static assets to _MEIPASS.
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            bundled = Path(meipass) / "dist"
            if bundled.is_dir():
                return bundled
        return Path(sys.executable).resolve().parent / "dist"
    return _backend_dir().parent / "dist"


_DATA_DIR = _data_dir()
_DIST_DIR = _dist_dir()


@dataclass(frozen=True)
class Settings:
    """Frozen process-wide config. Constructed once; never reloaded."""

    # --- Upload / extraction / chat bounds ---
    max_upload_bytes: int = field(
        default_factory=lambda: _get_int("MAX_UPLOAD_MB", 50) * 1024 * 1024
    )
    max_extracted_chars: int = field(
        default_factory=lambda: _get_int("MAX_EXTRACTED_CHARS", 200_000)
    )
    chat_context_chars: int = field(
        default_factory=lambda: _get_int("CHAT_CONTEXT_CHARS", 30_000)
    )
    chat_history_limit: int = field(
        default_factory=lambda: _get_int("CHAT_HISTORY_LIMIT", 20)
    )
    chat_timeout_s: float = field(
        default_factory=lambda: float(_get_int("CHAT_TIMEOUT_S", 90))
    )
    chat_rate_limit: int = field(
        default_factory=lambda: _get_int("CHAT_RATE_LIMIT", 20)
    )
    chat_rate_window_s: float = field(
        default_factory=lambda: float(_get_int("CHAT_RATE_WINDOW_S", 60))
    )
    gemini_model: str = field(
        default_factory=lambda: _get_str("GEMINI_MODEL", "gemini-3.5-flash-lite")
    )

    # --- LaTeX build cache bounds ---
    latex_max_builds_per_doc: int = field(
        default_factory=lambda: _get_int("LATEX_MAX_BUILDS_PER_DOC", 3)
    )
    latex_max_total_builds: int = field(
        default_factory=lambda: _get_int("LATEX_MAX_TOTAL_BUILDS", 100)
    )
    latex_max_total_bytes: int = field(
        default_factory=lambda: _get_int("LATEX_MAX_TOTAL_MB", 500) * 1024 * 1024
    )

    # --- HTTP ---
    cors_origins: tuple[str, ...] = field(
        default_factory=lambda: _get_csv(
            "CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
        )
    )

    # --- Paths (single place for exe bundling) ---
    backend_dir: Path = field(default_factory=_backend_dir)
    data_dir: Path = field(default=_DATA_DIR)
    dist_dir: Path = field(default=_DIST_DIR)

    @property
    def db_path(self) -> Path:
        return self.data_dir / "rschr.db"

    @property
    def pdf_dir(self) -> Path:
        return self.data_dir / "pdfs"

    @property
    def latex_builds_dir(self) -> Path:
        return self.data_dir / "latex_builds"

    @property
    def latex_temp_dir(self) -> Path:
        return self.data_dir / "latex_temp"

    @property
    def frontend_assets_dir(self) -> Path:
        return self.dist_dir / "assets"

    @property
    def frontend_index(self) -> Path:
        return self.dist_dir / "index.html"

    def ensure_dirs(self) -> None:
        """Create writable dirs once at startup. Call from lifespan, not per-request."""
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.pdf_dir.mkdir(parents=True, exist_ok=True)


# The singleton. Import this; never re-instantiate or mutate.
settings = Settings()
