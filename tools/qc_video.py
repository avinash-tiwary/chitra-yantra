#!/usr/bin/env python3
"""Run objective release gates against the assembled review video."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


def stream_duration(stream: dict) -> float:
    try:
        return float(stream.get("duration") or 0)
    except (TypeError, ValueError):
        return 0.0


def loudness(video: Path) -> dict:
    """Use ffmpeg's ebur128 summary when available; never invent audio quality."""
    if not shutil.which("ffmpeg"):
        return {"available": False}
    result = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(video), "-filter_complex", "ebur128=peak=true", "-f", "null", "-"], capture_output=True, text=True)
    text = result.stderr
    import re
    integrated = re.findall(r"I:\s*(-?\d+(?:\.\d+)?)\s*LUFS", text)
    peak = re.findall(r"Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS", text)
    return {"available": bool(integrated), "integratedLufs": float(integrated[-1]) if integrated else None, "peakDbfs": float(peak[-1]) if peak else None}


def main() -> int:
    parser = argparse.ArgumentParser(description="Quality-check a Chitra Yantra video export.")
    parser.add_argument("video_dir", type=Path)
    parser.add_argument("--output", type=Path, help="Exact versioned QC report path")
    args = parser.parse_args()
    if not shutil.which("ffprobe"):
        print("ffprobe is required", file=sys.stderr)
        return 2
    root = args.video_dir.resolve()
    video = next((file for file in [root / "05_edit" / "final_exports" / "final.mp4", root / "05_edit" / "review_exports" / "assembled_v01.mp4"] if file.is_file()), None)
    if not video:
        print("No assembled video found", file=sys.stderr)
        return 2
    result = subprocess.run(["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(video)], check=True, capture_output=True, text=True)
    probe = json.loads(result.stdout)
    video_stream = next((stream for stream in probe.get("streams", []) if stream.get("codec_type") == "video"), {})
    audio_stream = next((stream for stream in probe.get("streams", []) if stream.get("codec_type") == "audio"), {})
    duration = float(probe.get("format", {}).get("duration") or 0)
    audio_duration = stream_duration(audio_stream) or duration
    video_duration = stream_duration(video_stream) or duration
    timeline_path = root / "05_edit" / "timelines" / "timeline_v1.json"
    timeline = {}
    try:
        timeline = json.loads(timeline_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        pass
    lufs = loudness(video)
    fps = str(video_stream.get("avg_frame_rate") or "0/0")
    try:
        numerator, denominator = (float(item) for item in fps.split("/", 1))
        fps_value = numerator / denominator if denominator else 0
    except (ValueError, ZeroDivisionError):
        fps_value = 0
    checks = [
        {"id": "video-stream", "label": "Video stream present", "passed": bool(video_stream)},
        {"id": "resolution", "label": "1920×1080 or larger", "passed": int(video_stream.get("width", 0)) >= 1920 and int(video_stream.get("height", 0)) >= 1080},
        {"id": "audio-stream", "label": "Audio stream present", "passed": bool(audio_stream)},
        {"id": "duration", "label": "Duration is greater than 10 seconds", "passed": duration > 10},
        {"id": "faststart", "label": "MP4 container", "passed": "mp4" in str(probe.get("format", {}).get("format_name", ""))},
        {"id": "av-sync", "label": "Audio and video durations agree within 250 ms", "passed": abs(audio_duration - video_duration) <= 0.25},
        {"id": "frame-rate", "label": "Frame rate is 24–60 fps", "passed": 24 <= fps_value <= 60},
        {"id": "pixel-format", "label": "Delivery pixel format is yuv420p", "passed": video_stream.get("pix_fmt") == "yuv420p"},
        {"id": "audio-rate", "label": "Audio is 48 kHz", "passed": int(audio_stream.get("sample_rate") or 0) == 48000},
        {"id": "timeline", "label": "Fail-closed compiled timeline is present and matches export", "passed": bool(timeline.get("beats")) and abs(float(timeline.get("audio", {}).get("durationSeconds") or 0) - duration) <= 0.25},
        {"id": "loudness", "label": "Integrated loudness is −14 LUFS ±0.5", "passed": lufs.get("available") and -14.5 <= float(lufs["integratedLufs"]) <= -13.5},
        {"id": "true-peak", "label": "Peak is no higher than −1.5 dBFS", "passed": lufs.get("available") and lufs.get("peakDbfs") is not None and float(lufs["peakDbfs"]) <= -1.5},
        {"id": "subtitles", "label": "Timed subtitle file prepared", "passed": any((root / "06_publish" / "subtitles").glob("*.srt"))},
        {"id": "editorial-review", "label": "Human editorial review", "passed": False, "manual": True},
        {"id": "rights-review", "label": "Rights and attribution review", "passed": False, "manual": True},
    ]
    report = {"schemaVersion": 2, "generatedAt": datetime.now(timezone.utc).isoformat(), "video": str(video), "durationSeconds": duration, "audioDurationSeconds": audio_duration, "videoDurationSeconds": video_duration, "loudness": lufs, "checks": checks, "probe": probe}
    output = args.output.resolve() if args.output else root / "05_edit" / "qc_report_v1.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    technical_failures = [check for check in checks if not check["passed"] and not check.get("manual")]
    print(f"Wrote {output}; {len(technical_failures)} technical failure(s)")
    return 1 if technical_failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
