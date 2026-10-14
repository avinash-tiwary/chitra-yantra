#!/usr/bin/env python3
"""
script_gen.py — Generate Hindi YouTube script from research synthesis using Claude.

Stages:
  outline → Full structured outline with beats, timing, visual cue placeholders
  draft   → Full Hindi script from outline + synthesis (with [MAP:], [GEN:] etc.)
  final   → Refined final script with polished language and complete visual cues

Usage:
  python tools/script_gen.py channels/example-channel/videos/2026-04-14_example-topic/ --stage outline
  python tools/script_gen.py channels/example-channel/videos/2026-04-14_example-topic/ --stage draft
  python tools/script_gen.py channels/example-channel/videos/2026-04-14_example-topic/ --stage final
  python tools/script_gen.py channels/example-channel/videos/2026-04-14_example-topic/ --stage draft --model opus
"""

import argparse
import os
import re
import sys
from pathlib import Path
from datetime import datetime

from channel_context import channel_summary, load_channel

ROOT = Path(__file__).resolve().parent.parent

try:
    import anthropic
    from dotenv import load_dotenv
    for env_file in (ROOT / "config" / ".env", ROOT / ".env.local"):
        if env_file.is_file():
            load_dotenv(env_file)
except ImportError:
    print("Error: anthropic package not installed. Run: pip install anthropic python-dotenv")
    sys.exit(1)

try:
    from rich.console import Console
    from rich.panel import Panel
    from rich.rule import Rule
    from rich.live import Live
    from rich.text import Text
    console = Console()
    USE_RICH = True
except ImportError:
    class _Console:
        def print(self, *a, **kw): print(*a)
    console = _Console()
    USE_RICH = False


# ─── CHANNEL CONTEXT ─────────────────────────────────────────────────────────

def script_system_prompt(channel: dict) -> str:
    return f"""You are a senior long-form video scriptwriter.

CHANNEL BRIEF
{channel_summary(channel)}

RELEASE STANDARD
- Start in media res with a concrete tension; do not announce that a video is beginning.
- Build claims only from supplied research and attribute important evidence.
- Distinguish fact, inference, contested interpretation, and artistic reconstruction.
- Acknowledge counterevidence and uncertainty without flattening the narrative.
- Use natural spoken language for the configured audience; avoid filler and generic calls to action.
- Embed production cues as [MAP:], [ART:], [PHOTO:], [GEN:], [TEXT:], and [MUSIC:].
- Every AI reconstruction must be suitable for an on-screen artistic-interpretation label.
"""

OUTLINE_PROMPT = """Write a detailed VIDEO OUTLINE for a {language} YouTube video based on the research synthesis below.

The outline should specify:
1. HOOK (30s) — Exact opening moment/scene. What specific dramatic or surprising detail opens the video?
2. STAKES (1 min) — What is the central tension? Why does this matter today?
3. JOURNEY — 3 acts with specific beats (3-5 per act), estimated timing, and key visual moments
4. REVELATION — The single most important insight the viewer takes away
5. BIBLIOGRAPHY — Top 5 sources to read on screen
6. CTA — Specific tease for next video

For each beat, note:
- What is said (key content in 1-2 sentences)
- Visual cue needed [MAP:], [ART:], [GEN:], etc.
- Estimated timing

Format in Markdown. Be specific — this outline drives the full script.

TARGET LENGTH: {target_length} minutes

VIDEO TITLE: {title}

RESEARCH SYNTHESIS:
{synthesis}"""

DRAFT_PROMPT = """Write a COMPLETE {language} SCRIPT for a YouTube video based on the outline and research synthesis below.

Write in {language}. Embed all visual cue markers inline.

The full script should be narration-ready — every word spoken by the narrator, plus visual cues.

VIDEO TITLE: {title}
TARGET LENGTH: {target_length} minutes (~{word_count} words)

APPROVED OUTLINE:
{outline}

RESEARCH SYNTHESIS (factual backbone — use this for all claims):
{synthesis}

EXCLUDED OR UNVERIFIED CLAIMS — do not repeat these as facts:
{excluded_claims}

Write the COMPLETE SCRIPT now. Start directly with the HOOK — no preamble."""

FINAL_PROMPT = """Polish and finalize this {language} YouTube script.

Review for:
1. Narrative flow — does each section lead naturally to the next?
2. Language quality — natural spoken {language}, not translated or literal prose
3. Visual cues — are all [GEN:]/[MAP:]/[ART:] markers complete and specific enough?
4. Citations — are key claims attributed to sources inline?
5. Hook strength — is the opening truly compelling?
6. CTA specificity — is the next video tease intriguing?
7. Pacing — mark [PAUSE] where silence adds impact, [SLOW] where narration should slow

Return the complete polished script.

VIDEO TITLE: {title}

DRAFT SCRIPT:
{draft}

RESEARCH SYNTHESIS (for fact-checking):
{synthesis}

EXCLUDED OR UNVERIFIED CLAIMS — remove or qualify them:
{excluded_claims}"""


# ─── HELPERS ─────────────────────────────────────────────────────────────────

def read_video_meta(video_dir: Path) -> dict:
    meta = {"title": video_dir.name, "title_en": "", "slug": "", "episode": ""}
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


def load_research(video_dir: Path) -> str:
    """Find and bundle the pure research corpus documents for scripting, excluding discarded material."""
    corpus_dir = video_dir / "01_research" / "corpus"
    if corpus_dir.exists():
        pure_files = sorted(corpus_dir.glob("research_corpus*.md"), reverse=True) or sorted(corpus_dir.glob("synthesis_v*.md"), reverse=True)
        if pure_files:
            return pure_files[0].read_text(encoding="utf-8")

    candidates = [
        video_dir / "01_research" / "synthesis.md",
        video_dir / "01_research" / "working_notes" / "synthesis.md",
        video_dir / "01_research" / "initial_brief.md",
    ]
    for c in candidates:
        if c.exists():
            return c.read_text(encoding="utf-8")

    # Fallback: any .md in 01_research, excluding discarded and factcheck reports
    for research_dir in [video_dir / "01_research"]:
        if research_dir.exists():
            docs = []
            for f in sorted(research_dir.rglob("*.md")):
                if "discarded" in str(f) or f.name.startswith("factcheck") or f.name.startswith("material_discarded"):
                    continue
                if f.stat().st_size > 500:
                    docs.append(f.read_text(encoding="utf-8"))
            if docs:
                return "\n\n---\n\n".join(docs)

    return ""


def load_excluded_claims(video_dir: Path) -> str:
    """Carry editorial rejections into every generation pass, not only the UI."""
    candidates = [
        video_dir / "01_research" / "material_discarded.md",
        video_dir / "01_research" / "claim_ledger.json",
        video_dir / "02_script" / "claim_ledger.json",
    ]
    parts = []
    for candidate in candidates:
        if not candidate.is_file():
            continue
        try:
            if candidate.suffix == ".json":
                import json
                claims = json.loads(candidate.read_text(encoding="utf-8")).get("claims", [])
                parts.extend(str(claim.get("claim", "")) for claim in claims if claim.get("status") in {"DISCARDED", "UNVERIFIED"})
            else:
                parts.append(candidate.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            continue
    return "\n".join(parts)[:8000] or "No explicit exclusions recorded."


find_synthesis = load_research


def estimate_word_count(minutes: int) -> int:
    # Hindi narration: ~120-140 words/minute
    return minutes * 130


def language_label(code: str) -> str:
    names = {"hi": "Hindi (Devanagari)", "en": "English", "sa": "Sanskrit (Devanagari)"}
    normalized = (code or "hi").split("-", 1)[0].lower()
    return names.get(normalized, code or "Hindi (Devanagari)")


def stream_claude(client, model: str, system: str, prompt: str, max_tokens: int = 8000) -> str:
    """Stream Claude response and show it live."""
    full_text = ""

    try:
        with client.messages.stream(
            model=model,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": prompt}]
        ) as stream:
            if USE_RICH:
                console.print("[dim]Generating...[/dim]")
            for text_chunk in stream.text_stream:
                full_text += text_chunk
                if USE_RICH:
                    print(text_chunk, end="", flush=True)
                else:
                    print(text_chunk, end="", flush=True)
            print()  # newline after streaming
    except Exception as e:
        console.print(f"\n[red]Generation error: {e}[/red]")
        # Try non-streaming fallback
        try:
            response = client.messages.create(
                model=model,
                max_tokens=max_tokens,
                system=system,
                messages=[{"role": "user", "content": prompt}]
            )
            full_text = response.content[0].text
            print(full_text)
        except Exception as e2:
            console.print(f"[red]Fallback also failed: {e2}[/red]")

    return full_text


# ─── MAIN ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Generate Hindi YouTube script using Claude."
    )
    parser.add_argument("video_dir",
                        help="Path to video directory")
    parser.add_argument("--stage", default="outline",
                        choices=["outline", "draft", "final"],
                        help="Script stage to generate (default: outline)")
    parser.add_argument("--length", type=int, default=25,
                        help="Target video length in minutes (default: 25)")
    parser.add_argument("--language", default="hi",
                        help="BCP-47 script language (for example hi or en)")
    parser.add_argument("--words-per-minute", type=int, default=130,
                        help="Narration rate used for the target word budget")
    parser.add_argument("--model", default="sonnet",
                        choices=["sonnet", "opus"],
                        help="Claude model: sonnet (fast) or opus (best quality) (default: sonnet)")
    parser.add_argument("--input", default=None,
                        help="Input file path (override auto-detection)")
    parser.add_argument("--output", default=None,
                        help="Exact additive output path supplied by the pipeline")
    args = parser.parse_args()

    # ── Resolve path
    video_dir = ROOT / args.video_dir if not Path(args.video_dir).is_absolute() else Path(args.video_dir)
    if not video_dir.exists():
        console.print(f"[red]Error:[/red] Directory not found: {video_dir}")
        sys.exit(1)

    # ── API key
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        console.print("[red]Error:[/red] ANTHROPIC_API_KEY not set in config/.env or the environment")
        sys.exit(1)

    client = anthropic.Anthropic(api_key=api_key)
    model_id = os.getenv("ANTHROPIC_OPUS_MODEL", "claude-opus-4-8") if args.model == "opus" else os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-6")

    meta = read_video_meta(video_dir)
    system_prompt = script_system_prompt(load_channel(video_dir))
    title = meta["title"]
    script_dir = video_dir / "02_script"
    script_dir.mkdir(exist_ok=True)

    word_count = args.length * args.words_per_minute
    language = language_label(args.language)
    excluded_claims = load_excluded_claims(video_dir)

    console.print()
    if USE_RICH:
        console.print(Panel(
            f"[bold cyan]Script Generator[/bold cyan]\n\n"
            f"Stage:  [yellow]{args.stage}[/yellow]\n"
            f"Model:  [yellow]{model_id}[/yellow]\n"
            f"Title:  [white]{title}[/white]\n"
            f"Target: [white]{args.length} min (~{word_count} words at {args.words_per_minute} WPM)[/white]",
            expand=False
        ))
    console.print()

    # ── Stage: OUTLINE
    if args.stage == "outline":
        synthesis = find_synthesis(video_dir) if not args.input else Path(args.input).read_text()
        if not synthesis:
            console.print("[red]Error:[/red] No research synthesis found.")
            console.print(f"Run first: python tools/deep_research.py {args.video_dir}")
            sys.exit(1)

        console.print(f"[bold]Generating outline from synthesis ({len(synthesis):,} chars)...[/bold]")
        console.print(Rule() if USE_RICH else "─" * 60)

        prompt = OUTLINE_PROMPT.format(
            title=title,
            target_length=args.length,
            language=language,
            synthesis=synthesis[:10000]
        )
        result = stream_claude(client, model_id, system_prompt, prompt, max_tokens=4000)

        output_path = Path(args.output) if args.output else script_dir / "outline.md"
        if result:
            # Add header
            header = f"# Script Outline — {title}\n\n*Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')} | Model: {model_id} | Target: {args.length} min*\n\n---\n\n"
            output_path.write_text(header + result, encoding="utf-8")
            console.print(f"\n[green]✓ Outline saved:[/green] {output_path.relative_to(ROOT)}")
            console.print("\n[bold]Next steps:[/bold]")
            console.print(f"  1. Review and edit: {output_path.relative_to(ROOT)}")
            console.print(f"  2. Generate draft:  python tools/script_gen.py {args.video_dir} --stage draft")

    # ── Stage: DRAFT
    elif args.stage == "draft":
        synthesis = find_synthesis(video_dir) if not args.input else Path(args.input).read_text()
        if not synthesis:
            console.print("[red]Error:[/red] No research synthesis found.")
            sys.exit(1)

        outlines = sorted(script_dir.glob("outline_v*_*.md"), reverse=True)
        outline_path = outlines[0] if outlines else script_dir / "outline.md"
        outline = ""
        if outline_path.exists():
            outline = outline_path.read_text(encoding="utf-8")
            console.print(f"[green]✓[/green] Using outline: {outline_path.name}")
        else:
            console.print("[yellow]⚠[/yellow] No outline found — generating draft directly from synthesis")
            outline = "No outline available — use synthesis structure."

        console.print(f"[bold]Generating full {language} draft ({args.length} min target)...[/bold]")
        console.print("[dim]This may take 2-5 minutes for a full video script.[/dim]")
        console.print(Rule() if USE_RICH else "─" * 60)

        prompt = DRAFT_PROMPT.format(
            title=title,
            target_length=args.length,
            word_count=word_count,
            language=language,
            outline=outline[:3000],
            synthesis=synthesis[:6000],
            excluded_claims=excluded_claims,
        )
        result = stream_claude(client, model_id, system_prompt, prompt, max_tokens=8000)

        output_path = Path(args.output) if args.output else script_dir / "draft.md"
        if result:
            header = f"# Script Draft — {title}\n\n*Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')} | Model: {model_id} | Target: {args.length} min*\n\n---\n\n"
            output_path.write_text(header + result, encoding="utf-8")
            console.print(f"\n[green]✓ Draft saved:[/green] {output_path.relative_to(ROOT)}")
            console.print("\n[bold]Next steps:[/bold]")
            console.print(f"  1. Review and edit: {output_path.relative_to(ROOT)}")
            console.print(f"  2. Extract visuals:  python tools/asset_extractor.py {args.video_dir}")
            console.print(f"  3. Polish final:     python tools/script_gen.py {args.video_dir} --stage final")

    # ── Stage: FINAL
    elif args.stage == "final":
        drafts = sorted([*script_dir.glob("draft_v*_*.md"), *script_dir.glob("script_v*_*.md")], reverse=True)
        draft_path = drafts[0] if drafts else script_dir / "draft.md"
        if args.input:
            draft = Path(args.input).read_text()
        elif draft_path.exists():
            draft = draft_path.read_text(encoding="utf-8")
        else:
            console.print("[red]Error:[/red] No draft found. Run --stage draft first.")
            sys.exit(1)

        synthesis = find_synthesis(video_dir)

        console.print(f"[bold]Polishing final script...[/bold]")
        console.print(Rule() if USE_RICH else "─" * 60)

        prompt = FINAL_PROMPT.format(
            title=title,
            language=language,
            draft=draft[:10000],
            synthesis=synthesis[:3000] if synthesis else "",
            excluded_claims=excluded_claims,
        )
        result = stream_claude(client, model_id, system_prompt, prompt, max_tokens=8000)

        output_path = Path(args.output) if args.output else script_dir / "final.md"
        if result:
            header = f"# Final Script — {title}\n\n*Finalized: {datetime.now().strftime('%Y-%m-%d %H:%M')} | Model: {model_id}*\n\n---\n\n"
            output_path.write_text(header + result, encoding="utf-8")
            console.print(f"\n[green]✓ Final script saved:[/green] {output_path.relative_to(ROOT)}")
            console.print("\n[bold]Next steps:[/bold]")
            console.print(f"  1. Extract visuals:  python tools/asset_extractor.py {args.video_dir}")
            console.print(f"  2. Generate metadata: python tools/metadata_gen.py {args.video_dir}")
            console.print(f"  3. Update status:    Edit VIDEO.md status → recording")
    console.print()


if __name__ == "__main__":
    main()
