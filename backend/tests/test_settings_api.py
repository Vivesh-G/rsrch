"""Settings API endpoint tests."""

import pytest
from httpx import ASGITransport, AsyncClient
import database
import server


@pytest.fixture
async def async_client(tmp_path, monkeypatch):
    monkeypatch.setattr(database, "DB_PATH", str(tmp_path / "test_settings.db"))
    await database.init_db()
    transport = ASGITransport(app=server.app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


async def test_get_settings_defaults(async_client):
    res = await async_client.get("/api/settings")
    assert res.status_code == 200
    data = res.json()
    assert data["user_name"] == "Researcher"
    assert "gemini_model" in data
    assert "gemini_api_key_set" in data


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

    # Verify GET returns the same persisted state
    get_res = await async_client.get("/api/settings")
    assert get_res.status_code == 200
    get_data = get_res.json()
    assert get_data["user_name"] == "Dr. Katherine Johnson"
    assert get_data["gemini_api_key_set"] is True


async def test_test_key_endpoint_validation(async_client):
    res = await async_client.post("/api/settings/test-key", json={"api_key": ""})
    assert res.status_code == 200
    data = res.json()
    assert data["valid"] is False


async def test_lazy_table_creation_without_init_db(tmp_path, monkeypatch):
    """Ensure that even if init_db was never called, get and put settings auto-create the table."""
    fresh_db = str(tmp_path / "fresh_no_init.db")
    monkeypatch.setattr(database, "DB_PATH", fresh_db)
    transport = ASGITransport(app=server.app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.get("/api/settings")
        assert res.status_code == 200
        assert res.json()["user_name"] == "Researcher"

        put_res = await ac.put(
            "/api/settings",
            json={
                "gemini_api_key": "test_saved_key_12345",
                "editor_word_wrap": False,
                "editor_line_numbers": False,
            },
        )
        assert put_res.status_code == 200
        put_data = put_res.json()
        assert put_data["gemini_api_key_set"] is True
        assert put_data["editor_word_wrap"] is False
        assert put_data["editor_line_numbers"] is False
