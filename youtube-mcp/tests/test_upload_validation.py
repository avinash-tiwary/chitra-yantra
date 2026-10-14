"""Validation tests that must run before any YouTube API request is created."""

from datetime import datetime, timedelta, timezone

import pytest

from youtube_mcp import upload


@pytest.fixture
def video_file(tmp_path):
    file = tmp_path / "video.mp4"
    file.write_bytes(b"not-a-real-video-but-validation-only")
    return file


@pytest.mark.parametrize(
    ("title", "description"),
    [("", "description"), ("x" * 101, "description"), ("title", ""), ("title", "x" * 5001)],
)
def test_upload_rejects_invalid_required_metadata_before_api(video_file, title, description):
    with pytest.raises(ValueError):
        upload.upload_video_file(video_file, title, description)


def test_upload_rejects_aggregate_tag_overflow_before_api(video_file):
    with pytest.raises(ValueError, match="tags"):
        upload.upload_video_file(video_file, "title", "description", tags=["x" * 300, "y" * 300])


@pytest.mark.parametrize(
    "publish_at",
    ["not-a-date", datetime.now(timezone.utc).isoformat(), datetime.now().isoformat()],
)
def test_upload_rejects_invalid_or_nonfuture_schedule_before_api(video_file, publish_at):
    with pytest.raises(ValueError, match="publish_at"):
        upload.upload_video_file(video_file, "title", "description", publish_at=publish_at)


def test_thumbnail_requires_supported_image_and_size(monkeypatch, tmp_path):
    monkeypatch.setattr(upload, "get_youtube_data_service", lambda: pytest.fail("API must not be called"))
    wrong_type = tmp_path / "thumb.gif"
    wrong_type.write_bytes(b"GIF89a")
    with pytest.raises(ValueError, match="JPEG or PNG"):
        upload.set_video_thumbnail("video-id", wrong_type)

    oversized = tmp_path / "thumb.png"
    oversized.write_bytes(b"0" * (2 * 1024 * 1024 + 1))
    with pytest.raises(ValueError, match="2 MB"):
        upload.set_video_thumbnail("video-id", oversized)


def test_future_timezone_aware_schedule_reaches_api_construction(monkeypatch, video_file):
    class InsertRequest:
        def next_chunk(self):
            return None, {"id": "video-id"}

    class Videos:
        def insert(self, **_kwargs):
            return InsertRequest()

    class Service:
        def videos(self):
            return Videos()

    monkeypatch.setattr(upload, "get_youtube_data_service", lambda: Service())
    result = upload.upload_video_file(
        video_file,
        "title",
        "description",
        publish_at=(datetime.now(timezone.utc) + timedelta(days=1)).isoformat(),
    )
    assert result["success"] is True
    assert result["privacy_status"] == "private"


def test_upload_requires_video_id_in_api_response(monkeypatch, video_file):
    class Request:
        def next_chunk(self):
            return None, {}

    class Videos:
        def insert(self, **_kwargs):
            return Request()

    class Service:
        def videos(self):
            return Videos()

    monkeypatch.setattr(upload, "get_youtube_data_service", lambda: Service())
    with pytest.raises(RuntimeError, match="video ID"):
        upload.upload_video_file(video_file, "title", "description")


def test_metadata_update_rejects_truncation_and_invalid_privacy(monkeypatch):
    class ListRequest:
        def execute(self):
            return {"items": [{"snippet": {"title": "old", "description": "old"}, "status": {"privacyStatus": "private"}}]}

    class Videos:
        def list(self, **_kwargs):
            return ListRequest()

    class Service:
        def videos(self):
            return Videos()

    monkeypatch.setattr(upload, "get_youtube_data_service", lambda: Service())
    with pytest.raises(ValueError, match="title"):
        upload.update_video_metadata("video-id", title="x" * 101)
    with pytest.raises(ValueError, match="privacy"):
        upload.update_video_metadata("video-id", privacy_status="friends")
