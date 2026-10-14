#!/usr/bin/env python3
"""
subtitle_workflow.py — Process MacWhisper output into clean YouTube-ready subtitles.

MacWhisper exports: .srt, .vtt, .txt (plain), or .json
This tool:
  1. Parses any MacWhisper format
  2. Cleans up common Hindi transcription artifacts
  3. Formats .srt and .vtt for YouTube
  4. Generates chapter markers from subtitle content + script structure
  5. Saves to 06_publish/subtitles/

Usage:
  # After exporting from MacWhisper:
  python tools/subtitle_workflow.py channels/example-channel/videos/2026-04-14_example-topic/ 05_edit/raw_macwhisper.srt
  python tools/subtitle_workflow.py channels/example-channel/videos/2026-04-14_example-topic/ 05_edit/transcript.txt --format txt
  python tools/subtitle_workflow.py channels/example-channel/videos/2026-04-14_example-topic/ 05_edit/transcript.json --format json

MacWhisper tips:
  - Use model: large-v3 for best Hindi accuracy
  - Enable "Speaker diarization" if multiple speakers
  - Export as SRT for subtitle workflow
  - Export as TXT for script correction
"""

import argparse
import json
import re
import sys
from datetime import timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

try:
    from rich.console import Console
    from rich.table import Table
    from rich import box
    console = Console()
    USE_RICH = True
except ImportError:
    class _Console:
        def print(self, *a, **kw): print(*a)
    console = _Console()
    USE_RICH = False


# ─── SRT PARSING ─────────────────────────────────────────────────────────────

def parse_srt(content: str) -> list[dict]:
    """Parse SRT file into list of subtitle entries."""
    entries = []
    blocks = re.split(r'\n{2,}', content.strip())

    for block in blocks:
        lines = block.strip().split('\n')
        if len(lines) < 2:
            continue
        try:
            idx = int(lines[0].strip())
        except ValueError:
            continue

        # Parse time range
        time_match = re.match(
            r'(\d{2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,\.]\d{3})',
            lines[1]
        )
        if not time_match:
            continue

        start = time_match.group(1).replace(',', '.')
        end = time_match.group(2).replace(',', '.')
        text = '\n'.join(lines[2:]).strip()

        if text:
            entries.append({
                "index": idx,
                "start": start,
                "end": end,
                "text": text,
            })

    return entries


def parse_vtt(content: str) -> list[dict]:
    """Parse WebVTT file."""
    # VTT is similar to SRT with different header
    content = re.sub(r'^WEBVTT.*?\n\n', '', content, flags=re.DOTALL)
    # Normalize time format
    content = content.replace(' --> ', ' --> ')
    entries = []
    blocks = re.split(r'\n{2,}', content.strip())
    idx = 1

    for block in blocks:
        lines = block.strip().split('\n')
        if not lines:
            continue

        # Skip NOTE lines
        if lines[0].startswith('NOTE'):
            continue

        # Handle optional cue identifier
        start_line = 0
        if '-->' not in lines[0] and len(lines) > 1:
            start_line = 1

        if start_line >= len(lines):
            continue

        time_match = re.match(
            r'(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})',
            lines[start_line]
        )
        if not time_match:
            continue

        start = time_match.group(1)
        end = time_match.group(2)
        text = '\n'.join(lines[start_line + 1:]).strip()

        # Strip VTT tags
        text = re.sub(r'<[^>]+>', '', text).strip()

        if text:
            entries.append({"index": idx, "start": start, "end": end, "text": text})
            idx += 1

    return entries


def parse_txt(content: str) -> list[dict]:
    """Parse plain text transcript — no timing info."""
    # Plain text: just paragraphs of text
    paragraphs = [p.strip() for p in re.split(r'\n{2,}', content.strip()) if p.strip()]
    # Fake timing: estimate ~3 words/second, 130 wpm for Hindi
    entries = []
    current_time = 0.0

    for i, para in enumerate(paragraphs):
        words = len(para.split())
        duration = max(words / 2.5, 1.0)  # ~2.5 words/second

        start_td = timedelta(seconds=int(current_time))
        end_td = timedelta(seconds=int(current_time + duration))

        def fmt_time(td):
            total = int(td.total_seconds())
            h = total // 3600
            m = (total % 3600) // 60
            s = total % 60
            return f"{h:02d}:{m:02d}:{s:02d}.000"

        entries.append({
            "index": i + 1,
            "start": fmt_time(start_td),
            "end": fmt_time(end_td),
            "text": para,
        })
        current_time += duration

    return entries


def parse_json(content: str) -> list[dict]:
    """Parse MacWhisper JSON export."""
    data = json.loads(content)
    entries = []

    # MacWhisper JSON format: {"segments": [{"start": float, "end": float, "text": str}]}
    segments = data.get("segments", [])
    if not segments:
        # Try alternative format
        segments = data if isinstance(data, list) else []

    for i, seg in enumerate(segments, 1):
        start_s = seg.get("start", 0)
        end_s = seg.get("end", start_s + 2)
        text = seg.get("text", "").strip()

        def fmt(s):
            h = int(s // 3600)
            m = int((s % 3600) // 60)
            sec = s % 60
            ms = int((sec % 1) * 1000)
            return f"{h:02d}:{m:02d}:{int(sec):02d}.{ms:03d}"

        if text:
            entries.append({
                "index": i,
                "start": fmt(start_s),
                "end": fmt(end_s),
                "text": text,
            })

    return entries


# ─── CLEANING ─────────────────────────────────────────────────────────────────

HINDI_CLEANUP = [
    # Common MacWhisper Hindi transcription errors
    (r'\bhai\b', 'है'),
    (r'\bkya\b', 'क्या'),
    (r'\baur\b', 'और'),
    (r'\bmein\b', 'में'),
    # Remove filler words common in recordings
    (r'\b(hmm+|uh+|um+)\b', ''),
    # Fix spacing around punctuation
    (r'\s+([।,।!?])', r'\1'),
    (r'([।,।!?])\s+', r'\1 '),
    # Remove double spaces
    (r'\s{2,}', ' '),
    # Remove trailing/leading whitespace per subtitle
    (r'^\s+|\s+$', ''),
]


def clean_subtitle(text: str, language: str = "hi") -> str:
    """Apply common Hindi subtitle cleanup."""
    patterns = HINDI_CLEANUP if language.startswith("hi") else HINDI_CLEANUP[-3:]
    for pattern, replacement in patterns:
        text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)
    return text.strip()


def seconds(timestamp: str) -> float:
    hours, minutes, raw_seconds = timestamp.replace(",", ".").split(":")
    return int(hours) * 3600 + int(minutes) * 60 + float(raw_seconds)


def validate_entries(entries: list[dict]) -> None:
    if not entries:
        raise ValueError("No valid subtitle cues were parsed")
    previous_start = -1.0
    for entry in entries:
        start, end = seconds(entry["start"]), seconds(entry["end"])
        if start < previous_start:
            raise ValueError(f"Subtitle cue {entry['index']} starts before the preceding cue")
        if end <= start:
            raise ValueError(f"Subtitle cue {entry['index']} must end after it starts")
        previous_start = start


def display_path(file: Path) -> Path:
    try:
        return file.relative_to(ROOT)
    except ValueError:
        return file


# ─── FORMATTING ───────────────────────────────────────────────────────────────

def to_srt_time(t: str) -> str:
    """Convert HH:MM:SS.mmm to SRT format HH:MM:SS,mmm"""
    return t.replace('.', ',')


def to_vtt_time(t: str) -> str:
    """Ensure VTT format HH:MM:SS.mmm"""
    return t.replace(',', '.')


def entries_to_srt(entries: list[dict]) -> str:
    lines = []
    for e in entries:
        lines.append(str(e["index"]))
        lines.append(f"{to_srt_time(e['start'])} --> {to_srt_time(e['end'])}")
        lines.append(e["text"])
        lines.append("")
    return "\n".join(lines)


def entries_to_vtt(entries: list[dict]) -> str:
    lines = ["WEBVTT", ""]
    for e in entries:
        lines.append(f"{to_vtt_time(e['start'])} --> {to_vtt_time(e['end'])}")
        lines.append(e["text"])
        lines.append("")
    return "\n".join(lines)


def entries_to_txt(entries: list[dict]) -> str:
    """Plain text transcript with timestamps."""
    lines = []
    for e in entries:
        lines.append(f"[{e['start'][:8]}] {e['text']}")
    return "\n".join(lines)


# ─── MAIN ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Process MacWhisper subtitles for YouTube."
    )
    parser.add_argument("video_dir", help="Path to video directory")
    parser.add_argument("input_file", help="MacWhisper output file (SRT, VTT, TXT, or JSON)")
    parser.add_argument("--format", default="auto",
                        choices=["auto", "srt", "vtt", "txt", "json"],
                        help="Input format (default: auto-detect from extension)")
    parser.add_argument("--lang", default="hi", help="Language code (default: hi)")
    parser.add_argument("--no-clean", action="store_true",
                        help="Skip automatic cleanup/corrections")
    parser.add_argument("--allow-estimated-timing", action="store_true",
                        help="Explicitly allow rough timestamps for a plain-text transcript")
    args = parser.parse_args()

    video_dir = ROOT / args.video_dir if not Path(args.video_dir).is_absolute() else Path(args.video_dir)
    input_path = video_dir / args.input_file if not Path(args.input_file).is_absolute() else Path(args.input_file)

    if not input_path.exists():
        console.print(f"[red]Error:[/red] Input file not found: {input_path}")
        sys.exit(1)

    content = input_path.read_text(encoding="utf-8")
    if not re.fullmatch(r"[a-z]{2,3}(?:-[A-Z]{2})?", args.lang):
        console.print("[red]Error:[/red] --lang must be a BCP 47 code such as hi or en-US")
        sys.exit(2)

    # ── Detect format
    fmt = args.format
    if fmt == "auto":
        ext = input_path.suffix.lower()
        fmt = ext.lstrip(".")
        if fmt not in ("srt", "vtt", "txt", "json"):
            fmt = "srt"

    # ── Parse
    console.print(f"\n[bold]Parsing {fmt.upper()}:[/bold] {input_path.name}")
    if fmt == "txt" and not args.allow_estimated_timing:
        console.print("[red]Error:[/red] Plain text has no reliable timing. Export SRT/VTT/JSON, or explicitly use --allow-estimated-timing for a rough draft.")
        sys.exit(2)
    parsers = {"srt": parse_srt, "vtt": parse_vtt, "txt": parse_txt, "json": parse_json}
    entries = parsers[fmt](content)
    try:
        validate_entries(entries)
    except (ValueError, TypeError, KeyError) as error:
        console.print(f"[red]Error:[/red] {error}")
        sys.exit(2)
    console.print(f"[green]✓[/green] {len(entries)} subtitle entries parsed")

    # ── Clean
    if not args.no_clean:
        for e in entries:
            e["text"] = clean_subtitle(e["text"], args.lang)
        # Remove empty entries after cleaning
        entries = [e for e in entries if e["text"].strip()]
        if not entries:
            console.print("[red]Error:[/red] No subtitle text remains after cleanup")
            sys.exit(2)
        console.print(f"[green]✓[/green] Cleanup applied ({len(entries)} entries after cleaning)")

    # ── Re-index
    for i, e in enumerate(entries, 1):
        e["index"] = i

    # ── Output
    subtitles_dir = video_dir / "06_publish" / "subtitles"
    subtitles_dir.mkdir(parents=True, exist_ok=True)

    lang = args.lang
    srt_out = subtitles_dir / f"{lang}.srt"
    vtt_out = subtitles_dir / f"{lang}.vtt"
    txt_out = subtitles_dir / f"{lang}_transcript.txt"

    srt_out.write_text(entries_to_srt(entries), encoding="utf-8")
    vtt_out.write_text(entries_to_vtt(entries), encoding="utf-8")
    txt_out.write_text(entries_to_txt(entries), encoding="utf-8")

    # ── Stats
    total_chars = sum(len(e["text"]) for e in entries)
    console.print()
    console.print(f"[green]✓[/green] {display_path(srt_out)}")
    console.print(f"[green]✓[/green] {display_path(vtt_out)}")
    console.print(f"[green]✓[/green] {display_path(txt_out)}")
    console.print()
    console.print(f"[dim]Stats: {len(entries)} entries | {total_chars:,} characters[/dim]")

    # Estimate duration
    if entries:
        last = entries[-1]
        end_parts = last["end"].split(":")
        try:
            h, m, s = float(end_parts[0]), float(end_parts[1]), float(end_parts[2])
            total_min = h * 60 + m + s / 60
            console.print(f"[dim]Duration: ~{total_min:.1f} minutes[/dim]")
        except Exception:
            pass

    console.print()
    console.print("[bold]Transcription tips:[/bold]")
    console.print(f"  • Use the strongest available model for [bold]{args.lang}[/bold]")
    console.print("  • Enable [bold]word timestamps[/bold] for chapter sync")
    console.print("  • Review txt transcript for corrections before uploading SRT")
    console.print()
    console.print("[bold]Next steps:[/bold]")
    console.print(f"  1. Review transcript: {display_path(txt_out)}")
    console.print(f"  2. Upload SRT to YouTube: {display_path(srt_out)}")
    console.print(f"  3. Upload VTT if needed:  {display_path(vtt_out)}")
    console.print()


if __name__ == "__main__":
    main()
