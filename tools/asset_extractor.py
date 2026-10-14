#!/usr/bin/env python3
"""
asset_extractor.py — Extract visual cues from script and organize assets.

Parses all [MAP:], [ART:], [GEN:], [PHOTO:], [TEXT:] markers from the script.
- [GEN:] → Expands to full Nano Banana / Stable Diffusion / Midjourney prompt
- [ART:] / [MAP:] → Searches Wikimedia Commons for matching images
- Creates organized assets/prompts.md with all prompts numbered and ready

Usage:
  python tools/asset_extractor.py channels/example-channel/videos/2026-04-14_example-topic/
  python tools/asset_extractor.py channels/example-channel/videos/2026-04-14_example-topic/ --script 02_script/final.md
  python tools/asset_extractor.py channels/example-channel/videos/2026-04-14_example-topic/ --download  # download Wikimedia images
"""

import argparse
import json
import re
import sys
from pathlib import Path
from urllib.parse import quote

from channel_context import load_channel

ROOT = Path(__file__).resolve().parent.parent

try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False

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

HEADERS = {"User-Agent": "ChitraYantra/2.0 (local editorial research tool)"}

# General visual-quality additions. Topic-specific historical context belongs in
# the asset description rather than in the shared tool.
GEN_STYLE_SUFFIX = ", cinematic 16:9 composition, high detail, internally consistent setting, no anachronisms"


def extract_cues(script_content: str) -> list[dict]:
    """Extract all visual cue markers from script text."""
    pattern = r'\[(MAP|ART|PHOTO|GEN|TEXT|MUSIC):\s*([^\]]+)\]'
    cues = []
    lines = script_content.split('\n')

    for line_num, line in enumerate(lines, 1):
        for match in re.finditer(pattern, line, re.IGNORECASE):
            cue_type = match.group(1).upper()
            description = match.group(2).strip()
            cues.append({
                "type": cue_type,
                "description": description,
                "line": line_num,
                "context": line.strip()[:100],
            })

    return cues


def build_gen_prompt(description: str, editorial_style: str = "") -> str:
    """Expand a [GEN:] description into a full image generation prompt."""
    desc_lower = description.lower()

    # Base prompt
    prompt = description

    # Add style
    prompt += GEN_STYLE_SUFFIX
    if editorial_style:
        prompt += f", visual direction: {editorial_style}"

    return prompt


def search_wikimedia(query: str, limit: int = 5) -> list[dict]:
    """Search Wikimedia Commons for images."""
    if not HAS_REQUESTS:
        return []

    url = "https://commons.wikimedia.org/w/api.php"
    params = {
        "action": "query",
        "list": "search",
        "srsearch": query,
        "srnamespace": "6",
        "srlimit": limit,
        "srprop": "snippet|titlesnippet",
        "format": "json",
    }
    try:
        resp = requests.get(url, params=params, headers=HEADERS, timeout=10)
        results = resp.json().get("query", {}).get("search", [])
        assets = []
        for r in results:
            title = r["title"]
            file_name = title.replace("File:", "")
            commons_url = f"https://commons.wikimedia.org/wiki/{quote(title.replace(' ', '_'))}"
            assets.append({
                "title": file_name,
                "commons_url": commons_url,
                "snippet": re.sub(r'<[^>]+>', '', r.get("snippet", ""))[:80],
            })
        return assets
    except Exception:
        return []


def download_wikimedia_image(commons_url: str, out_path: Path) -> bool:
    """Download a Wikimedia Commons image (best size available)."""
    if not HAS_REQUESTS:
        return False

    # Get file info via API
    file_title = commons_url.split("/wiki/")[-1].replace("_", " ")
    api_url = "https://commons.wikimedia.org/w/api.php"
    params = {
        "action": "query",
        "titles": file_title,
        "prop": "imageinfo",
        "iiprop": "url|size",
        "iiurlwidth": "1920",
        "format": "json",
    }
    try:
        resp = requests.get(api_url, params=params, headers=HEADERS, timeout=10)
        pages = resp.json().get("query", {}).get("pages", {})
        for page in pages.values():
            imageinfo = page.get("imageinfo", [{}])[0]
            img_url = imageinfo.get("thumburl") or imageinfo.get("url")
            if img_url:
                img_resp = requests.get(img_url, headers=HEADERS, timeout=30, stream=True)
                if img_resp.status_code == 200:
                    out_path.write_bytes(img_resp.content)
                    return True
    except Exception:
        pass
    return False


def main():
    parser = argparse.ArgumentParser(
        description="Extract visual cues from script and organize assets."
    )
    parser.add_argument("video_dir", help="Path to video directory")
    parser.add_argument("--script", default=None,
                        help="Script file path (default: auto-detect best available)")
    parser.add_argument("--download", action="store_true",
                        help="Download Wikimedia images found")
    parser.add_argument("--output", default=None,
                        help="Exact versioned asset-plan JSON path")
    parser.add_argument("--blueprint-output", default=None,
                        help="Exact versioned Editorial Blueprint JSON path")
    args = parser.parse_args()

    video_dir = ROOT / args.video_dir if not Path(args.video_dir).is_absolute() else Path(args.video_dir)
    if not video_dir.exists():
        console.print(f"[red]Error:[/red] Directory not found: {video_dir}")
        sys.exit(1)
    channel = load_channel(video_dir)
    editorial_style = str(channel.get("style", ""))[:500]

    # ── Find script
    if args.script:
        script_path = video_dir / args.script if not Path(args.script).is_absolute() else Path(args.script)
    else:
        # Priority: final → draft → outline across 02_script and script
        candidate_paths = [
            *sorted((video_dir / "02_script").glob("script_v*_*.md"), reverse=True),
            video_dir / "02_script" / "final.md",
            video_dir / "02_script" / "draft.md",
            video_dir / "02_script" / "outline.md",
        ]
        script_path = None
        for candidate in candidate_paths:
            if candidate.exists():
                script_path = candidate
                break

    if not script_path or not script_path.exists():
        console.print("[red]Error:[/red] No script found in 02_script/.")
        console.print(f"Run first: python tools/script_gen.py {args.video_dir} --stage draft")
        sys.exit(1)

    script_content = script_path.read_text(encoding="utf-8")
    console.print(f"\n[bold]Extracting visual cues from:[/bold] {script_path.relative_to(ROOT)}")

    # ── Extract cues
    cues = extract_cues(script_content)

    gen_cues = [c for c in cues if c["type"] == "GEN"]
    art_cues = [c for c in cues if c["type"] == "ART"]
    map_cues = [c for c in cues if c["type"] == "MAP"]
    photo_cues = [c for c in cues if c["type"] == "PHOTO"]
    text_cues = [c for c in cues if c["type"] == "TEXT"]

    console.print(f"\n[green]Found {len(cues)} visual cues:[/green]")
    console.print(f"  [GEN]   {len(gen_cues)} AI generation prompts")
    console.print(f"  [ART]   {len(art_cues)} artwork/historical images")
    console.print(f"  [MAP]   {len(map_cues)} maps")
    console.print(f"  [PHOTO] {len(photo_cues)} photographs")
    console.print(f"  [TEXT]  {len(text_cues)} on-screen text cards")

    # ── Build prompts.md
    assets_dir = video_dir / "04_visuals"
    visuals_dir = assets_dir / "renders"
    visuals_dir.mkdir(parents=True, exist_ok=True)

    lines = ["# Visual Asset Prompts\n"]
    lines.append(f"*Extracted from: {script_path.name} on {__import__('datetime').datetime.now().strftime('%Y-%m-%d')}*\n")
    lines.append(f"*Total cues: {len(cues)} | GEN: {len(gen_cues)} | ART: {len(art_cues)} | MAP: {len(map_cues)}*\n\n---\n")

    # GEN prompts
    if gen_cues:
        lines.append("\n## AI Generation Prompts [GEN:]\n")
        lines.append("*Use with Nano Banana Pro / Stable Diffusion / Midjourney / DALL-E 3*\n")
        lines.append("*Always add on-screen note: `कलात्मक कल्पना` (artistic interpretation)*\n\n")

        gen_table_rows = []
        for i, cue in enumerate(gen_cues, 1):
            full_prompt = build_gen_prompt(cue["description"], editorial_style)
            lines.append(f"### GEN-{i:02d}\n")
            lines.append(f"**Original:** `{cue['description']}`\n\n")
            lines.append(f"**Full prompt:**\n```\n{full_prompt}\n```\n\n")
            lines.append(f"**Script context (line {cue['line']}):** *{cue['context']}*\n\n")
            lines.append(f"**Status:** [ ] Not started | File: `04_visuals/renders/gen_{i:02d}.jpg`\n\n---\n")
            gen_table_rows.append((str(i), cue["description"][:50], "⬜ Pending"))

    # ART / MAP / PHOTO with Wikimedia search
    for cue_type, cue_list, label in [
        ("ART", art_cues, "Historical Artwork [ART:]"),
        ("MAP", map_cues, "Maps [MAP:]"),
        ("PHOTO", photo_cues, "Photographs [PHOTO:]"),
    ]:
        if not cue_list:
            continue
        lines.append(f"\n## {label}\n\n")

        for i, cue in enumerate(cue_list, 1):
            lines.append(f"### {cue_type}-{i:02d}: {cue['description'][:60]}\n\n")

            # Search Wikimedia Commons
            console.print(f"  Searching Wikimedia for: {cue['description'][:50]}...")
            results = search_wikimedia(cue["description"], limit=4)

            if results:
                lines.append("**Wikimedia Commons matches:**\n\n")
                for r in results:
                    lines.append(f"- [{r['title']}]({r['commons_url']})\n")
                    if r["snippet"]:
                        lines.append(f"  *{r['snippet']}*\n")

                # Download if requested
                if args.download and results:
                    safe_name = re.sub(r'[^\w-]', '_', cue["description"][:30].lower())
                    out_path = visuals_dir / f"{cue_type.lower()}_{i:02d}_{safe_name}.jpg"
                    console.print(f"  Downloading best match to {out_path.name}...")
                    success = download_wikimedia_image(results[0]["commons_url"], out_path)
                    if success:
                        lines.append(f"\n**Downloaded:** `04_visuals/renders/{out_path.name}`\n")
                    else:
                        lines.append(f"\n**Download:** Failed — download manually from Wikimedia\n")
            else:
                lines.append("**No Wikimedia matches found.** Search manually:\n")
                lines.append(f"- [Wikimedia Commons](https://commons.wikimedia.org/w/index.php?search={quote(cue['description'])})\n")
                lines.append(f"- [Google Arts & Culture](https://artsandculture.google.com)\n")
                lines.append(f"- [Met Museum Open Access](https://www.metmuseum.org/art/collection)\n")

            lines.append(f"\n**Status:** [ ] Not sourced | File: `04_visuals/renders/{cue_type.lower()}_{i:02d}.jpg`\n\n---\n")

    # TEXT cues
    if text_cues:
        lines.append("\n## On-Screen Text Cards [TEXT:]\n\n")
        lines.append("| # | Text | Line | Notes |\n|---|------|------|-------|\n")
        for i, cue in enumerate(text_cues, 1):
            lines.append(f"| {i} | {cue['description']} | {cue['line']} | |\n")

    # Summary
    lines.append("\n\n---\n\n## Asset Checklist\n\n")
    for i in range(1, len(gen_cues) + 1):
        lines.append(f"- [ ] GEN-{i:02d} generated\n")
    for i in range(1, len(art_cues) + 1):
        lines.append(f"- [ ] ART-{i:02d} sourced\n")
    for i in range(1, len(map_cues) + 1):
        lines.append(f"- [ ] MAP-{i:02d} sourced\n")

    prompts_path = assets_dir / "prompts.md"
    prompts_path.write_text("".join(lines), encoding="utf-8")

    # ── Emit structured asset_manifest.json
    manifest = []
    for cue in cues:
        c_type = cue["type"]
        desc = cue["description"]
        prompt = build_gen_prompt(desc, editorial_style) if c_type == "GEN" else desc
        manifest.append({
            "id": f"ASSET_{len(manifest) + 1:03d}",
            "type": c_type,
            "description": desc,
            "prompt": prompt,
            "generatedPath": None,
            "sourceUrl": None,
            "license": None,
            "attribution": None,
            "approvalStatus": "pending",
            "sourceKind": "ai_generated" if c_type == "GEN" else "cleared_archive",
            "sourceSuggestion": f"Line {cue['line']}: {cue['context'][:80]}" if cue.get("context") else None,
            "production": {
                "brief": desc,
                "generationPrompt": prompt if c_type == "GEN" else "",
                "negativePrompt": "modern objects, text, watermark, logo, distorted architecture, anachronistic costume" if c_type == "GEN" else "",
                "aspectRatio": "16:9", "framing": "", "lighting": "",
                "collectionBrief": "" if c_type == "GEN" else f"Find an authentic, rights-cleared image that directly depicts: {desc}. Prefer museum, archive, government, or CC collection records; retain the item page, creator/date, licence and attribution.",
                "searchQueries": [] if c_type == "GEN" else [desc],
                "preferredCollections": [] if c_type == "GEN" else ["Wikimedia Commons", "museum open-access collection", "government/archive collection"],
                "requiredEvidence": "" if c_type == "GEN" else "Item page URL, direct file URL, licence, creator/date, attribution and any crop restrictions.",
            },
        })

    assets_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = Path(args.output) if args.output else assets_dir / "asset_manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")

    # The Python path is intentionally a conservative skeleton.  An editorial
    # agent enriches it with evidence links, sound design and exact timing, but
    # this preserves a usable, reviewable hand-off for offline workflows.
    blueprint_path = Path(args.blueprint_output) if args.blueprint_output else manifest_path.with_name(
        manifest_path.name.replace("asset_plan_", "editorial_blueprint_")
    )
    duration = 5.0
    beats = []
    for index, asset in enumerate(manifest):
        cue_type = asset["type"]
        start = round(index * duration, 3)
        is_ai = cue_type == "GEN"
        beats.append({
            "id": f"BEAT_{index + 1:03d}",
            "narration": {"anchor": asset["description"], "scriptLines": []},
            "timing": {"startSeconds": start, "endSeconds": round(start + duration, 3), "basis": "script_estimate"},
            "visual": {
                "type": "ai_generated" if is_ai else "cleared_archive",
                "primaryAssetId": asset["id"],
                "purpose": "Illustrate the narration cue.",
                "motion": {"type": "push_in" if is_ai else "pan_left", "intensity": "subtle", "rationale": "Keep the faceless edit moving while preserving legibility."},
                "transitionIn": "cut" if index == 0 else "crossfade", "transitionOut": "crossfade",
            },
            "text": {"overlay": "", "citation": "", "aiDisclosure": is_ai},
            "audio": {"musicCueId": None, "musicBrief": "", "sfx": [], "sfxBrief": "", "silenceSeconds": 0, "narrationPriority": True},
            "source": {"status": "not_applicable" if is_ai else "needs_review", "url": None, "license": None, "attribution": None},
            "status": "draft",
        })
    blueprint = {
        "schemaVersion": 1, "title": f"Editorial Blueprint — {video_dir.name}",
        "version": int(re.search(r"_v(\\d+)", blueprint_path.name).group(1)) if re.search(r"_v(\\d+)", blueprint_path.name) else 1,
        "timing": {"basis": "script_estimate", "targetDurationSeconds": round(len(beats) * duration), "reconciledAt": None},
        "creativeDirection": {"channelMode": "faceless", "visualRhythm": "Meaningful visual change every 2–6 seconds."},
        "assets": manifest, "beats": beats,
    }
    blueprint_path.parent.mkdir(parents=True, exist_ok=True)
    blueprint_path.write_text(json.dumps(blueprint, indent=2, ensure_ascii=False), encoding="utf-8")
    audio_plan_dir = video_dir / "03_audio" / "plans"
    audio_plan_dir.mkdir(parents=True, exist_ok=True)
    version = blueprint["version"]
    (audio_plan_dir / f"audio_plan_v{version}.json").write_text(json.dumps({
        "schemaVersion": 1, "blueprint": str(blueprint_path.relative_to(video_dir)),
        "narration": {"priority": "primary", "timingBasis": "script_estimate"},
        "musicCues": [], "sfx": [], "silence": [],
        "mixTargets": {"musicUnderNarration": "-32 to -25 LUFS-S", "final": "-14 LUFS-I"},
    }, indent=2, ensure_ascii=False), encoding="utf-8")

    # ── Emit thumbnail brief if missing
    for thumb_dir in [video_dir / "04_visuals" / "thumbnails"]:
        thumb_dir.mkdir(parents=True, exist_ok=True)
        brief_file = thumb_dir / "brief.md"
        if not brief_file.exists() or len(brief_file.read_text(encoding="utf-8").strip()) < 50:
            brief_file.write_text(
                f"# Thumbnail Concept Brief\n\n"
                f"**Video:** {video_dir.name}\n\n"
                f"## Visual Hook\n"
                f"- **Focal subject:** Derive one unmistakable subject from the approved script.\n"
                f"- **Color palette:** Match the channel identity and the subject's historical material.\n"
                f"- **Text overlay:** Maximum five words; add only if it creates useful tension.\n"
                f"- **Framing:** One focal plane, clear mobile silhouette, and generous safe area.\n",
                encoding="utf-8"
            )

    console.print(f"\n[green]✓ Asset prompts saved:[/green] {prompts_path.relative_to(ROOT)}")
    console.print(f"[green]✓ Asset manifest saved:[/green] {manifest_path.relative_to(video_dir)} ({len(manifest)} cues)")
    console.print(f"[green]✓ Editorial Blueprint saved:[/green] {blueprint_path.relative_to(video_dir)}")
    console.print(f"\n[bold]Next steps:[/bold]")
    console.print(f"  1. Review prompts:    {prompts_path.relative_to(ROOT)}")
    console.print(f"  2. Generate GEN images in Nano Banana Pro")
    console.print(f"  3. Download ART/MAP assets from Wikimedia Commons")
    console.print(f"  4. Generate metadata: python tools/metadata_gen.py {args.video_dir}")
    console.print()


if __name__ == "__main__":
    main()
