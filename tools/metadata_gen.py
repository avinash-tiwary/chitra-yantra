#!/usr/bin/env python3
"""
metadata_gen.py — Generate YouTube metadata (title, description, tags, chapters) using Claude.

Usage:
  python tools/metadata_gen.py channels/example-channel/videos/2026-04-14_example-topic/
  python tools/metadata_gen.py channels/example-channel/videos/2026-04-14_example-topic/ --lang hi
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

from channel_context import channel_summary, load_channel

ROOT = Path(__file__).resolve().parent.parent

try:
    import anthropic
    from dotenv import load_dotenv
    for env_file in (ROOT / "config" / ".env", ROOT / ".env.local"):
        if env_file.is_file():
            load_dotenv(env_file)
except ImportError:
    print("Error: pip install anthropic python-dotenv")
    sys.exit(1)

try:
    from rich.console import Console
    from rich.panel import Panel
    console = Console()
    USE_RICH = True
except ImportError:
    class _Console:
        def print(self, *a, **kw): print(*a)
    console = _Console()
    USE_RICH = False

METADATA_PROMPT = """Generate accurate, compelling YouTube metadata for this production.

CHANNEL BRIEF:
{channel_brief}

VIDEO:
- Title: {title}
- Metadata language: {language}
- Script excerpt (first 2000 chars):
{script_excerpt}

RESEARCH SYNTHESIS (for keywords):
{synthesis_excerpt}

Generate metadata in this exact JSON format:
{{
  "title": "Accurate title in the configured language; front-load the subject; 60 characters preferred and 100 maximum",
  "title_variants": ["3 alternative title options"],
  "description": "Full YouTube description (see format below)",
  "tags": ["Focused broad and specific search terms; include configured channel tags when relevant"],
  "chapters": [
    {{"time": "00:00", "title": "Title"}},
    ...chapters derived from script structure...
  ],
  "pinned_comment": "Full bibliography for a top-level comment — Chicago format, all sources used",
  "thumbnail_text": "Short, accurate thumbnail phrase in the configured language (max 5 words)",
  "thumbnail_visual": "Description of ideal thumbnail image"
}}

DESCRIPTION FORMAT:
Line 1-2: Hook — most intriguing fact (shown before 'more' cutoff, ~100 chars)
Line 3: blank
Para 1 (3-4 sentences): What this video reveals about the topic
Para 2 (2-3 sentences): What the viewer will learn
blank line
TIMESTAMPS: (list chapters with times)
blank line
Para 3: Sources & bibliography (abbreviated — full list in pinned comment)
blank line
Channel: use the configured channel identity above; do not invent social links
blank line
Tags: (comma-separated, 10-15)

IMPORTANT:
- Match the configured channel language and editorial style
- Never invent facts, citations, links, or chapter timing
- Chapters should match the script structure
- Pinned comment should have the full bibliography
- thumbnail_text must be at most 5 words and must not overstate the evidence

Return ONLY valid JSON."""


def read_video_meta(video_dir: Path) -> dict:
    meta = {"title": video_dir.name, "title_en": "", "slug": "", "channel": "example-channel"}
    video_md = video_dir / "VIDEO.md"
    if not video_md.exists():
        readme = video_dir / "README.md"
        if readme.exists():
            match = re.search(r"^#\s+(.+)$", readme.read_text(encoding="utf-8"), re.MULTILINE)
            if match:
                meta["title"] = match.group(1).strip()
        return meta
    content = video_md.read_text(encoding="utf-8")
    in_fm = False
    for line in content.split("\n"):
        if line.strip() == "---":
            if not in_fm:
                in_fm = True
                continue
            else:
                break
        if in_fm and ":" in line:
            key, _, val = line.partition(":")
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key in meta:
                meta[key] = val
    return meta


def find_script(video_dir: Path) -> tuple[str, str]:
    """Returns (script_content, script_name)."""
    script_dir = video_dir / "02_script"
    versioned = sorted(script_dir.glob("script_v*_*.md"), reverse=True)
    if versioned:
        return versioned[0].read_text(encoding="utf-8"), versioned[0].name
    for name in ["final.md", "draft.md"]:
        p = script_dir / name
        if p.exists():
            return p.read_text(encoding="utf-8"), name
    return "", ""


def find_synthesis(video_dir: Path) -> str:
    candidates = [
        *sorted((video_dir / "01_research" / "corpus").glob("synthesis_v*.md"), reverse=True),
        video_dir / "01_research" / "synthesis.md",
        video_dir / "01_research" / "working_notes" / "synthesis.md",
    ]
    for c in candidates:
        if c.exists():
            return c.read_text(encoding="utf-8")[:3000]
    return ""


def main():
    parser = argparse.ArgumentParser(description="Generate YouTube metadata using Claude.")
    parser.add_argument("video_dir", help="Path to video directory")
    parser.add_argument("--lang", default="hi", help="BCP-47 video language (default: hi)")
    parser.add_argument("--output", type=Path, help="Exact versioned metadata output path")
    args = parser.parse_args()

    video_dir = ROOT / args.video_dir if not Path(args.video_dir).is_absolute() else Path(args.video_dir)
    if not video_dir.exists():
        console.print(f"[red]Error:[/red] Not found: {video_dir}")
        sys.exit(1)

    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        console.print("[red]Error:[/red] ANTHROPIC_API_KEY not set in config/.env or the environment")
        sys.exit(1)

    client = anthropic.Anthropic(api_key=api_key)
    meta = read_video_meta(video_dir)
    channel = load_channel(video_dir)
    script, script_name = find_script(video_dir)
    synthesis = find_synthesis(video_dir)

    if not script:
        console.print("[yellow]⚠ No script found — generating metadata from title and synthesis only[/yellow]")

    console.print(f"\n[bold]Generating YouTube metadata for:[/bold] {meta['title']}")

    prompt = METADATA_PROMPT.format(
        title=meta["title"],
        channel_brief=channel_summary(channel),
        language=args.lang,
        script_excerpt=script[:2000] if script else "(no script yet)",
        synthesis_excerpt=synthesis[:2000] if synthesis else "(no synthesis yet)",
    )

    try:
        response = client.messages.create(
            model=os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-6"),
            max_tokens=3000,
            messages=[{"role": "user", "content": prompt}]
        )
        text = response.content[0].text.strip()
        # Strip markdown code blocks
        text = re.sub(r"^```json\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
        metadata = json.loads(text)
        if not isinstance(metadata, dict):
            raise ValueError("Metadata response must be a JSON object")
        title = str(metadata.get("title", "")).strip()
        description = str(metadata.get("description", "")).strip()
        tags = [str(tag).strip() for tag in metadata.get("tags", []) if str(tag).strip()]
        if not title or len(title) > 100:
            raise ValueError("Generated title must contain 1–100 characters")
        if not description or len(description) > 5000:
            raise ValueError("Generated description must contain 1–5000 characters")
        if len(",".join(tags)) > 500:
            raise ValueError("Generated tags exceed YouTube's 500-character aggregate limit")
        metadata["title"], metadata["description"], metadata["tags"] = title, description, tags
    except json.JSONDecodeError as e:
        console.print(f"[red]JSON parse error:[/red] {e}")
        publish_dir = video_dir / "06_publish"
        publish_dir.mkdir(parents=True, exist_ok=True)
        console.print("[dim]Raw response saved to 06_publish/metadata_raw.txt[/dim]")
        (publish_dir / "metadata_raw.txt").write_text(text, encoding="utf-8")
        sys.exit(1)
    except Exception as e:
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)

    # ── Save metadata.json
    publish_dir = video_dir / "06_publish"
    publish_dir.mkdir(exist_ok=True)

    # Merge with existing metadata.json template
    existing_meta_path = args.output.resolve() if args.output else publish_dir / "metadata_v1.json"
    existing = {}
    if existing_meta_path.exists():
        try:
            existing = json.loads(existing_meta_path.read_text(encoding="utf-8"))
        except Exception:
            pass

    merged = {
        **existing,
        "title": metadata.get("title", ""),
        "title_variants": metadata.get("title_variants", []),
        "description": metadata.get("description", ""),
        "tags": metadata.get("tags", []),
        "chapters": metadata.get("chapters", []),
        "pinned_comment": metadata.get("pinned_comment", ""),
        "thumbnail_text": metadata.get("thumbnail_text", ""),
        "thumbnail_visual": metadata.get("thumbnail_visual", ""),
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "generated_from": script_name or "synthesis",
        "category": "Education",
        "language": args.lang,
        "made_for_kids": False,
    }

    existing_meta_path.parent.mkdir(parents=True, exist_ok=True)
    existing_meta_path.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")

    # ── Save chapters.md
    chapters_md = publish_dir / "chapters.md"
    chapters_lines = [f"# YouTube Chapters — {meta['title']}\n\n"]
    chapters_lines.append("*Paste into YouTube description.*\n\n```\n")
    for ch in metadata.get("chapters", []):
        chapters_lines.append(f"{ch.get('time', '00:00')} {ch.get('title', '')}\n")
    chapters_lines.append("```\n")
    chapters_md.write_text("".join(chapters_lines), encoding="utf-8")

    # ── Display results
    console.print()
    if USE_RICH:
        console.print(Panel(
            f"[bold]Title:[/bold] {metadata.get('title', '')}\n\n"
            f"[bold]Thumbnail text:[/bold] {metadata.get('thumbnail_text', '')}\n\n"
            f"[bold]Tags ([/bold]{len(metadata.get('tags', []))}[bold]):[/bold] {', '.join(metadata.get('tags', [])[:8])}...\n\n"
            f"[bold]Chapters:[/bold] {len(metadata.get('chapters', []))} defined",
            title="[green]✓ Metadata Generated[/green]",
            expand=False
        ))
    else:
        print(f"Title: {metadata.get('title', '')}")
        print(f"Tags: {len(metadata.get('tags', []))} tags")
        print(f"Chapters: {len(metadata.get('chapters', []))}")

    console.print(f"\n[green]✓[/green] Saved: {existing_meta_path.relative_to(ROOT)}")
    console.print(f"[green]✓[/green] Saved: {chapters_md.relative_to(ROOT)}")

    # Show title variants
    variants = metadata.get("title_variants", [])
    if variants:
        console.print("\n[bold]Alternative titles:[/bold]")
        for v in variants:
            console.print(f"  • {v}")

    console.print("\n[bold]Next steps:[/bold]")
    console.print(f"  1. Review metadata:    {existing_meta_path.relative_to(ROOT)}")
    console.print(f"  2. Process subtitles:  python tools/subtitle_workflow.py {args.video_dir} <macwhisper.srt>")
    console.print()


if __name__ == "__main__":
    main()
