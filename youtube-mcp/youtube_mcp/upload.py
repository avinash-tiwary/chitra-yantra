"""
YouTube Video Operations: Resumable Uploads, Metadata Management, and Thumbnails.
Uses YouTube Data API v3 with quota conservation and network fault-tolerance.
"""

from __future__ import annotations

import mimetypes
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from googleapiclient.errors import HttpError
from googleapiclient.http import MediaFileUpload

from youtube_mcp.client import format_http_error, get_youtube_data_service

# 8MB chunk size for resumable uploads
UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024
MAX_RETRIES = 5
RETRIABLE_STATUS_CODES = [500, 502, 503, 504]


def upload_video_file(
    file_path: str | Path,
    title: str,
    description: str,
    tags: list[str] | None = None,
    category_id: str = "27",
    privacy_status: str = "private",
    publish_at: str | None = None,
    made_for_kids: bool = False,
    thumbnail_path: str | Path | None = None,
) -> dict[str, Any]:
    """
    Executes a resumable upload for a video file with metadata and optional thumbnail.

    Quota cost:
      - Video upload (videos.insert): 1,600 units
      - Thumbnail set (thumbnails.set): 50 units (if thumbnail_path is provided)
    """
    path = Path(file_path).expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(f"Video file not found at: {path}")

    # Enforce safe character limits
    clean_title = title.strip()
    clean_desc = description.strip()
    clean_tags = [t.strip() for t in (tags or []) if t.strip()]
    if not clean_title or len(clean_title) > 100:
        raise ValueError("YouTube title must contain 1–100 characters.")
    if not clean_desc or len(clean_desc) > 5000:
        raise ValueError("YouTube description must contain 1–5000 characters.")
    if len(",".join(clean_tags)) > 500:
        raise ValueError("Combined YouTube tags must not exceed 500 characters.")

    # Validate privacy & schedule logic
    allowed_privacy = {"private", "unlisted", "public"}
    if privacy_status not in allowed_privacy:
        raise ValueError(f"Invalid privacy_status '{privacy_status}'. Must be one of {allowed_privacy}.")

    status_body: dict[str, Any] = {
        "privacyStatus": "private" if publish_at else privacy_status,
        "selfDeclaredMadeForKids": made_for_kids,
    }
    if publish_at:
        try:
            scheduled = datetime.fromisoformat(publish_at.replace("Z", "+00:00"))
        except ValueError as err:
            raise ValueError("publish_at must be an ISO 8601 timestamp.") from err
        if scheduled.tzinfo is None or scheduled.astimezone(timezone.utc) <= datetime.now(timezone.utc):
            raise ValueError("publish_at must be a future timezone-aware timestamp.")
        status_body["publishAt"] = publish_at

    body: dict[str, Any] = {
        "snippet": {
            "title": clean_title,
            "description": clean_desc,
            "tags": clean_tags,
            "categoryId": str(category_id),
        },
        "status": status_body,
    }

    # Guess MIME type
    mime_type, _ = mimetypes.guess_type(str(path))
    if not mime_type or not mime_type.startswith("video/"):
        mime_type = "video/mp4"

    media = MediaFileUpload(str(path), mimetype=mime_type, chunksize=UPLOAD_CHUNK_SIZE, resumable=True)

    service = get_youtube_data_service()
    insert_request = service.videos().insert(part="snippet,status", body=body, media_body=media)

    response = None
    retry_count = 0

    while response is None:
        try:
            _chunk_status, response = insert_request.next_chunk()
        except HttpError as err:
            if err.resp.status in RETRIABLE_STATUS_CODES and retry_count < MAX_RETRIES:
                retry_count += 1
                sleep_seconds = 2**retry_count
                time.sleep(sleep_seconds)
                continue
            raise format_http_error(err) from err
        except (OSError, TimeoutError) as err:
            if retry_count < MAX_RETRIES:
                retry_count += 1
                time.sleep(2**retry_count)
                continue
            raise RuntimeError(
                f"Network connection failed during upload after {MAX_RETRIES} retries: {err}"
            ) from err

    video_id = response.get("id")
    if not isinstance(video_id, str) or not video_id:
        raise RuntimeError("YouTube completed the upload request without returning a video ID.")
    video_url = f"https://youtu.be/{video_id}"

    # Handle custom thumbnail upload if specified
    thumbnail_result = None
    if thumbnail_path and video_id:
        try:
            thumbnail_result = set_video_thumbnail(video_id=video_id, thumbnail_path=thumbnail_path)
        except (HttpError, OSError, ValueError) as e:
            thumbnail_result = {"error": f"Video uploaded successfully, but setting thumbnail failed: {e}"}

    return {
        "success": True,
        "video_id": video_id,
        "url": video_url,
        "title": clean_title,
        "privacy_status": status_body.get("privacyStatus"),
        "publish_at": publish_at,
        "thumbnail_status": thumbnail_result,
        "quota_cost": 1650 if thumbnail_path else 1600,
    }


def set_video_thumbnail(video_id: str, thumbnail_path: str | Path) -> dict[str, Any]:
    """
    Uploads and associates a custom thumbnail with a YouTube video.
    Quota cost: 50 units.
    """
    thumb = Path(thumbnail_path).expanduser().resolve()
    if not thumb.is_file():
        raise FileNotFoundError(f"Thumbnail image not found at: {thumb}")
    if thumb.stat().st_size > 2 * 1024 * 1024:
        raise ValueError("YouTube thumbnails must not exceed 2 MB.")

    mime_type, _ = mimetypes.guess_type(str(thumb))
    if mime_type not in {"image/jpeg", "image/png"}:
        raise ValueError("YouTube thumbnails must be JPEG or PNG images.")

    service = get_youtube_data_service()
    try:
        response = (
            service.thumbnails()
            .set(videoId=video_id, media_body=MediaFileUpload(str(thumb), mimetype=mime_type))
            .execute()
        )

        return {
            "success": True,
            "video_id": video_id,
            "thumbnail_url": response.get("items", [{}])[0].get("default", {}).get("url")
            if response.get("items")
            else None,
            "quota_cost": 50,
        }
    except HttpError as e:
        raise format_http_error(e) from e


def update_video_metadata(
    video_id: str,
    title: str | None = None,
    description: str | None = None,
    tags: list[str] | None = None,
    category_id: str | None = None,
    privacy_status: str | None = None,
) -> dict[str, Any]:
    """
    Updates the snippet or status of an existing YouTube video.
    Quota cost: 50 units (videos.update).
    """
    service = get_youtube_data_service()

    # Step 1: Fetch existing snippet and status to preserve unchanged fields
    try:
        existing = service.videos().list(part="snippet,status", id=video_id).execute()
        items = existing.get("items", [])
        if not items:
            raise ValueError(f"No video found with ID '{video_id}'.")

        video = items[0]
        snippet = video.get("snippet", {})
        status = video.get("status", {})

        if title is not None:
            clean_title = title.strip()
            if not clean_title or len(clean_title) > 100:
                raise ValueError("YouTube title must contain 1–100 characters.")
            snippet["title"] = clean_title
        if description is not None:
            clean_description = description.strip()
            if not clean_description or len(clean_description) > 5000:
                raise ValueError("YouTube description must contain 1–5000 characters.")
            snippet["description"] = clean_description
        if tags is not None:
            clean_tags = [t.strip() for t in tags if t.strip()]
            if len(",".join(clean_tags)) > 500:
                raise ValueError("Combined YouTube tags must not exceed 500 characters.")
            snippet["tags"] = clean_tags
        if category_id is not None:
            snippet["categoryId"] = str(category_id)
        if privacy_status is not None:
            if privacy_status not in {"private", "unlisted", "public"}:
                raise ValueError("Invalid YouTube privacy status.")
            status["privacyStatus"] = privacy_status

        response = (
            service.videos()
            .update(
                part="snippet,status",
                body={
                    "id": video_id,
                    "snippet": snippet,
                    "status": status,
                },
            )
            .execute()
        )

        return {
            "success": True,
            "video_id": video_id,
            "title": response.get("snippet", {}).get("title"),
            "privacy_status": response.get("status", {}).get("privacyStatus"),
            "quota_cost": 50,
        }
    except HttpError as e:
        raise format_http_error(e) from e


def list_recent_videos(max_results: int = 10, privacy_filter: str | None = None) -> list[dict[str, Any]]:
    """
    Lists recently uploaded videos using the Channel Uploads Playlist.
    Quota efficient: Only consumes ~2 units instead of 100 units from search.list!
    """
    service = get_youtube_data_service()
    try:
        # Step 1: Get Uploads Playlist ID
        channels = service.channels().list(mine=True, part="contentDetails").execute()
        items = channels.get("items", [])
        if not items:
            return []
        uploads_playlist_id = items[0]["contentDetails"]["relatedPlaylists"]["uploads"]

        # Step 2: Fetch items in uploads playlist
        try:
            playlist_items = (
                service.playlistItems()
                .list(
                    playlistId=uploads_playlist_id,
                    part="snippet,contentDetails",
                    maxResults=min(max_results, 50),
                )
                .execute()
            )
        except HttpError as err:
            if err.resp.status == 404:
                return []
            raise format_http_error(err) from err

        video_ids = [item["contentDetails"]["videoId"] for item in playlist_items.get("items", [])]
        if not video_ids:
            return []

        # Step 3: Fetch video status & statistics in batch
        videos = service.videos().list(id=",".join(video_ids), part="snippet,status,statistics").execute()

        results: list[dict[str, Any]] = []
        for vid in videos.get("items", []):
            vid_status = vid.get("status", {}).get("privacyStatus")
            if privacy_filter and vid_status != privacy_filter:
                continue

            snippet = vid.get("snippet", {})
            stats = vid.get("statistics", {})
            results.append(
                {
                    "video_id": vid.get("id"),
                    "title": snippet.get("title"),
                    "published_at": snippet.get("publishedAt"),
                    "privacy_status": vid_status,
                    "views": int(stats.get("viewCount", 0)),
                    "likes": int(stats.get("likeCount", 0)),
                    "comments": int(stats.get("commentCount", 0)),
                    "url": f"https://youtu.be/{vid.get('id')}",
                }
            )

        return results
    except HttpError as e:
        raise format_http_error(e) from e


def get_video_details(video_id: str) -> dict[str, Any]:
    """
    Fetches full metadata, status, content details, and statistics for a specific video.
    Quota cost: 1 unit.
    """
    service = get_youtube_data_service()
    try:
        response = (
            service.videos().list(id=video_id, part="snippet,contentDetails,status,statistics").execute()
        )

        items = response.get("items", [])
        if not items:
            return {"error": f"Video '{video_id}' not found."}

        vid = items[0]
        snippet = vid.get("snippet", {})
        status = vid.get("status", {})
        stats = vid.get("statistics", {})
        details = vid.get("contentDetails", {})

        return {
            "video_id": video_id,
            "title": snippet.get("title"),
            "description": snippet.get("description"),
            "tags": snippet.get("tags", []),
            "category_id": snippet.get("categoryId"),
            "published_at": snippet.get("publishedAt"),
            "duration": details.get("duration"),
            "dimension": details.get("dimension"),
            "definition": details.get("definition"),
            "caption": details.get("caption"),
            "privacy_status": status.get("privacyStatus"),
            "publish_at": status.get("publishAt"),
            "views": int(stats.get("viewCount", 0)),
            "likes": int(stats.get("likeCount", 0)),
            "comments": int(stats.get("commentCount", 0)),
            "url": f"https://youtu.be/{video_id}",
        }
    except HttpError as e:
        raise format_http_error(e) from e
