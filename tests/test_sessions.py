from __future__ import annotations

import fakeredis
import pytest
from fastapi.testclient import TestClient

from app.main import app, get_redis


@pytest.fixture()
def client() -> TestClient:
    fake = fakeredis.FakeRedis(decode_responses=True)
    app.dependency_overrides[get_redis] = lambda: fake
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


def test_create_and_read_session(client: TestClient) -> None:
    created = client.post("/sessions", json={"user": "ada"})
    assert created.status_code == 201
    token = created.json()["token"]

    fetched = client.get(f"/sessions/{token}")
    assert fetched.status_code == 200
    assert fetched.json() == {"user": "ada"}


def test_session_token_has_ttl(client: TestClient) -> None:
    token = client.post("/sessions", json={"user": "ada"}).json()["token"]
    fake = app.dependency_overrides[get_redis]()
    assert fake.ttl(f"session:{token}") > 0


def test_unknown_session_is_404(client: TestClient) -> None:
    assert client.get("/sessions/nope").status_code == 404


def test_delete_session(client: TestClient) -> None:
    token = client.post("/sessions", json={"user": "ada"}).json()["token"]
    assert client.delete(f"/sessions/{token}").status_code == 204
    assert client.get(f"/sessions/{token}").status_code == 404


def test_empty_user_rejected(client: TestClient) -> None:
    assert client.post("/sessions", json={"user": "  "}).status_code == 400
