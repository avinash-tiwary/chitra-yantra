"""
Tests for the Creator Studio & Analytics Dashboard Starlette application routes.
"""

from starlette.testclient import TestClient

from youtube_mcp.dashboard import app as dashboard_app

app = dashboard_app.app


def test_dashboard_index_route():
    """Ensures the dashboard index page serves HTML with 200 OK."""
    client = TestClient(app)
    response = client.get("/")
    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]
    assert "YouTube Creator Studio" in response.text
    assert "Mīmāṁsā" in response.text


def test_dashboard_health_endpoint():
    """Ensures /health endpoint returns healthy status."""
    client = TestClient(app)
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data.get("status") == "healthy"


def test_dashboard_retention_missing_param():
    """Ensures /api/retention returns 400 when video_id query param is missing."""
    client = TestClient(app)
    response = client.get("/api/retention")
    assert response.status_code == 400
    data = response.json()
    assert "error" in data


def test_dashboard_overview_endpoint(monkeypatch):
    """Ensures /api/overview returns valid JSON."""
    monkeypatch.setattr(
        dashboard_app,
        "get_channel_overview",
        lambda: {"channel_id": "channel-1", "title": "Mīmāṁsā"},
    )
    client = TestClient(app)
    response = client.get("/api/overview")
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, dict)
    assert data["channel_id"] == "channel-1"


def test_dashboard_overview_dependency_failure(monkeypatch):
    """Unexpected upstream failures are represented as a gateway error."""
    monkeypatch.setattr(
        dashboard_app,
        "get_channel_overview",
        lambda: (_ for _ in ()).throw(RuntimeError("upstream unavailable")),
    )
    response = TestClient(app).get("/api/overview")
    assert response.status_code == 502
    assert response.json() == {"error": "upstream unavailable"}
