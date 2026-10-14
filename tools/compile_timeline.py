#!/usr/bin/env python3
"""Compile a fail-closed, hash-bound edit timeline from an Editorial Blueprint."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def duration(path: Path) -> float:
    result = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", str(path)], check=True, capture_output=True, text=True)
    return float(result.stdout.strip())


def latest(root: Path, pattern: str) -> Path | None:
    values = sorted(root.glob(pattern), reverse=True)
    return values[0] if values else None


def compile_timeline(root: Path) -> dict:
    audio = latest(root / "03_audio" / "mixes", "final_mix_v*.*")
    blueprint_path = latest(root / "04_visuals" / "plans", "editorial_blueprint_v*.json")
    if not audio or not blueprint_path:
        raise ValueError("A final audio mix and versioned Editorial Blueprint are required")
    blueprint = json.loads(blueprint_path.read_text(encoding="utf-8"))
    assets = {str(asset.get("id")): asset for asset in blueprint.get("assets", []) if isinstance(asset, dict)}
    runtime = duration(audio)
    beats, problems = [], []
    cursor = 0.0
    for index, beat in enumerate(blueprint.get("beats", [])):
        timing = beat.get("timing", {})
        start, end = float(timing.get("startSeconds", -1)), float(timing.get("endSeconds", -1))
        asset_id = str(beat.get("visual", {}).get("primaryAssetId") or "")
        asset = assets.get(asset_id)
        if start < 0 or end <= start or abs(start - cursor) > 0.25:
            problems.append(f"Beat {beat.get('id') or index + 1} leaves a timing gap or overlap")
        cursor = end
        if not asset:
            problems.append(f"Beat {beat.get('id') or index + 1} has no asset")
            continue
        candidate = next((root / str(asset[key]) for key in ("generatedPath", "sourcePath", "localPath") if asset.get(key) and (root / str(asset[key])).is_file()), root / "04_visuals" / "renders" / f"{asset_id}.png")
        if asset.get("approvalStatus") != "approved" or not candidate.is_file():
            problems.append(f"Beat {beat.get('id') or index + 1} lacks an approved available visual")
        beats.append({"id": beat.get("id"), "startSeconds": round(start, 3), "endSeconds": round(end, 3), "assetId": asset_id,
                      "assetPath": str(candidate.relative_to(root)) if candidate.is_file() else None,
                      "screenStates": [state for state in blueprint.get("screenStates", []) if state.get("parentBeatId") == beat.get("id")],
                      "text": beat.get("text", {}), "audio": beat.get("audio", {}), "motion": beat.get("visual", {}).get("motion", {})})
    if abs(cursor - runtime) > 0.25:
        problems.append(f"Blueprint ends at {cursor:.3f}s but final narration is {runtime:.3f}s")
    if problems:
        raise ValueError("Timeline blocked: " + "; ".join(problems))
    return {"schemaVersion": 1, "compiledAt": datetime.now(timezone.utc).isoformat(), "audio": {"path": str(audio.relative_to(root)), "sha256": sha256(audio), "durationSeconds": round(runtime, 3)},
            "blueprint": {"path": str(blueprint_path.relative_to(root)), "sha256": sha256(blueprint_path)}, "beats": beats}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("video_dir", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    root = args.video_dir.resolve()
    try:
        timeline = compile_timeline(root)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(str(error), flush=True)
        return 2
    output = args.output or root / "05_edit" / "timelines" / "timeline_v1.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(timeline, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
