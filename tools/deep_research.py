#!/usr/bin/env python3
"""
deep_research.py — Multi-round deep research for a video topic using Claude.

Workflow:
  Round 1: Run research_aggregator.py → initial data (Wikipedia, Wikimedia, DuckDuckGo)
  Round 2: Claude analyzes initial brief, identifies gaps, generates follow-up queries
  Round 3: Run follow-up searches on identified gaps
  Round 4: Claude synthesizes everything → 01_research/synthesis.md

Usage:
  python tools/deep_research.py channels/example-channel/videos/YYYY-MM-DD_topic-slug/
  python tools/deep_research.py channels/example-channel/videos/example-topic/ --topic "Example topic" --no-synthesis
  python tools/deep_research.py --topic "Example topic" --out research_briefs/
"""

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.parse
from datetime import datetime
from pathlib import Path

from channel_context import channel_summary, load_channel
from fact_check import captured_evidence, check_claims
from research_sources import capture_sources, write_catalog

ROOT = Path(__file__).resolve().parent.parent

def canonical_url(value: str) -> str:
    """Normalize a source URL for cross-cycle deduplication."""
    try:
        parsed = urllib.parse.urlsplit(value.strip())
        query = [(key, val) for key, val in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
                 if not key.lower().startswith(("utm_", "fbclid", "gclid"))]
        return urllib.parse.urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), parsed.path.rstrip("/"), urllib.parse.urlencode(query), ""))
    except ValueError:
        return value.strip()

try:
    import anthropic
    from dotenv import load_dotenv
    for env_file in (ROOT / "config" / ".env", ROOT / ".env.local"):
        if env_file.is_file():
            load_dotenv(env_file)
    HAS_ANTHROPIC = True
except ImportError:
    HAS_ANTHROPIC = False

try:
    from ddgs import DDGS
    HAS_DDGS = True
except ImportError:
    HAS_DDGS = False

try:
    from rich.console import Console
    from rich.panel import Panel
    from rich.rule import Rule
    from rich.progress import Progress, SpinnerColumn, TextColumn
    console = Console()
    USE_RICH = True
except ImportError:
    class _Console:
        def print(self, *a, **kw): print(*a)
        def rule(self, *a, **kw): print("──────────────────────────────────")
    console = _Console()
    USE_RICH = False


# ─── HELPERS ─────────────────────────────────────────────────────────────────

def get_topic_from_video_md(video_dir: Path) -> tuple[str, str]:
    """Extract (title, title_en) from project_brief.md, VIDEO.md, or README.md."""
    brief = video_dir / "00_project" / "project_brief.md"
    if brief.is_file():
        match = re.search(r"^#\s+Project Brief:\s*(.+)$", brief.read_text(encoding="utf-8"), re.MULTILINE)
        if match:
            return match.group(1).strip(), ""
    video_md = video_dir / "VIDEO.md"
    if not video_md.exists():
        readme = video_dir / "README.md"
        if readme.is_file():
            match = re.search(r"^#\s+(.+)$", readme.read_text(encoding="utf-8"), re.MULTILINE)
            if match:
                return match.group(1).strip(), ""
        return "", ""
    content = video_md.read_text(encoding="utf-8")
    title, title_en = "", ""
    in_fm = False
    for line in content.split("\n"):
        if line.strip() == "---":
            if not in_fm:
                in_fm = True
                continue
            else:
                break
        if in_fm:
            if line.startswith("title:") and not line.startswith("title_en:"):
                title = line.split(":", 1)[1].strip().strip('"').strip("'")
            elif line.startswith("title_en:"):
                title_en = line.split(":", 1)[1].strip().strip('"').strip("'")
    return title, title_en


def get_premise_from_brief(video_dir: Path) -> str:
    """Extract premise & dramatic conflict from project_brief.md if present."""
    brief = video_dir / "00_project" / "project_brief.md"
    if brief.is_file():
        text = brief.read_text(encoding="utf-8")
        match = re.search(r"## Premise & Dramatic Conflict\s*\n([\s\S]*?)(?=\n## |\Z)", text)
        if match:
            return match.group(1).strip()
    return ""


def has_devanagari(text: str) -> bool:
    return bool(re.search(r"[\u0900-\u097F]", text))


def run_research_aggregator(topic: str, out_dir: Path, channel_name: str, language: str) -> Path | None:
    """Run the existing research_aggregator.py and return the output brief path."""
    script = ROOT / "tools" / "research_aggregator.py"
    if not script.exists():
        console.print("[yellow]research_aggregator.py not found — skipping initial brief[/yellow]")
        return None

    # Use a temporary aggregation folder before copying into 01_research/.
    brief_path = out_dir / "initial_brief.md"
    cmd = [sys.executable, str(script), topic, "--lang", language.split("-")[0], "--channel", channel_name, "--out", str(brief_path)]
    env = os.environ.copy()
    env["PYTHONPATH"] = str(ROOT)

    try:
        result = subprocess.run(
            cmd, cwd=str(ROOT), capture_output=True, text=True,
            timeout=120, env=env
        )
        if result.returncode != 0:
            console.print(f"[yellow]Aggregator warning: {result.stderr.strip() or 'non-zero exit'}[/yellow]")
            return None
        if brief_path.is_file():
            return brief_path
    except Exception as e:
        console.print(f"[yellow]Aggregator warning: {e}[/yellow]")
    return None


def search_academic(query: str, num: int = 5) -> list[dict]:
    """Search for academic/detailed results on a topic."""
    if not HAS_DDGS:
        return []
    results = []
    try:
        academic_query = f"{query} site:jstor.org OR site:academia.edu OR site:books.google.com"
        with DDGS() as ddgs:
            raw = list(ddgs.text(academic_query, max_results=num))
        for r in raw:
            results.append({
                "title": r.get("title", ""),
                "snippet": r.get("body", "")[:300],
                "url": r.get("href", ""),
            })
    except Exception:
        pass

    # General scholarly search
    try:
        general_query = f"{query} scholarly sources"
        with DDGS() as ddgs:
            raw = list(ddgs.text(general_query, max_results=num))
        for r in raw:
            results.append({
                "title": r.get("title", ""),
                "snippet": r.get("body", "")[:300],
                "url": r.get("href", ""),
            })
    except Exception:
        pass

    return results[:10]


def search_targeted(query: str, num: int = 5) -> list[dict]:
    """Run a targeted web search for a specific gap/question."""
    if not HAS_DDGS:
        return []
    results = []
    try:
        with DDGS() as ddgs:
            raw = list(ddgs.text(query, max_results=num))
        for r in raw:
            results.append({
                "title": r.get("title", ""),
                "snippet": r.get("body", "")[:300],
                "url": r.get("href", ""),
            })
    except Exception:
        pass
    return results


# ─── CLAUDE STEPS ─────────────────────────────────────────────────────────────

def research_system_prompt(channel: dict) -> str:
    return f"""You are a senior researcher for an evidence-led video production.

CHANNEL BRIEF
{channel_summary(channel)}

RESEARCH STANDARD
- Prefer primary and peer-reviewed sources; use reference sites only for discovery.
- Preserve source URLs and identify author, date, publication, and relevant claim where available.
- Separate established evidence, scholarly disagreement, inference, and unresolved uncertainty.
- Identify popular narratives that conflict with the evidence without manufacturing controversy.
- Find visual evidence and narrative moments that serve the argument.
- Never fabricate a citation, quotation, archive record, or scholarly consensus.
"""


def claude_analyze_brief(client, topic: str, brief_content: str, system_prompt: str, channel_name: str, model: str) -> dict:
    """Round 2: Claude analyzes initial brief and identifies research gaps."""
    console.print("[cyan]Claude: Analyzing initial brief and identifying gaps...[/cyan]")

    prompt = f"""I'm researching the topic "{topic}" for a video on {channel_name}.

Here is my initial research brief:

<brief>
{brief_content[:8000]}
</brief>

Please analyze this brief and respond in JSON with this structure:
{{
  "main_narrative": "What is the core story/argument this video should make?",
  "strongest_points": ["3-4 strongest facts/claims we can use"],
  "knowledge_gaps": ["5-8 specific things we DON'T know yet from this brief that would strengthen the video"],
  "follow_up_queries": ["6-10 specific web search queries to fill the gaps — be precise, not broad"],
  "primary_source_leads": ["Any primary source texts or databases to check"],
  "narrative_angle": "Suggested unique angle for the video that hasn't been done before",
  "visual_moments": ["5-6 most cinematic scenes/artifacts/moments to visualize"],
  "modern_relevance": "Why this matters to viewers in 2026",
  "debates_to_address": ["Key scholarly debates this video must acknowledge honestly"]
}}

Return ONLY valid JSON, no other text."""

    try:
        response = client.messages.create(
            model=model,
            max_tokens=2000,
            system=system_prompt,
            messages=[{"role": "user", "content": prompt}]
        )
        text = response.content[0].text.strip()
        # Strip markdown code blocks if present
        text = re.sub(r"^```json\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
        return json.loads(text)
    except Exception as e:
        console.print(f"[yellow]Analysis warning: {e}[/yellow]")
        return {"follow_up_queries": [], "knowledge_gaps": [], "narrative_angle": ""}


def claude_synthesize(client, topic: str, initial_brief: str,
                      analysis: dict, followup_results: list[dict], source_material: str, system_prompt: str,
                      channel_name: str, model: str) -> str:
    """Round 4: Claude synthesizes all research into a structured synthesis document."""
    console.print("[cyan]Claude: Synthesizing all research (extended thinking)...[/cyan]")

    followup_text = ""
    for i, r in enumerate(followup_results[:15], 1):
        followup_text += f"\n**Result {i}: {r['title']}**\n{r['snippet']}\nURL: {r['url']}\n"

    prompt = f"""You are synthesizing research for a video on {channel_name}.

**Topic:** {topic}

**Narrative angle identified:** {analysis.get('narrative_angle', '')}

**Initial Research Brief:**
<initial_brief>
{initial_brief[:6000]}
</initial_brief>

**Research Gap Analysis:**
- Knowledge gaps: {json.dumps(analysis.get('knowledge_gaps', []), ensure_ascii=False)}
- Debates to address: {json.dumps(analysis.get('debates_to_address', []), ensure_ascii=False)}
- Primary source leads: {json.dumps(analysis.get('primary_source_leads', []), ensure_ascii=False)}

**Follow-up Research Results:**
<followup>
{followup_text[:4000]}
</followup>

**Retrieved local source passages (cite these by URL; do not treat search snippets as evidence):**
<local_sources>
{source_material[:12000]}
</local_sources>

Evidence rules:
- Make a factual assertion only when it is supported by one of the retrieved
  local source passages, and append that source's exact URL to the assertion.
- Treat the initial brief and follow-up search results as discovery leads only.
  They may be listed as open questions, never laundered into evidence.
- If no captured passage supports a planned beat, put it under
  “Unresolved questions” rather than filling the gap from model knowledge.
- Preserve disagreement, uncertainty, date ranges, and source provenance.

Please write a comprehensive **Research Synthesis** document in Markdown that a scriptwriter can use directly. Structure it as:

# Research Synthesis — {topic}

## Narrative Arc
(Central question, mainstream understanding vs primary sources, key tension, resolution)

## Core Story Structure
(Hook moment, Stakes, Journey, Revelation)

## Key Arguments & Evidence
(Numbered, with sources)

## Debates We Must Address
(Scholarly disagreements — honest acknowledgment)

## Visual Opportunities
(Cinematic moments, artifacts, scenes)

## Modern Relevance
(Why 2026 viewers should care)

## Primary Sources to Reference
(GRETIL, ASI, inscriptions, etc.)

## Bibliography (Chicago format)
(Best sources found)

## Unresolved Questions & Evidence Gaps
(Claims that remain blocked from scripting)

---
*Synthesized: {datetime.now().strftime('%Y-%m-%d %H:%M')}*

Write in English for this synthesis document (the script will be in Hindi). Be thorough and specific."""

    try:
        response = client.messages.create(
            model=model,
            max_tokens=8000,
            thinking={
                "type": "enabled",
                "budget_tokens": 4000
            },
            system=system_prompt,
            messages=[{"role": "user", "content": prompt}]
        )
        # Extract text blocks only
        for block in response.content:
            if block.type == "text":
                return block.text
        return ""
    except Exception as e:
        # Fallback without extended thinking
        try:
            response = client.messages.create(
                model=model,
                max_tokens=4000,
                system=system_prompt,
                messages=[{"role": "user", "content": prompt}]
            )
            return response.content[0].text
        except Exception as e2:
            console.print(f"[red]Synthesis error: {e2}[/red]")
            return ""


# ─── MAIN ─────────────────────────────────────────────────────────────────────


def generate_fallback_synthesis(topic: str, premise: str, initial_brief: str, channel_name: str) -> str:
    """Produce a transparent discovery dossier without inventing historical claims."""
    sections = [
        f"# Research Discovery Dossier — {topic}\n",
        f"> Prepared for **{channel_name}** without an LLM synthesis. Search snippets and editorial notes below are leads, not verified evidence. The project remains blocked until source capture succeeds.\n",
    ]
    if premise:
        sections.append(f"## Editorial question (not a factual claim)\n{premise}\n")
    sections.append("## Extracted discovery notes (unverified)\n")
    brief_lines = [line.strip() for line in initial_brief.split("\n") if len(line.strip()) > 50 and not line.startswith("#")]
    if brief_lines:
        for idx, line in enumerate(brief_lines[:8], 1):
            sections.append(f"{idx}. {line}\n")
    else:
        sections.append("No substantive discovery text was returned. Add source leads and rerun this cycle.\n")

    sections.append("## Questions for the next evidence round\n")
    sections.append("- Which primary record, dataset, paper, or official archive directly supports each proposed narrative beat?\n")
    sections.append("- What date, authorship, translation, provenance, and scholarly disagreement must be checked before scripting?\n")
    sections.append("- Which visual materials have verifiable rights and provenance?\n")

    sections.append("## Source leads awaiting local capture\n")
    urls = re.findall(r"https?://[^\s)>\]]+", initial_brief)
    if urls:
        for u in sorted(set(urls))[:8]:
            sections.append(f"- <{u}>")
    else:
        sections.append("- Relevant primary-source catalogues and institutional archives.")

    sections.append(f"\n---\n*Synthesized: {datetime.now().strftime('%Y-%m-%d %H:%M')}*")
    return "\n\n".join(sections)


# ─── MAIN ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Deep multi-round research for a video topic."
    )
    parser.add_argument("video_dir", nargs="?", default=None,
                        help="Path to video directory (e.g. channels/example-channel/videos/2026-04-14_example-topic/)")
    parser.add_argument("--topic", default="",
                        help="Topic override (auto-read from VIDEO.md if not provided)")
    parser.add_argument("--topic-en", default="", dest="topic_en",
                        help="English version of topic for web searches")
    parser.add_argument("--out", default=None,
                        help="Output directory (default: video_dir/01_research/)")
    parser.add_argument("--output", default=None,
                        help="Exact versioned synthesis path")
    parser.add_argument("--deepen", action="store_true",
                        help="Additive pass to deepen existing research")
    parser.add_argument("--steer", default="",
                        help="Steering instruction for research deepening")
    parser.add_argument("--source-notes", default="",
                        help="Researcher-provided URLs, archive identifiers, and constraints to preserve in the corpus")
    parser.add_argument("--max-sources", type=int, default=18,
                        help="Maximum source URLs captured per research cycle (default: 18)")
    parser.add_argument("--rounds", type=int, default=3,
                        help="Evidence-development rounds after discovery (1–6; default: 3)")
    parser.add_argument("--factcheck-only", action="store_true",
                        help="Run only fact-checking pass on existing corpus")
    parser.add_argument("--no-synthesis", action="store_true",
                        help="Skip synthesis step (research aggregation only)")
    parser.add_argument("--no-followup", action="store_true",
                        help="Skip follow-up searches")
    args = parser.parse_args()

    # ── Resolve video dir and output dir
    if args.video_dir:
        video_dir = ROOT / args.video_dir if not Path(args.video_dir).is_absolute() else Path(args.video_dir)
        out_dir = Path(args.out) if args.out else video_dir / "01_research"
    else:
        video_dir = None
        out_dir = Path(args.out) if args.out else ROOT / "research_briefs"

    out_dir.mkdir(parents=True, exist_ok=True)
    corpus_root = out_dir if out_dir.name == "corpus" else (out_dir / "corpus")
    corpus_root.mkdir(parents=True, exist_ok=True)
    version_match = re.search(r"_v(\d+)\.md$", str(args.output or ""))
    version = version_match.group(1) if version_match else "1"
    cycle_dir = corpus_root / f"cycle_v{version}"
    cycle_dir.mkdir(parents=True, exist_ok=True)
    if args.source_notes.strip():
        (cycle_dir / "source_notes.md").write_text(args.source_notes.strip() + "\n", encoding="utf-8")

    known_urls = {
        canonical_url(url)
        for file in out_dir.rglob("*") if file.is_file() and file.suffix.lower() in {".md", ".txt", ".json", ".html"}
        for url in re.findall(r"https?://[^\s)>\]]+", file.read_text(encoding="utf-8", errors="ignore"))
    }
    channel = load_channel(video_dir)
    channel_name = str(channel.get("name", channel.get("id", "Independent channel")))
    language = str(channel.get("language", "hi"))

    # ── Fast path: factcheck only
    if args.factcheck_only:
        print("[STEP:4/5:START:Fact-Check Verification]", flush=True)
        target_docs = sorted(corpus_root.glob("research_corpus*.md"), reverse=True) or sorted(corpus_root.glob("synthesis_v*.md"), reverse=True)
        if not target_docs:
            print("[red]No synthesis corpus found for fact checking.[/red]", flush=True)
            sys.exit(1)
        target_text = "\n\n".join(doc.read_text(encoding="utf-8") for doc in target_docs)
        evidence_files = [f for f in out_dir.rglob("*.md") if f not in target_docs and not f.name.startswith("factcheck") and not f.name.startswith("material_discarded")]
        evidence_texts = captured_evidence(out_dir)
        # Notes and prior discovery runs provide investigative context but, being
        # unattributed strings, can never make a claim SUPPORTED.
        evidence_texts.extend(f.read_text(encoding="utf-8", errors="ignore") for f in evidence_files)
        source_urls = sorted({
            *[str(item.get("url")) for item in evidence_texts if isinstance(item, dict) and item.get("url")],
            *re.findall(r"https?://[^\s)>\]]+", "\n\n".join([item["text"] if isinstance(item, dict) else item for item in evidence_texts] + [target_text])),
        })
        claims, counts = check_claims(target_text, evidence_texts, source_urls)
        report_path = Path(args.output) if args.output else out_dir / "factcheck_report.md"
        report_lines = [
            "# Research Fact-Check & Verification Report\n\n",
            f"Generated: {datetime.now().isoformat()}\n\n",
            f"Claims checked: {len(claims)} · Supported: {counts['SUPPORTED']} · Partial: {counts['PARTIAL']} · Unverified: {counts['UNVERIFIED']}\n\n",
            f"Research URLs indexed: {len(source_urls)}\n\n",
        ]
        for item in claims:
            report_lines.extend([
                f"## {item['id']} — {item['status']}\n\n{item['claim']}\n\nMatch score: {item['matchScore']:.3f}\n\nEvidence candidate: {item['evidenceExcerpt'] or 'None found in the local corpus.'}\n\n"
            ])
        report_path.write_text("".join(report_lines), encoding="utf-8")
        (out_dir / "claim_ledger.json").write_text(json.dumps({"counts": counts, "sources": source_urls, "claims": claims}, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[STEP:4/5:DONE:Fact-Check Verification - {counts['SUPPORTED']} supported, {counts['PARTIAL']} partial, {counts['UNVERIFIED']} unverified]", flush=True)

        print("[STEP:5/5:START:Clean Corpus & Discard Ledger Finalization]", flush=True)
        discard_path = out_dir / "material_discarded.md"
        if not discard_path.exists():
            discard_lines = [
                "# Discarded Research Material & Rejected Claims\n\n",
                "This file documents dubious assertions, unverified myths, or editorial rejections.\n",
                "Items listed here are **strictly excluded** from script outline and narration generation.\n\n",
            ]
            unverified_claims = [c for c in claims if c["status"] == "UNVERIFIED"]
            if unverified_claims:
                discard_lines.append("## Flagged Claims Requiring Independent Verification\n\n")
                for uc in unverified_claims:
                    discard_lines.append(f"- **{uc['id']}**: {uc['claim']} *(No matching primary evidence in corpus)*\n")
            discard_path.write_text("".join(discard_lines), encoding="utf-8")
        print("[STEP:5/5:DONE:Clean Corpus & Discard Ledger Finalization]", flush=True)
        print("Fact check completed successfully.")
        return

    # ── Get topic and premise
    topic = args.topic
    topic_en = args.topic_en
    premise = ""
    if video_dir:
        premise = get_premise_from_brief(video_dir)
        if not topic:
            title, title_en = get_topic_from_video_md(video_dir)
            if title:
                topic = title
                if title_en:
                    topic_en = title_en

    if not topic:
        console.print("[red]Error:[/red] No topic provided. Use positional arg (video dir) or --topic.")
        sys.exit(1)

    search_topic = topic_en if topic_en and not has_devanagari(topic_en) else (
        topic if not has_devanagari(topic) else topic_en or topic
    )
    if has_devanagari(search_topic) and video_dir:
        folder_parts = video_dir.name.split("_", 1)
        if len(folder_parts) > 1:
            search_topic = folder_parts[1].replace("-", " ")

    console.print()
    if USE_RICH:
        console.print(Panel(
            f"[bold cyan]Chitra Yantra 5-Step Deep Research Engine[/bold cyan]\n\n"
            f"Topic:    [yellow]{topic}[/yellow]\n"
            f"Search:   [yellow]{search_topic}[/yellow]\n"
            f"Output:   [dim]{out_dir}[/dim]",
            expand=False
        ))
    else:
        print(f"Deep Research: {topic}")
    console.print()

    # ── Step 1: Multi-Source Harvesting
    print("[STEP:1/5:START:Multi-Source Data Harvesting]", flush=True)
    console.print("[bold]Step 1/5:[/bold] Running multi-source research aggregator (Wikipedia, Wikidata, Web)...")
    prior_syntheses = sorted(corpus_root.glob("synthesis_v*.md"), reverse=True) or sorted(corpus_root.glob("research_corpus*.md"), reverse=True)
    if known_urls and prior_syntheses and not args.deepen:
        brief_path = prior_syntheses[0]
        console.print(f"Reusing existing source base: {brief_path.name}")
    else:
        brief_path = run_research_aggregator(search_topic, out_dir, channel_name, language)

    initial_brief = ""
    if brief_path and brief_path.exists():
        initial_brief = brief_path.read_text(encoding="utf-8")
        dest = corpus_root / "initial_brief.md"
        dest.write_text(initial_brief, encoding="utf-8")
        console.print(f"[green]✓[/green] Harvested initial brief: {len(initial_brief):,} chars")
    else:
        initial_brief = f"# Research Brief: {topic}\n\n*Topic Premise:* {premise or topic}\n"

    console.print("[dim]Step 1/5:[/dim] Planning evidence gaps and source targets...")

    if args.no_synthesis:
        return

    # ── Step 2: Deep Research Synthesis & Gap Analysis setup
    api_key = os.getenv("ANTHROPIC_API_KEY")
    client = None
    model = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-6")
    system_prompt = research_system_prompt(channel)

    if HAS_ANTHROPIC and api_key:
        client = anthropic.Anthropic(api_key=api_key)

    # ── Step 3: Gap Analysis & Follow-up Searches
    analysis = {}
    followup_results = []
    if client:
        console.print("[bold]Step 3/5:[/bold] Claude analyzing knowledge gaps and scholarly debates...")
        analysis = claude_analyze_brief(client, search_topic, initial_brief, system_prompt, channel_name, model)
        analysis_path = corpus_root / "gap_analysis.json"
        analysis_path.write_text(json.dumps(analysis, ensure_ascii=False, indent=2), encoding="utf-8")

        if not args.no_followup:
            queries = analysis.get("follow_up_queries", [])[:max(1, min(args.rounds, 6)) * 4]
            if args.steer:
                queries.insert(0, f"{search_topic} {args.steer}")
            if queries:
                console.print(f"Running {len(queries)} targeted queries to fill gaps...")
                for query in queries:
                    results = search_targeted(query, num=4)
                    results = [item for item in results if canonical_url(str(item.get("url", ""))) not in known_urls]
                    followup_results.extend(results)
                    known_urls.update(canonical_url(str(item.get("url", ""))) for item in results)

                academic = search_academic(search_topic, num=6)
                academic = [item for item in academic if canonical_url(str(item.get("url", ""))) not in known_urls]
                followup_results.extend(academic)
                known_urls.update(canonical_url(str(item.get("url", ""))) for item in academic)

                followup_path = corpus_root / "followup_results.md"
                lines = [f"# Follow-up Research Results: {topic}\n\n"]
                for i, r in enumerate(followup_results, 1):
                    lines.append(f"## {i}. {r['title']}\n{r['snippet']}\n\nURL: {r['url']}\n\n---\n")
                followup_path.write_text("".join(lines), encoding="utf-8")
    else:
        console.print("[yellow]Claude API not available — performing automated gap coverage search...[/yellow]")
        if not args.no_followup:
            default_queries = [f"{search_topic} inscriptions history", f"{search_topic} archaeology evidence", f"{search_topic} primary sources"]
            if args.rounds >= 2:
                default_queries.extend([f"{search_topic} site:archive.org primary source", f"{search_topic} site:asi.nic.in report"])
            if args.rounds >= 3:
                default_queries.extend([f"{search_topic} scholarly debate journal", f"{search_topic} excavation report PDF"])
            if args.steer:
                default_queries.insert(0, f"{search_topic} {args.steer}")
            for query in default_queries:
                results = search_targeted(query, num=4)
                followup_results.extend(results)
                known_urls.update(canonical_url(str(item.get("url", ""))) for item in results)
            if followup_results:
                followup_path = corpus_root / "followup_results.md"
                lines = [f"# Follow-up Research Results: {topic}\n\n"]
                for i, r in enumerate(followup_results, 1):
                    lines.append(f"## {i}. {r['title']}\n{r['snippet']}\n\nURL: {r['url']}\n\n---\n")
                followup_path.write_text("".join(lines), encoding="utf-8")

    print("[STEP:1/5:DONE:Discovery & Gap Analysis]", flush=True)

    # ── Step 2: primary-source acquisition. Search results remain leads until
    # their bytes and extracted text are captured in the local corpus.
    print("[STEP:2/5:START:Primary Source Capture]", flush=True)
    source_candidates = re.findall(r"https?://[^\s)>\]]+", initial_brief + "\n" + args.source_notes)
    source_candidates.extend(str(item.get("url", "")) for item in followup_results)
    captured_sources = capture_sources(source_candidates, cycle_dir, max_sources=max(1, min(args.max_sources, 50)))
    catalog_path = corpus_root / "sources.json"
    try:
        prior_sources = json.loads(catalog_path.read_text(encoding="utf-8")).get("sources", [])
    except (OSError, ValueError, TypeError):
        prior_sources = []
    by_url = {str(source.get("url")): source for source in prior_sources if source.get("url")}
    by_url.update({str(source.get("url")): source for source in captured_sources if source.get("url")})
    write_catalog(catalog_path, list(by_url.values()), cycle=f"cycle_v{version}", source_notes=args.source_notes)
    (cycle_dir / "capture_report.json").write_text(json.dumps(captured_sources, ensure_ascii=False, indent=2), encoding="utf-8")
    # Reuse prior captured material as a durable corpus on later deepening
    # cycles. A later failed URL must not erase already captured evidence.
    source_evidence = captured_evidence(out_dir)
    source_passages = [
        f"[Source {source.get('id')}] {source.get('url')}\n{source.get('text', '')[:4000]}"
        for source in source_evidence
    ]
    print(f"[STEP:2/5:DONE:Primary Source Capture - {len(source_passages)} locally extracted source texts available]", flush=True)

    # ── Step 3: synthesis follows source acquisition, so the UI never claims
    # evidence has been grounded before it exists locally.
    print("[STEP:3/5:START:Evidence Synthesis]", flush=True)
    console.print("[bold]Step 3/5:[/bold] Synthesizing comprehensive research dossier...")
    if client:
        synthesis = claude_synthesize(client, topic, initial_brief, analysis, followup_results, "\n\n".join(source_passages), system_prompt, channel_name, model)
    else:
        synthesis = generate_fallback_synthesis(topic, premise, initial_brief, channel_name)

    if not synthesis:
        synthesis = generate_fallback_synthesis(topic, premise, initial_brief, channel_name)

    # Save synthesis to versioned targets
    synthesis_path = Path(args.output) if args.output else corpus_root / f"synthesis_v{version}.md"
    synthesis_path.parent.mkdir(parents=True, exist_ok=True)
    synthesis_path.write_text(synthesis, encoding="utf-8")

    # Also save standard research_corpus file
    corpus_file = corpus_root / f"research_corpus_{version}.md"
    corpus_file.write_text(synthesis, encoding="utf-8")

    # Captured files are evidence candidates; search results remain discovery
    # leads and must never be represented as evidence.
    source_lines = [f"# Source ledger — {topic}\n\n", "## Locally captured sources\n\n"]
    if captured_sources:
        for source in captured_sources:
            url = str(source.get("url", ""))
            status = str(source.get("status", "failed"))
            if status == "fetched":
                source_lines.append(
                    f"- **Captured** · {source.get('id')} · [{url}]({url})  \n"
                    f"  Extractor: {source.get('extractor', 'unknown')} · {source.get('bytes', 0):,} bytes · local text: {source.get('extractedPath')}\n"
                )
            else:
                source_lines.append(
                    f"- **Not evidence — {status}** · [{url}]({url})  \n"
                    f"  {source.get('error') or 'Stored without extractable text; inspect or replace this source.'}\n"
                )
    else:
        source_lines.append("_No URLs were captured in this cycle. The dossier must not be approved until a source is captured._\n")
    source_lines.append("\n## Discovery leads (not evidence)\n\n")
    seen_urls = set()
    for url in re.findall(r"https?://[^\s)>\]]+", initial_brief + "\n" + synthesis):
        clean_url = url.rstrip(".,;`")
        if clean_url in seen_urls:
            continue
        seen_urls.add(clean_url)
        source_lines.append(f"- [Discovery lead]({clean_url}) — requires local retrieval and claim-level review.\n")
    for item in followup_results:
        url = str(item.get("url", "")).strip()
        if not url or url in seen_urls:
            continue
        seen_urls.add(url)
        source_lines.append(f"- [{item.get('title', url)}]({url}) — targeted follow-up lead.\n")

    (corpus_root / "sources.md").write_text("".join(source_lines), encoding="utf-8")
    (corpus_root / "index.json").write_text(json.dumps({"urls": sorted(known_urls)}, indent=2), encoding="utf-8")

    console.print(f"[green]✓[/green] Research dossier saved: {corpus_file.name} ({len(synthesis):,} chars)")
    print("[STEP:3/5:DONE:Evidence Synthesis]", flush=True)

    # ── Step 4: Fact-Check Verification Run
    print("[STEP:4/5:START:Fact-Check Verification]", flush=True)
    console.print("[bold]Step 4/5:[/bold] Extracting claims and auditing against evidence corpus...")
    evidence_texts = source_evidence + [initial_brief] + [r.get("snippet", "") for r in followup_results]
    all_urls = sorted({
        *[str(item.get("url")) for item in source_evidence if item.get("url")],
        *re.findall(r"https?://[^\s)>\]]+", "\n\n".join(
            [item["text"] if isinstance(item, dict) else item for item in evidence_texts] + [synthesis]
        )),
    })
    claims, counts = check_claims(synthesis, evidence_texts, all_urls)

    report_path = out_dir / "factcheck_report.md"
    report_lines = [
        "# Research Fact-Check & Verification Report\n\n",
        f"Generated: {datetime.now().isoformat()}\n\n",
        f"Claims checked: {len(claims)} · Supported: {counts['SUPPORTED']} · Partial: {counts['PARTIAL']} · Unverified: {counts['UNVERIFIED']}\n\n",
        f"Research URLs indexed: {len(all_urls)}\n\n",
    ]
    for item in claims:
        source_ref = item.get("evidenceSourceUrl")
        source_line = f"Evidence source: [{item.get('evidenceSourceId')}]({source_ref})\n\n" if source_ref else "Evidence source: No captured source matched.\n\n"
        report_lines.extend([
            f"## {item['id']} — {item['status']}\n\n{item['claim']}\n\nMatch score: {item['matchScore']:.3f}\n\n",
            source_line,
            f"Evidence candidate: {item['evidenceExcerpt'] or 'None found in the local corpus.'}\n\n"
        ])
    report_path.write_text("".join(report_lines), encoding="utf-8")
    (out_dir / "claim_ledger.json").write_text(json.dumps({"counts": counts, "sources": all_urls, "claims": claims}, ensure_ascii=False, indent=2), encoding="utf-8")
    console.print(f"[green]✓[/green] Fact check completed: {counts['SUPPORTED']} supported, {counts['PARTIAL']} partial, {counts['UNVERIFIED']} unverified")
    print(f"[STEP:4/5:DONE:Fact-Check Verification - {counts['SUPPORTED']} supported, {counts['PARTIAL']} partial, {counts['UNVERIFIED']} unverified]", flush=True)

    # ── Step 5: Clean Corpus & Discard Ledger Finalization
    print("[STEP:5/5:START:Clean Corpus & Discard Ledger Finalization]", flush=True)
    console.print("[bold]Step 5/5:[/bold] Partitioning pure script corpus and recording discarded claims...")
    discard_path = out_dir / "material_discarded.md"
    discard_lines = [
        "# Discarded Research Material & Rejected Claims\n\n",
        "This file documents dubious assertions, unverified claims, or editorial rejections.\n",
        "Items listed here are **strictly excluded** from script outline and narration generation.\n\n",
    ]
    unverified_claims = [c for c in claims if c["status"] == "UNVERIFIED"]
    if unverified_claims:
        discard_lines.append("## Claims Excluded Due to Lack of Primary Confirmation\n\n")
        for uc in unverified_claims:
            discard_lines.append(f"- **{uc['id']}**: {uc['claim']} *(Excluded from script)*\n")
    else:
        discard_lines.append("No claims currently discarded. Use the Fact-Check dashboard to flag dubious assertions.\n")
    discard_path.write_text("".join(discard_lines), encoding="utf-8")

    print("[STEP:5/5:DONE:Clean Corpus & Discard Ledger Finalization]", flush=True)

    console.print()
    console.print(Rule() if USE_RICH else "─" * 60)
    console.print()
    console.print("[bold green]✓ 5-Step Deep Research Pipeline complete![/bold green]")
    console.print()
    console.print("[bold]Generated pure corpus & evidence:[/bold]")
    console.print(f"  {corpus_file}  ← [bold]pure dossier for script generator[/bold]")
    console.print(f"  {report_path}  ← [bold]fact-check audit[/bold]")
    console.print(f"  {discard_path}  ← [bold]discarded material (excluded from script)[/bold]")
    console.print()


if __name__ == "__main__":
    main()
