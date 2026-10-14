#!/usr/bin/env python3
"""Narrow, validated YouTube adapter for Chitra Yantra."""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
MCP_ROOT = ROOT / "youtube-mcp"
sys.path.insert(0, str(MCP_ROOT))
os.chdir(MCP_ROOT)


def validate_request(payload: dict) -> tuple[Path, dict, Path | None]:
    video = Path(payload["video"]).resolve()
    metadata_file = Path(payload["metadataFile"]).resolve()
    if not video.is_file() or video.suffix.lower() not in {".mp4", ".mov", ".m4v", ".webm"}:
        raise ValueError("A supported final video file is required")
    if not metadata_file.is_file():
        raise ValueError("metadata.json is required")
    metadata = json.loads(metadata_file.read_text(encoding="utf-8"))
    title = str(metadata.get("title", "")).strip()
    description = str(metadata.get("description", "")).strip()
    if not title or len(title) > 100:
        raise ValueError("YouTube title must contain 1–100 characters")
    if not description or len(description) > 5000:
        raise ValueError("YouTube description must contain 1–5000 characters")
    tags = [str(tag).strip() for tag in metadata.get("tags", []) if str(tag).strip()]
    if len(",".join(tags)) > 500:
        raise ValueError("Combined YouTube tags must not exceed 500 characters")
    privacy = payload.get("privacy", "private")
    if privacy not in {"private", "unlisted", "public"}:
        raise ValueError("Invalid privacy setting")
    publish_at = payload.get("publishAt")
    if publish_at:
        parsed = datetime.fromisoformat(str(publish_at).replace("Z", "+00:00"))
        if parsed.tzinfo is None or parsed.astimezone(timezone.utc) <= datetime.now(timezone.utc):
            raise ValueError("Scheduled publish time must be a future timezone-aware date")
    thumbnail = Path(payload["thumbnail"]).resolve() if payload.get("thumbnail") else None
    if thumbnail and (not thumbnail.is_file() or thumbnail.stat().st_size > 2 * 1024 * 1024):
        raise ValueError("Thumbnail must be an existing image no larger than 2 MB")
    return video, metadata, thumbnail


def authenticate() -> int:
    from youtube_mcp.auth import get_credentials, resolve_token_path

    get_credentials(interactive_if_missing=True)
    print(json.dumps({"success": True, "tokenPath": str(resolve_token_path())}))
    return 0


def status() -> int:
    from youtube_mcp.client import get_channel_overview

    try:
        overview = get_channel_overview()
        if overview.get("error"):
            raise RuntimeError(str(overview["error"]))
        print(json.dumps({"success": True, "channel": overview}, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"success": False, "error": str(error)}, ensure_ascii=False))
        return 1


def analytics(video_id: str) -> int:
    from youtube_mcp.analytics import get_video_analytics

    try:
        result = get_video_analytics(video_id=video_id, start_date="30daysAgo", end_date="today")
        print(json.dumps({"success": True, "analytics": result}, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"success": False, "error": str(error)}, ensure_ascii=False))
        return 1


def upload(request_file: Path) -> int:
    from googleapiclient.http import MediaFileUpload
    from youtube_mcp.client import get_youtube_data_service
    from youtube_mcp.upload import upload_video_file

    payload = json.loads(request_file.read_text(encoding="utf-8"))
    result_file = Path(payload["resultFile"])
    try:
        video, metadata, thumbnail = validate_request(payload)
        result = upload_video_file(
            file_path=video, title=metadata["title"], description=metadata["description"],
            tags=metadata.get("tags", []), category_id=str(metadata.get("category_id", "27")),
            privacy_status=payload.get("privacy", "private"), publish_at=payload.get("publishAt"),
            made_for_kids=bool(metadata.get("made_for_kids", False)), thumbnail_path=thumbnail,
        )
        operations = []
        if isinstance(result.get("thumbnail_status"), dict) and result["thumbnail_status"].get("error"):
            operations.append({"operation": "thumbnail", "success": False, "error": result["thumbnail_status"]["error"]})
        service = get_youtube_data_service()
        subtitle = next((item for item in sorted((request_file.parent / "subtitles").glob("*.srt")) if item.is_file()), None)
        if subtitle and result.get("video_id"):
            try:
                response = service.captions().insert(
                    part="snippet", body={"snippet": {"videoId": result["video_id"], "language": metadata.get("language", "hi"), "name": "Primary captions", "isDraft": False}},
                    media_body=MediaFileUpload(str(subtitle), mimetype="application/octet-stream", resumable=False),
                ).execute()
                operations.append({"operation": "captions", "success": True, "id": response.get("id")})
            except Exception as error:
                operations.append({"operation": "captions", "success": False, "error": str(error)})
        playlist_id = metadata.get("playlist_id")
        if playlist_id and result.get("video_id"):
            try:
                service.playlistItems().insert(part="snippet", body={"snippet": {"playlistId": playlist_id, "resourceId": {"kind": "youtube#video", "videoId": result["video_id"]}}}).execute()
                operations.append({"operation": "playlist", "success": True})
            except Exception as error:
                operations.append({"operation": "playlist", "success": False, "error": str(error)})
        pinned = str(metadata.get("pinned_comment", "")).strip()
        if pinned and result.get("video_id"):
            try:
                response = service.commentThreads().insert(part="snippet", body={"snippet": {"videoId": result["video_id"], "topLevelComment": {"snippet": {"textOriginal": pinned}}}}).execute()
                operations.append({"operation": "comment", "success": True, "id": response.get("id"), "note": "Created; YouTube API does not expose pinning."})
            except Exception as error:
                operations.append({"operation": "comment", "success": False, "error": str(error)})
        result["operations"] = operations
        result["complete"] = all(operation.get("success") for operation in operations)
    except Exception as error:
        result = {"success": False, "error": str(error)}
    result_file.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("success") else 1


def release(request_file: Path) -> int:
    """Owner-only server adapter: change an existing private candidate's visibility."""
    from youtube_mcp.upload import update_video_metadata

    try:
        payload = json.loads(request_file.read_text(encoding="utf-8"))
        video_id = str(payload.get("videoId") or "").strip()
        privacy = str(payload.get("privacy") or "").strip()
        if not video_id or privacy not in {"public", "unlisted"}:
            raise ValueError("A private YouTube video ID and public or unlisted visibility are required")
        result = update_video_metadata(video_id=video_id, privacy_status=privacy)
        print(json.dumps({"success": True, "release": result}, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"success": False, "error": str(error)}, ensure_ascii=False))
        return 1


def reconcile(video_id: str) -> int:
    """Read remote title/privacy after a manual YouTube Studio release."""
    from youtube_mcp.client import get_youtube_data_service

    try:
        result = get_youtube_data_service().videos().list(part="snippet,status", id=video_id).execute()
        item = (result.get("items") or [None])[0]
        if not item:
            raise ValueError("Video was not found on the connected YouTube channel")
        print(json.dumps({"success": True, "video": {"id": video_id, "title": item.get("snippet", {}).get("title"), "privacy": item.get("status", {}).get("privacyStatus")}}, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"success": False, "error": str(error)}, ensure_ascii=False))
        return 1


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("auth")
    subparsers.add_parser("status")
    analytics_parser = subparsers.add_parser("analytics")
    analytics_parser.add_argument("--video-id", required=True)
    upload_parser = subparsers.add_parser("upload")
    upload_parser.add_argument("--request", required=True, type=Path)
    release_parser = subparsers.add_parser("release")
    release_parser.add_argument("--request", required=True, type=Path)
    reconcile_parser = subparsers.add_parser("reconcile")
    reconcile_parser.add_argument("--video-id", required=True)
    args = parser.parse_args()
    if args.command == "auth":
        return authenticate()
    if args.command == "status":
        return status()
    if args.command == "release":
        return release(args.request)
    if args.command == "reconcile":
        return reconcile(args.video_id)
    if args.command == "analytics":
        return analytics(args.video_id)
    return upload(args.request)


if __name__ == "__main__":
    raise SystemExit(main())
