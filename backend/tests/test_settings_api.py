"""Settings API endpoint tests (isolated from host .env and DB)."""

import dataclasses

import pytest
from httpx import ASGITransport, AsyncClient

import ai.config as ai_config
import database
import server


@pytest.fixture
async def async_client(tmp_path, monkeypatch):
    monkeypatch.setattr(database, "DB_PATH", str(tmp_path / "test_settings.db"))
    monkeypatch.setattr(
        ai_config,
        "app_settings",
        dataclasses.replace(
            ai_config.app_settings,
            gemini_api_key="",
            gemini_model="gemini-3.5-flash-lite",
        ),
    )
    await database.init_db()
    transport = ASGITransport(app=server.app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


async def test_get_settings_defaults(async_client):
    res = await async_client.get("/api/settings")
    assert res.status_code == 200
    data = res.json()
    assert data["user_name"] == "Researcher"
    assert data["gemini_model"] == "gemini-3.5-flash-lite"
    assert data["gemini_api_key_set"] is False
    assert data["gemini_api_key_masked"] == ""


async def test_update_settings_and_readback(async_client):
    update_payload = {
        "user_name": "Dr. Katherine Johnson",
        "user_affiliation": "NASA Langley",
        "gemini_model": "gemini-3.5-flash",
        "gemini_api_key": "AIzaSyFakeKey1234567890",
        "ai_temperature": 0.3,
        "ai_persona": "pedagogical",
        "auto_compile_delay": 3000,
        "editor_font_size": 15,
        "editor_word_wrap": False,
        "editor_line_numbers": False,
    }
    res = await async_client.put("/api/settings", json=update_payload)
    assert res.status_code == 200
    data = res.json()
    assert data["user_name"] == "Dr. Katherine Johnson"
    assert data["user_affiliation"] == "NASA Langley"
    assert data["gemini_model"] == "gemini-3.5-flash"
    assert data["gemini_api_key_set"] is True
    assert "AIza" in data["gemini_api_key_masked"]
    assert "••••" in data["gemini_api_key_masked"]
    assert data["ai_temperature"] == 0.3
    assert data["ai_persona"] == "pedagogical"
    assert data["auto_compile_delay"] == 3000
    assert data["editor_font_size"] == 15
    assert data["editor_word_wrap"] is False
    assert data["editor_line_numbers"] is False

    # Verify GET returns the same persisted state
    get_res = await async_client.get("/api/settings")
    assert get_res.status_code == 200
    get_data = get_res.json()
    assert get_data == data


async def test_test_key_endpoint_validation_empty_key(async_client):
    res = await async_client.post("/api/settings/test-key", json={"api_key": ""})
    assert res.status_code == 200
    data = res.json()
    assert data["valid"] is False
    assert data["error"] == "No API key provided or configured"
