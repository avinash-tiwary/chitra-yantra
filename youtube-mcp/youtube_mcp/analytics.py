"""
YouTube Analytics API v2 Query Engine & Data Normalizer.
Extracts watch time, engagement, audience retention curves, and traffic source insights.
"""

from __future__ import annotations

import datetime
from typing import Any

from googleapiclient.errors import HttpError

from youtube_mcp.client import format_http_error, get_youtube_analytics_service

# Friendly labels for YouTube traffic sources
TRAFFIC_SOURCE_MAP = {
    "ADVERTISING": "YouTube Advertising",
    "ANNOTATION": "Annotations / Cards",
    "CAMPAIGN_CARD": "Campaign Cards",
    "END_SCREEN": "End Screens",
    "EXT_URL": "External Websites / Apps",
    "HASHTAGS": "Hashtags",
    "LIVE_REDIRECT": "Live Stream Redirect",
    "NO_LINK_EMBEDDED": "Embedded Players",
    "NO_LINK_OTHER": "Direct / Unknown",
    "NOTIFICATION": "YouTube Notifications",
    "PLAYLIST": "Playlists",
    "PROMOTED": "Promoted Content",
    "RELATED_VIDEO": "Suggested / Related Videos",
    "SHORTS": "YouTube Shorts Feed",
    "SUBSCRIBER": "Subscription Feed / Channel Page",
    "YT_CHANNEL": "YouTube Channel Pages",
    "YT_OTHER_PAGE": "Other YouTube Features",
    "YT_SEARCH": "YouTube Search",
}


def parse_date_string(date_str: str) -> str:
    """
    Normalizes relative dates (e.g. 'today', 'yesterday', '7daysAgo', '30daysAgo')
    or validates YYYY-MM-DD formatted strings.
    """
    clean = date_str.strip().lower()
    today = datetime.date.today()

    if clean in ("today", "now"):
        # YouTube Analytics data usually has a 24-48h delay, but API accepts current date
        return today.isoformat()
    if clean == "yesterday":
        return (today - datetime.timedelta(days=1)).isoformat()
    if clean.endswith("daysago"):
        try:
            days = int(clean.replace("daysago", ""))
            return (today - datetime.timedelta(days=days)).isoformat()
        except ValueError:
            pass

    # Validate standard ISO date
    try:
        datetime.date.fromisoformat(date_str)
        return date_str
    except ValueError:
        raise ValueError(
            f"Invalid date format '{date_str}'. Expected 'YYYY-MM-DD' or relative like '7daysAgo', '30daysAgo', 'today'."
        ) from None


def get_video_analytics(
    video_id: str, start_date: str = "30daysAgo", end_date: str = "today"
) -> dict[str, Any]:
    """
    Queries YouTube Analytics API v2 for core performance metrics of a specific video.
    """
    service = get_youtube_analytics_service()
    start = parse_date_string(start_date)
    end = parse_date_string(end_date)

    metrics = (
        "views,estimatedMinutesWatched,averageViewDuration,"
        "averageViewPercentage,subscribersGained,subscribersLost,"
        "likes,comments,shares"
    )

    try:
        response = (
            service.reports()
            .query(
                ids="channel==MINE",
                startDate=start,
                endDate=end,
                metrics=metrics,
                filters=f"video=={video_id}",
            )
            .execute()
        )

        rows = response.get("rows", [])
        headers = [col["name"] for col in response.get("columnHeaders", [])]

        if not rows:
            return {
                "video_id": video_id,
                "period": f"{start} to {end}",
                "views": 0,
                "watch_time_hours": 0.0,
                "message": "No analytics data recorded for this video during the requested period (analytics typically update every 24-48 hours).",
            }

        data = dict(zip(headers, rows[0], strict=False))
        views = int(data.get("views", 0))
        minutes = float(data.get("estimatedMinutesWatched", 0.0))
        avg_dur_sec = float(data.get("averageViewDuration", 0.0))
        avg_pct = float(data.get("averageViewPercentage", 0.0))
        subs_gained = int(data.get("subscribersGained", 0))
        subs_lost = int(data.get("subscribersLost", 0))
        likes = int(data.get("likes", 0))
        comments = int(data.get("comments", 0))
        shares = int(data.get("shares", 0))

        return {
            "video_id": video_id,
            "period": f"{start} to {end}",
            "views": views,
            "watch_time_hours": round(minutes / 60.0, 2),
            "average_view_duration_seconds": round(avg_dur_sec, 1),
            "average_percentage_watched": f"{round(avg_pct, 2)}%",
            "subscribers_gained": subs_gained,
            "subscribers_lost": subs_lost,
            "net_subscribers": subs_gained - subs_lost,
            "engagement": {
                "likes": likes,
                "comments": comments,
                "shares": shares,
            },
        }
    except HttpError as e:
        raise format_http_error(e) from e


def get_channel_performance(
    start_date: str = "30daysAgo", end_date: str = "today", dimension: str = "day"
) -> dict[str, Any]:
    """
    Retrieves channel-wide performance broken down by day, traffic source, or device.
    """
    service = get_youtube_analytics_service()
    start = parse_date_string(start_date)
    end = parse_date_string(end_date)

    valid_dimensions = {
        "day": ("day", "day"),
        "trafficSource": ("insightTrafficSourceType", "-views"),
        "deviceType": ("deviceType", "-views"),
    }

    if dimension not in valid_dimensions:
        raise ValueError(f"Dimension must be one of {list(valid_dimensions.keys())}")

    dim_param, sort_param = valid_dimensions[dimension]
    metrics = (
        "views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost,likes,comments"
    )

    try:
        response = (
            service.reports()
            .query(
                ids="channel==MINE",
                startDate=start,
                endDate=end,
                metrics=metrics,
                dimensions=dim_param,
                sort=sort_param,
            )
            .execute()
        )

        headers = [col["name"] for col in response.get("columnHeaders", [])]
        rows = response.get("rows", [])

        formatted_rows: list[dict[str, Any]] = []
        total_views = 0
        total_minutes = 0.0

        for row in rows:
            row_dict = dict(zip(headers, row, strict=False))
            v = int(row_dict.get("views", 0))
            m = float(row_dict.get("estimatedMinutesWatched", 0.0))
            total_views += v
            total_minutes += m

            dim_val = row_dict.get(dim_param, "Unknown")
            if dimension == "trafficSource":
                dim_val = TRAFFIC_SOURCE_MAP.get(str(dim_val), str(dim_val))

            formatted_rows.append(
                {
                    dimension: dim_val,
                    "views": v,
                    "watch_time_hours": round(m / 60.0, 2),
                    "avg_duration_sec": round(float(row_dict.get("averageViewDuration", 0.0)), 1),
                    "net_subscribers": int(row_dict.get("subscribersGained", 0))
                    - int(row_dict.get("subscribersLost", 0)),
                    "likes": int(row_dict.get("likes", 0)),
                    "comments": int(row_dict.get("comments", 0)),
                }
            )

        return {
            "period": f"{start} to {end}",
            "dimension": dimension,
            "total_views": total_views,
            "total_watch_time_hours": round(total_minutes / 60.0, 2),
            "breakdown": formatted_rows,
        }
    except HttpError as e:
        raise format_http_error(e) from e


def get_audience_retention(video_id: str) -> dict[str, Any]:
    """
    Fetches the audience retention curve for a video.
    Returns the watch ratio across time checkpoints (0.0 to 1.0 of the video length),
    allowing agents to identify where viewers drop off.
    """
    service = get_youtube_analytics_service()

    # YouTube Retention API requires a broad date range (e.g. from published to today)
    start = "2020-01-01"
    end = datetime.date.today().isoformat()

    try:
        response = (
            service.reports()
            .query(
                ids="channel==MINE",
                startDate=start,
                endDate=end,
                metrics="audienceWatchRatio,relativeRetentionPerformance",
                dimensions="elapsedVideoTimeRatio",
                filters=f"video=={video_id}",
            )
            .execute()
        )

        headers = [col["name"] for col in response.get("columnHeaders", [])]
        rows = response.get("rows", [])

        if not rows:
            return {
                "video_id": video_id,
                "message": "Audience retention data is not yet available for this video (requires minimum view threshold and 24-48h processing).",
            }

        curve: list[dict[str, Any]] = []
        for r in rows:
            item = dict(zip(headers, r, strict=False))
            ratio = float(item.get("elapsedVideoTimeRatio", 0.0))
            watch_ratio = float(item.get("audienceWatchRatio", 0.0))
            curve.append(
                {
                    "video_percentage": f"{int(ratio * 100)}%",
                    "audience_watch_ratio": round(watch_ratio, 4),
                    "retention_percentage": f"{round(watch_ratio * 100, 1)}%",
                }
            )

        return {
            "video_id": video_id,
            "checkpoints_count": len(curve),
            "retention_curve": curve,
        }
    except HttpError as e:
        raise format_http_error(e) from e
