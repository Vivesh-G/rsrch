"""Config tests: single-load frozen settings, env > .config precedence."""

import dataclasses
import importlib
from pathlib import Path

import pytest

import config


@pytest.fixture
def fresh_config(monkeypatch):
    """Reload config with extra env applied; restore defaults afterwards."""
    def _load(**env):
        for key, value in env.items():
            monkeypatch.setenv(key, value)
        return importlib.reload(config)

    yield _load
    importlib.reload(config)


def test_settings_is_frozen():
    with pytest.raises(dataclasses.FrozenInstanceError):
        config.settings.max_upload_bytes = 1


def test_file_defaults_loaded_from_dotconfig():
    assert config._FILE_DEFAULTS["MAX_UPLOAD_MB"] == "50"
    assert config._FILE_DEFAULTS["CHAT_HISTORY_LIMIT"] == "20"


def test_env_overrides_dotconfig(fresh_config):
    reloaded = fresh_config(CHAT_HISTORY_LIMIT="99")
    assert reloaded.settings.chat_history_limit == 99


def test_dotconfig_value_used_when_no_env(fresh_config, monkeypatch):
    monkeypatch.delenv("CHAT_HISTORY_LIMIT", raising=False)
    reloaded = fresh_config()
    assert reloaded.settings.chat_history_limit == 20


def test_invalid_env_falls_back_to_default(fresh_config):
    reloaded = fresh_config(MAX_UPLOAD_MB="not-a-number")
    assert reloaded.settings.max_upload_bytes == 50 * 1024 * 1024


def test_data_dir_override(fresh_config):
    reloaded = fresh_config(RSRCH_DATA_DIR="/tmp/rsrch-custom-data")
    assert reloaded.settings.data_dir == Path("/tmp/rsrch-custom-data")
    assert str(reloaded.settings.db_path).endswith("rschr.db")
