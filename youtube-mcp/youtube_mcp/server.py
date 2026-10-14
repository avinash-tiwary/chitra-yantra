"""
YouTube MCP Server - Main FastMCP entrypoint and registered tools.
Exposes YouTube Studio and Analytics operations to AI agents via the Model Context Protocol.
"""

from __future__ import annotations

import argparse
import sys
from typing import Any

from dotenv import load_dotenv
from rich.console import Console

# Support both MCP 2.x (MCPServer) and MCP 1.x (FastMCP) seamlessly
try:
    from mcp.server.mcpserver import MCPServer as FastMCP
except ImportError:
    from mcp.server.fastmcp import FastMCP  # type: ignore[no-redef]

from youtube_mcp.analytics import (
    get_audience_retention,
    get_channel_performance,
    get_video_analytics,
)
from youtube_mcp.auth import (
    CredentialsMissingError,
    TokenMissingError,
    get_credentials,
    resolve_client_secret_path,
    resolve_token_path,
)
from youtube_mcp.client import YouTubeAPIError, get_channel_overview
from youtube_mcp.upload import (
    get_video_details,
    list_recent_videos,
    set_video_thumbnail,
    update_video_metadata,
    upload_video_file,
)

# Load environment configuration from .env if present
load_dotenv()

# Initialize FastMCP Server
mcp = FastMCP(
    name="youtube-mcp",
    instructions=(
        "Production-grade YouTube MCP Server. "
        "Allows AI agents to upload videos, manage thumbnails and metadata, "
        "and pull YouTube Analytics reports (views, watch time, retention, traffic sources). "
        "Respects YouTube API quota limits (10,000 units/day free allowance)."
    ),
)


# ==============================================================================
# Domain A: Studio & Publishing Tools
# ==============================================================================


@mcp.tool()
def youtube_get_channel_overview() -> dict[str, Any]:
    """
    Returns high-level information and current statistics for the connected YouTube channel.
    Useful for health checks and confirming which channel the agent is currently operating on.

    Quota Cost: 1 unit.
    """
    try:
        return get_channel_overview()
    except (TokenMissingError, CredentialsMissingError, YouTubeAPIError) as err:
        return {"success": False, "error": str(err)}


@mcp.tool()
def youtube_upload_video(
    file_path: str,
    title: str,
    description: str,
    tags: list[str] | None = None,
    category_id: str = "27",
    privacy_status: str = "private",
    publish_at: str | None = None,
    made_for_kids: bool = False,
    thumbnail_path: str | None = None,
) -> dict[str, Any]:
    """
    Uploads a video to YouTube with full metadata, optional scheduled publishing, and optional custom thumbnail.

    Safety:
      - Default privacy_status is 'private' to prevent unintended public publishing.
      - If 'publish_at' is provided (ISO 8601 UTC string like '2026-09-20T10:00:00Z'),
        privacyStatus is automatically set to 'private' until the scheduled time.

    Quota Cost:
      - Video upload: 1,600 units (Daily free allowance is 10,000 units).
      - Setting thumbnail (if thumbnail_path provided): 50 units.
    """
    try:
        return upload_video_file(
            file_path=file_path,
            title=title,
            description=description,
            tags=tags,
            category_id=category_id,
            privacy_status=privacy_status,
            publish_at=publish_at,
            made_for_kids=made_for_kids,
            thumbnail_path=thumbnail_path,
        )
    except (FileNotFoundError, ValueError, TokenMissingError, YouTubeAPIError, RuntimeError) as err:
        return {"success": False, "error": str(err)}


@mcp.tool()
def youtube_set_thumbnail(video_id: str, thumbnail_path: str) -> dict[str, Any]:
    """
    Uploads and assigns a custom thumbnail image (JPEG/PNG, max 2MB) to an existing YouTube video.

    Quota Cost: 50 units.
    """
    try:
        return set_video_thumbnail(video_id=video_id, thumbnail_path=thumbnail_path)
    except (FileNotFoundError, TokenMissingError, YouTubeAPIError) as err:
        return {"success": False, "error": str(err)}


@mcp.tool()
def youtube_update_video(
    video_id: str,
    title: str | None = None,
    description: str | None = None,
    tags: list[str] | None = None,
    category_id: str | None = None,
    privacy_status: str | None = None,
) -> dict[str, Any]:
    """
    Updates metadata or privacy status for an existing YouTube video.
    Only provided fields are changed; existing unmentioned fields are preserved.

    Quota Cost: 50 units.
    """
    try:
        return update_video_metadata(
            video_id=video_id,
            title=title,
            description=description,
            tags=tags,
            category_id=category_id,
            privacy_status=privacy_status,
        )
    except (ValueError, TokenMissingError, YouTubeAPIError) as err:
        return {"success": False, "error": str(err)}


@mcp.tool()
def youtube_list_videos(max_results: int = 10, privacy_filter: str | None = None) -> list[dict[str, Any]]:
    """
    Lists recent video uploads from the channel along with view counts, like counts, and privacy status.
    Uses the channel's Uploads playlist for maximum quota efficiency.

    Quota Cost: ~2 units (compared to 100 units with standard search).
    """
    try:
        return list_recent_videos(max_results=max_results, privacy_filter=privacy_filter)
    except (TokenMissingError, YouTubeAPIError) as err:
        return [{"error": str(err)}]


@mcp.tool()
def youtube_get_video_details(video_id: str) -> dict[str, Any]:
    """
    Retrieves complete metadata, status, duration, and statistics for a specific video ID.

    Quota Cost: 1 unit.
    """
    try:
        return get_video_details(video_id=video_id)
    except (TokenMissingError, YouTubeAPIError) as err:
        return {"error": str(err)}


# ==============================================================================
# Domain B: Analytics & Channel Intelligence Tools
# ==============================================================================


@mcp.tool()
def youtube_get_video_analytics(
    video_id: str, start_date: str = "30daysAgo", end_date: str = "today"
) -> dict[str, Any]:
    """
    Pulls core performance metrics for a specific video via YouTube Analytics API v2.
    Includes views, watch time (hours), average view duration, percentage watched,
    subscribers gained/lost, and engagement metrics (likes, comments, shares).

    Dates can be 'YYYY-MM-DD' or relative like '7daysAgo', '30daysAgo', 'today'.
    Note: YouTube Analytics updates on a 24-48 hour delay.
    """
    try:
        return get_video_analytics(video_id=video_id, start_date=start_date, end_date=end_date)
    except (ValueError, TokenMissingError, YouTubeAPIError) as err:
        return {"error": str(err)}


@mcp.tool()
def youtube_get_channel_performance(
    start_date: str = "30daysAgo", end_date: str = "today", dimension: str = "day"
) -> dict[str, Any]:
    """
    Retrieves channel-wide performance metrics broken down by dimension.

    Supported dimensions:
      - 'day': Daily time-series of views, watch time, and subscriber growth.
      - 'trafficSource': Breakdown of discovery sources (Search, Suggested, External, Browse).
      - 'deviceType': Breakdown of views by device (Mobile, Desktop, TV, Tablet).
    """
    try:
        return get_channel_performance(start_date=start_date, end_date=end_date, dimension=dimension)
    except (ValueError, TokenMissingError, YouTubeAPIError) as err:
        return {"error": str(err)}


@mcp.tool()
def youtube_get_retention_curve(video_id: str) -> dict[str, Any]:
    """
    Retrieves the audience retention curve across the length of a video.
    Returns watch ratio at 100 normalized checkpoints from start to finish,
    enabling agents to pinpoint exact moments where viewer interest drops off.
    """
    try:
        return get_audience_retention(video_id=video_id)
    except (TokenMissingError, YouTubeAPIError) as err:
        return {"error": str(err)}


# ==============================================================================
# Domain C: Creator Dashboard Tool
# ==============================================================================


@mcp.tool()
def youtube_launch_dashboard(port: int = 8501, auto_open: bool = True) -> dict[str, Any]:
    """
    Launches the interactive browser-based YouTube Creator Studio & Analytics Dashboard.
    Provides a visual dashboard showing real-time channel stats, YPP monetization milestones,
    interactive view/watch-time charts, traffic sources, audience retention curves,
    and a video SEO previewer.

    Returns the URL where the dashboard is running.
    """
    from youtube_mcp.dashboard.runner import launch_dashboard_in_background

    try:
        url = launch_dashboard_in_background(port=port, auto_open=auto_open)
        return {
            "success": True,
            "url": url,
            "message": f"Creator Dashboard active at {url}. Opened in default browser."
            if auto_open
            else f"Creator Dashboard active at {url}.",
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


# ==============================================================================
# CLI Entrypoint & Runner
# ==============================================================================


def main() -> None:
    """CLI entrypoint for running the YouTube MCP server or performing setup."""
    parser = argparse.ArgumentParser(description="YouTube MCP Server")
    parser.add_argument(
        "--auth",
        action="store_true",
        help="Run interactive one-time Google OAuth authorization in your browser.",
    )
    parser.add_argument(
        "--dashboard",
        action="store_true",
        help="Launch the interactive browser-based Creator Studio & Analytics Dashboard.",
    )
    parser.add_argument(
        "--transport",
        choices=["stdio", "sse"],
        default="stdio",
        help="MCP transport to run (default: stdio).",
    )
    parser.add_argument(
        "--port", type=int, default=8000, help="Port for SSE transport or Dashboard (default: 8000/8501)."
    )

    args = parser.parse_args()
    console = Console()

    if args.auth:
        console.print("[bold cyan]YouTube MCP - One-Time Authorization Setup[/bold cyan]")
        try:
            secret_file = resolve_client_secret_path()
            console.print(f"[green]Found client secret at:[/green] {secret_file}")
            console.print("[yellow]Launching browser for Google OAuth consent...[/yellow]")
            get_credentials(interactive_if_missing=True)
            console.print(
                f"[bold green]Authorization successful![/bold green] Token saved to: {resolve_token_path()}"
            )
            sys.exit(0)
        except Exception as e:
            console.print(f"[bold red]Authorization failed:[/bold red] {e}")
            sys.exit(1)

    if args.dashboard:
        from youtube_mcp.dashboard.runner import run_dashboard

        dashboard_port = args.port if args.port != 8000 else 8501
        run_dashboard(port=dashboard_port, auto_open=True)
        return

    # Run FastMCP server
    if args.transport == "sse":
        mcp.run(transport="sse")
    else:
        mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
