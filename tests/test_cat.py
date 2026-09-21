from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_index_has_dispense_button() -> None:
    response = client.get("/")
    assert response.status_code == 200
    assert "Dispense cat" in response.text


def test_cat_redirects_to_random_cat_image() -> None:
    response = client.get("/cat", follow_redirects=False)
    assert response.status_code in (302, 307)
    assert response.headers["location"].startswith("https://cataas.com/cat")
