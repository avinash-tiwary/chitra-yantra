#!/usr/bin/env python3
"""Assemble a timing- and motion-aware review export from an Editorial Blueprint."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from compile_timeline import compile_timeline

FPS = 30
OUTPUT_SIZE = "1920:1080"


def duration(file: Path) -> float:
    result = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", str(file)], check=True, capture_output=True, text=True)
    return float(result.stdout.strip())


def latest(root: Path, pattern: str) -> Path | None:
    files = sorted(root.glob(pattern), reverse=True)
    return files[0] if files else None


def read_blueprint(root: Path) -> tuple[dict[str, Any] | None, Path | None]:
    plan = latest(root / "04_visuals" / "plans", "editorial_blueprint_v*.json")
    if not plan:
        return None, None
    try:
        payload = json.loads(plan.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else None, plan
    except (OSError, json.JSONDecodeError):
        return None, plan


def motion_filter(motion: str, frames: int) -> str:
    """The deliberate still-image motion vocabulary used by faceless edits."""
    movement = motion or "hold"
    if movement == "pull_out":
        zoom = "if(eq(on,0),1.12,max(1.0,zoom-0.0008))"
    elif movement in {"pan_left", "pan_right"}:
        zoom = "1.08"
    elif movement == "parallax":
        zoom = "min(zoom+0.00045,1.10)"
    elif movement in {"map_route", "diagram_build", "text_reveal"}:
        zoom = "min(zoom+0.0003,1.055)"
    elif movement == "hold":
        zoom = "1.02"
    else:
        zoom = "min(zoom+0.00065,1.12)"
    x = "iw/2-(iw/zoom/2)" if movement != "pan_left" else "max(0,iw/2-(iw/zoom/2)-on*0.35)"
    x = x if movement != "pan_right" else "min(iw-iw/zoom,iw/2-(iw/zoom/2)+on*0.35)"
    return f"scale=2400:1350:force_original_aspect_ratio=increase,crop=2400:1350,zoompan=z='{zoom}':x='{x}':y='ih/2-(ih/zoom/2)':d={frames}:s={OUTPUT_SIZE}:fps={FPS},format=yuv420p"


def asset_media(root: Path, blueprint: dict[str, Any], beat: dict[str, Any]) -> Path | None:
    asset_id = str(beat.get("visual", {}).get("primaryAssetId") or "")
    asset = next((item for item in blueprint.get("assets", []) if str(item.get("id")) == asset_id), None)
    if asset:
        for key in ("generatedPath", "sourcePath", "localPath"):
            if asset.get(key):
                candidate = root / str(asset[key])
                if candidate.is_file():
                    return candidate
    render = root / "04_visuals" / "renders" / f"{asset_id}.png"
    return render if render.is_file() else None


def write_clip(image: Path, output: Path, seconds: float, motion: str) -> None:
    frames = max(1, round(seconds * FPS))
    subprocess.run([
        "ffmpeg", "-y", "-loop", "1", "-i", str(image), "-t", f"{seconds:.3f}", "-vf", motion_filter(motion, frames), "-r", str(FPS),
        "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", str(output),
    ], check=True, capture_output=True, text=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a deterministic, blueprint-driven review export.")
    parser.add_argument("video_dir", type=Path)
    args = parser.parse_args()
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        print("ffmpeg and ffprobe are required", file=sys.stderr)
        return 2
    root = args.video_dir.resolve()
    try:
        # A review export must reflect every approved beat.  Never turn an
        # incomplete blueprint into a deceptively short movie.
        timeline = compile_timeline(root)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"Assembly blocked: {error}", file=sys.stderr)
        return 2
    audio = latest(root / "03_audio" / "mixes", "final_mix_v*.*") or root / "03_audio" / "final_mix.wav"
    if not audio.is_file():
        print(f"Audio master not found: {audio}", file=sys.stderr)
        return 2
    total = duration(audio)
    blueprint, blueprint_path = read_blueprint(root)
    output_dir = root / "05_edit" / "review_exports"
    output_dir.mkdir(parents=True, exist_ok=True)
    output = output_dir / "assembled_v01.mp4"
    beats = list(blueprint.get("beats", [])) if blueprint else []
    selected: list[tuple[dict[str, Any], Path, float, float]] = []
    for beat in beats:
        timing = beat.get("timing", {})
        start, end = max(0.0, float(timing.get("startSeconds", 0))), min(total, float(timing.get("endSeconds", 0)))
        image = asset_media(root, blueprint, beat) if blueprint else None
        if end > start and image:
            selected.append((beat, image, start, end))

    if selected:
        storyboard: list[dict[str, Any]] = []
        with tempfile.TemporaryDirectory(prefix="chitra-assembly-") as temporary:
            tmp = Path(temporary)
            clips: list[Path] = []
            for index, (beat, image, start, end) in enumerate(selected):
                clip = tmp / f"beat_{index:03d}.mp4"
                motion = str(beat.get("visual", {}).get("motion", {}).get("type", "hold"))
                write_clip(image, clip, end - start, motion)
                clips.append(clip)
                storyboard.append({"beatId": beat.get("id"), "label": beat.get("narration", {}).get("anchor", image.stem), "assetFile": str(image.relative_to(root)), "startSeconds": round(start, 3), "endSeconds": round(end, 3), "motion": motion, "transitionIn": beat.get("visual", {}).get("transitionIn", "cut"), "transitionOut": beat.get("visual", {}).get("transitionOut", "cut"), "text": beat.get("text", {}), "audio": beat.get("audio", {})})
            concat = tmp / "clips.txt"
            concat.write_text("".join(f"file '{clip}'\n" for clip in clips), encoding="utf-8")
            subprocess.run(["ffmpeg", "-y", "-safe", "0", "-f", "concat", "-i", str(concat), "-i", str(audio), "-map", "0:v:0", "-map", "1:a:0", "-shortest", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(output)], check=True)
        (root / "05_edit" / "storyboard.json").write_text(json.dumps({"blueprint": str(blueprint_path.relative_to(root)), "beats": storyboard}, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"Wrote blueprint-driven review export: {output}")
        # Keep the compiler output beside the review export as a durable
        # contract for QC and later release-manifest creation.
        (root / "05_edit" / "timelines" / "timeline_v1.json").parent.mkdir(parents=True, exist_ok=True)
        (root / "05_edit" / "timelines" / "timeline_v1.json").write_text(json.dumps(timeline, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return 0

    print("Assembly blocked: no approved timeline clips were produced", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
