"""Shared channel configuration for project-aware production tools."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def load_channel(video_dir: Path | None) -> dict[str, Any]:
    if video_dir:
        for directory in (video_dir.resolve(), *video_dir.resolve().parents):
            for candidate in ("channel_dna.json", "channel.json"):
                config = directory / candidate
                if config.is_file():
                    try:
                        data = json.loads(config.read_text(encoding="utf-8"))
                        if isinstance(data, dict):
                            return data
                    except (OSError, json.JSONDecodeError):
                        break
    return {
        "id": "independent",
        "name": "Independent channel",
        "handle": "",
        "niche": "Evidence-led explanatory videos",
        "style": "Clear, accurate, and engaging",
        "script_language": "Natural language appropriate for the audience",
        "script_formula": "HOOK → QUESTION → EVIDENCE → COUNTEREVIDENCE → ANSWER",
        "default_tags": [],
    }


def channel_summary(channel: dict[str, Any]) -> str:
    source_tiers = channel.get("source_tiers") or {}
    tiers = "; ".join(f"{name}: {', '.join(map(str, values))}" for name, values in source_tiers.items() if isinstance(values, list))
    return "\n".join(
        line for line in [
            f"Channel: {channel.get('name', channel.get('id', 'Independent channel'))} {channel.get('handle', '')}".strip(),
            f"Niche: {channel.get('niche', '')}".strip(),
            f"Editorial style: {channel.get('style', '')}".strip(),
            f"Script language: {channel.get('script_language', channel.get('language', ''))}".strip(),
            f"Narrative formula: {channel.get('script_formula', '')}".strip(),
            f"Established channel tags: {', '.join(map(str, channel.get('default_tags', [])))}" if channel.get("default_tags") else "",
            f"Preferred source tiers: {tiers}" if tiers else "",
        ] if line and not line.endswith(":")
    )
