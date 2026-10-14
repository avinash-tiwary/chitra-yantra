"""
Starlette Application for the YouTube Creator Studio & Analytics Dashboard.
Serves interactive frontend and JSON endpoints querying YouTube Data API v3 and Analytics API v2.
"""

from __future__ import annotations

from pathlib import Path

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse
from starlette.routing import Route

from youtube_mcp.analytics import get_audience_retention, get_channel_performance
from youtube_mcp.auth import CredentialsMissingError, TokenMissingError
from youtube_mcp.client import YouTubeAPIError, get_channel_overview
from youtube_mcp.upload import list_recent_videos

TEMPLATE_FILE = Path(__file__).parent / "template.html"


async def dashboard_index(request: Request) -> HTMLResponse:
    """Renders the single-page creator dashboard."""
    if not TEMPLATE_FILE.is_file():
        return HTMLResponse("<h1>Dashboard template not found</h1>", status_code=500)
    content = TEMPLATE_FILE.read_text(encoding="utf-8")
    return HTMLResponse(content)


async def api_channel_overview(request: Request) -> JSONResponse:
    """Returns the authenticated channel's high-level metadata and KPIs."""
    try:
        overview = get_channel_overview()
        return JSONResponse(overview)
    except (TokenMissingError, CredentialsMissingError) as error:
        return JSONResponse({"error": str(error)}, status_code=401)
    except YouTubeAPIError as error:
        return JSONResponse({"error": str(error)}, status_code=error.status_code or 502)
    except Exception as error:
        return JSONResponse({"error": str(error)}, status_code=502)


async def api_channel_analytics(request: Request) -> JSONResponse:
    """Returns time-series analytics and traffic source data for the requested period."""
    period_param = request.query_params.get("period", "28d")
    period_map = {
        "7d": "7daysAgo",
        "28d": "28daysAgo",
        "30d": "30daysAgo",
        "90d": "90daysAgo",
    }
    start_date = period_map.get(period_param, "28daysAgo")

    try:
        data = get_channel_performance(start_date=start_date, end_date="today", dimension="day")
        return JSONResponse(data)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


async def api_channel_videos(request: Request) -> JSONResponse:
    """Returns recent videos from the channel."""
    try:
        videos = list_recent_videos(max_results=50)
        return JSONResponse(videos)
    except Exception:
        return JSONResponse([], status_code=200)


async def api_retention(request: Request) -> JSONResponse:
    """Returns audience retention curve for a video."""
    video_id = request.query_params.get("video_id")
    if not video_id:
        return JSONResponse({"error": "Missing video_id parameter"}, status_code=400)
    try:
        data = get_audience_retention(video_id=video_id)
        return JSONResponse(data)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


async def api_health(request: Request) -> JSONResponse:
    """Simple healthcheck endpoint."""
    return JSONResponse({"status": "healthy", "service": "youtube-mcp-dashboard"})


routes = [
    Route("/", endpoint=dashboard_index, methods=["GET"]),
    Route("/api/overview", endpoint=api_channel_overview, methods=["GET"]),
    Route("/api/analytics", endpoint=api_channel_analytics, methods=["GET"]),
    Route("/api/videos", endpoint=api_channel_videos, methods=["GET"]),
    Route("/api/retention", endpoint=api_retention, methods=["GET"]),
    Route("/health", endpoint=api_health, methods=["GET"]),
]

app = Starlette(debug=False, routes=routes)
