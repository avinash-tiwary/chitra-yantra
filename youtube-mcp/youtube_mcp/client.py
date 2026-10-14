"""
Google API Client Service Factories.
Provides authenticated clients for YouTube Data API v3 and YouTube Analytics API v2
with unified error handling and quota diagnosis.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from googleapiclient.discovery import Resource, build
from googleapiclient.errors import HttpError

from youtube_mcp.auth import get_credentials

logger = logging.getLogger("youtube_mcp.client")


class YouTubeAPIError(Exception):
    """Normalized API error for client operations."""

    def __init__(self, message: str, status_code: int | None = None, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.details = details or {}


def format_http_error(err: HttpError) -> YouTubeAPIError:
    """Parses Google API HttpError into structured, actionable feedback."""
    status_code = err.resp.status
    try:
        content = json.loads(err.content.decode("utf-8"))
        error_info = content.get("error", {})
        message = error_info.get("message", str(err))
        errors = error_info.get("errors", [])

        reasons = [e.get("reason", "") for e in errors]
        if "quotaExceeded" in reasons:
            message = (
                "YouTube API Quota Exceeded (HTTP 403). The daily quota (10,000 units) has been consumed. "
                "Resets at midnight Pacific Time. Details: " + message
            )
        elif "forbidden" in reasons:
            message = f"Permission Denied (HTTP 403). Ensure your OAuth account has manager/owner access to the channel: {message}"
        elif status_code == 404:
            message = f"Resource Not Found (HTTP 404): {message}"

        return YouTubeAPIError(message=message, status_code=status_code, details=error_info)
    except (json.JSONDecodeError, KeyError, UnicodeDecodeError, AttributeError):
        return YouTubeAPIError(message=str(err), status_code=status_code)


def get_youtube_data_service() -> Resource:
    """Constructs and returns an authenticated YouTube Data API v3 service."""
    creds = get_credentials(interactive_if_missing=False)
    try:
        return build("youtube", "v3", credentials=creds, cache_discovery=False)
    except HttpError as e:
        raise format_http_error(e) from e


def get_youtube_analytics_service() -> Resource:
    """Constructs and returns an authenticated YouTube Analytics API v2 service."""
    creds = get_credentials(interactive_if_missing=False)
    try:
        return build("youtubeAnalytics", "v2", credentials=creds, cache_discovery=False)
    except HttpError as e:
        raise format_http_error(e) from e


def get_channel_overview() -> dict[str, Any]:
    """
    Fetches the authenticated user's primary YouTube channel metadata and statistics.
    Useful for health checks and confirming channel binding.
    """
    service = get_youtube_data_service()
    try:
        response = service.channels().list(part="snippet,statistics,contentDetails", mine=True).execute()

        items = response.get("items", [])
        if not items:
            return {"error": "No channel found for the authenticated Google account."}

        channel = items[0]
        snippet = channel.get("snippet", {})
        stats = channel.get("statistics", {})

        return {
            "channel_id": channel.get("id"),
            "title": snippet.get("title"),
            "custom_url": snippet.get("customUrl"),
            "description": snippet.get("description", "")[:200] + "..." if snippet.get("description") else "",
            "published_at": snippet.get("publishedAt"),
            "view_count": stats.get("viewCount"),
            "subscriber_count": stats.get("subscriberCount"),
            "video_count": stats.get("videoCount"),
            "hidden_subscriber_count": stats.get("hiddenSubscriberCount", False),
        }
    except HttpError as e:
        raise format_http_error(e) from e
