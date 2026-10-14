"""
Chitra Yantra Research Aggregator
=================================
Input:  a topic string (e.g. "Example topic")
Output: a structured research brief saved as a Markdown file,
        ready to paste directly into Claude for script generation.

Sources pulled:
  1. Wikipedia (English + Hindi)
  2. Wikimedia Commons  — available visual assets
  3. Wikidata           — structured facts / timeline
  4. DuckDuckGo search  — top web results (no API key needed)

Usage:
  python research_aggregator.py "Example topic"
  python research_aggregator.py "Example topic" --lang hi
  python research_aggregator.py "Example topic" --open        # open brief in editor after
"""

import argparse
import json
import re
import subprocess
import sys
import textwrap
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

import requests
import wikipediaapi
from bs4 import BeautifulSoup
from ddgs import DDGS
from rich.console import Console
from rich.panel import Panel
from rich.progress import Progress, SpinnerColumn, TextColumn
from rich.rule import Rule

console = Console()

# ─── CONFIG ──────────────────────────────────────────────────────────────────

OUTPUT_DIR = Path("research_briefs")
OUTPUT_DIR.mkdir(exist_ok=True)

HEADERS = {"User-Agent": "ChitraYantra/2.0 (local editorial research tool)"}

# Add source collections for a particular domain in local configuration rather
# than embedding an editorial research corpus in the shared tool.
GRETIL_HINTS: dict[str, str] = {}


# ─── WIKIPEDIA ───────────────────────────────────────────────────────────────

def fetch_wikipedia(topic: str, lang: str = "en") -> dict:
    """Fetch Wikipedia article summary, sections, and categories."""
    wiki = wikipediaapi.Wikipedia(
        language=lang,
        user_agent=HEADERS["User-Agent"]
    )
    page = wiki.page(topic)

    if not page.exists():
        # Try a search fallback via Wikipedia API
        search_url = (
            f"https://{lang}.wikipedia.org/w/api.php"
            f"?action=opensearch&search={quote(topic)}&limit=3&format=json"
        )
        resp = requests.get(search_url, headers=HEADERS, timeout=10)
        resp.raise_for_status()
        results = resp.json()
        if results[1]:
            page = wiki.page(results[1][0])

    if not page.exists():
        return {"found": False}

    # Flatten top-level sections (skip References, Notes, etc.)
    skip = {"references", "notes", "bibliography", "see also", "further reading",
            "external links", "footnotes", "sources"}
    sections = {}
    for s in page.sections:
        if s.title.lower() not in skip and s.text.strip():
            sections[s.title] = s.text[:1500]  # cap per section

    return {
        "found": True,
        "title": page.title,
        "summary": page.summary[:2000],
        "url": page.fullurl,
        "sections": sections,
        "categories": [c for c in list(page.categories.keys())[:20]
                       if "articles" not in c.lower()],
    }


def fetch_wikipedia_infobox(topic: str) -> dict:
    """Scrape infobox key-value pairs from English Wikipedia."""
    url = f"https://en.wikipedia.org/wiki/{quote(topic.replace(' ', '_'))}"
    try:
        resp = requests.get(url, headers=HEADERS, timeout=10)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")
        infobox = soup.find("table", {"class": re.compile(r"infobox")})
        if not infobox:
            return {}
        data = {}
        for row in infobox.find_all("tr"):
            th = row.find("th")
            td = row.find("td")
            if th and td:
                key = th.get_text(separator=" ", strip=True)
                val = td.get_text(separator=" ", strip=True)[:200]
                if key and val:
                    data[key] = val
        return data
    except Exception:
        return {}


# ─── WIKIMEDIA COMMONS ───────────────────────────────────────────────────────

def fetch_wikimedia_assets(topic: str, limit: int = 12) -> list[dict]:
    """Search Wikimedia Commons for images/maps related to the topic."""
    url = "https://commons.wikimedia.org/w/api.php"
    params = {
        "action": "query",
        "list": "search",
        "srsearch": topic,
        "srnamespace": "6",  # File namespace
        "srlimit": limit,
        "srprop": "snippet|titlesnippet",
        "format": "json",
    }
    try:
        resp = requests.get(url, params=params, headers=HEADERS, timeout=10)
        resp.raise_for_status()
        results = resp.json().get("query", {}).get("search", [])
        assets = []
        for r in results:
            title = r["title"]  # e.g. "File:Example Topic_ruins.jpg"
            file_name = title.replace("File:", "")
            commons_url = f"https://commons.wikimedia.org/wiki/{quote(title.replace(' ', '_'))}"
            assets.append({
                "title": file_name,
                "commons_url": commons_url,
                "snippet": BeautifulSoup(r.get("snippet", ""), "html.parser").get_text()[:100],
            })
        return assets
    except Exception:
        return []


# ─── WIKIDATA ─────────────────────────────────────────────────────────────────

def fetch_wikidata_facts(topic: str) -> dict:
    """Get structured facts from Wikidata via the search + entity API."""
    # Step 1: search for entity ID
    search_url = "https://www.wikidata.org/w/api.php"
    search_params = {
        "action": "wbsearchentities",
        "search": topic,
        "language": "en",
        "limit": 1,
        "format": "json",
    }
    try:
        resp = requests.get(search_url, params=search_params, headers=HEADERS, timeout=10)
        resp.raise_for_status()
        results = resp.json().get("search", [])
        if not results:
            return {}
        entity_id = results[0]["id"]
        entity_label = results[0].get("label", "")
        entity_desc = results[0].get("description", "")

        # Step 2: fetch key claims
        entity_url = f"https://www.wikidata.org/wiki/Special:EntityData/{entity_id}.json"
        resp2 = requests.get(entity_url, headers=HEADERS, timeout=10)
        resp2.raise_for_status()
        entity_data = resp2.json().get("entities", {}).get(entity_id, {})
        claims = entity_data.get("claims", {})

        # Map property IDs to human-readable labels we care about
        props_of_interest = {
            "P569": "Date of birth",
            "P570": "Date of death",
            "P571": "Inception / Founded",
            "P576": "Dissolved",
            "P17":  "Country",
            "P131": "Located in",
            "P856": "Official website",
            "P18":  "Image",
            "P910": "Main category (Commons)",
            "P580": "Start time",
            "P582": "End time",
            "P361": "Part of",
            "P1566": "GeoNames ID",
        }

        facts = {
            "entity_id": entity_id,
            "label": entity_label,
            "description": entity_desc,
            "wikidata_url": f"https://www.wikidata.org/wiki/{entity_id}",
        }

        for prop_id, prop_label in props_of_interest.items():
            if prop_id in claims:
                claim = claims[prop_id][0]
                snak = claim.get("mainsnak", {})
                dv = snak.get("datavalue", {})
                val = dv.get("value")
                if isinstance(val, dict):
                    # Date or entity reference
                    if "time" in val:
                        facts[prop_label] = val["time"][:11].lstrip("+")
                    elif "id" in val:
                        facts[prop_label] = val["id"]  # entity ID, resolve later if needed
                elif isinstance(val, str):
                    facts[prop_label] = val

        return facts
    except Exception:
        return {}


# ─── DUCKDUCKGO WEB SEARCH ───────────────────────────────────────────────────

def fetch_duckduckgo(topic: str, num_results: int = 8) -> list[dict]:
    """Search DuckDuckGo using the duckduckgo-search library — no API key needed."""
    query = topic
    try:
        with DDGS() as ddgs:
            raw = list(ddgs.text(query, max_results=num_results))
        results = []
        for r in raw:
            results.append({
                "title": r.get("title", ""),
                "snippet": r.get("body", "")[:250],
                "url": r.get("href", ""),
            })
        return results
    except Exception:
        return []


# ─── GRETIL HINT ─────────────────────────────────────────────────────────────

def find_gretil_hints(topic: str) -> list[str]:
    """Return GRETIL URLs that are relevant to the topic keywords."""
    topic_lower = topic.lower()
    hints = []
    for keyword, url in GRETIL_HINTS.items():
        if keyword in topic_lower:
            hints.append(url)
    return hints


# ─── BRIEF ASSEMBLER ─────────────────────────────────────────────────────────

def assemble_brief(
    topic: str,
    wiki_en: dict,
    wiki_hi: dict,
    infobox: dict,
    wikidata: dict,
    assets: list[dict],
    web_results: list[dict],
    gretil_hints: list[str],
    channel_name: str,
    secondary_language: str,
) -> str:
    """Assemble all sources into a structured Markdown research brief."""
    lines = []
    now = datetime.now().strftime("%Y-%m-%d %H:%M")

    lines += [
        f"# Research Brief: {topic}",
        f"*Generated: {now} | Chitra Yantra research snapshot for {channel_name}*",
        "",
        "---",
        "",
        "## Research handling note",
        "",
        "This is a discovery snapshot, not verified evidence. Check authorship, publication date, primary-source context, and claim coverage before script approval.",
        "",
        "---",
        "",
    ]

    # 1. QUICK FACTS
    lines += ["## 1. Quick Facts (Wikidata)", ""]
    if wikidata:
        for k, v in wikidata.items():
            if k not in ("entity_id", "wikidata_url"):
                lines.append(f"- **{k}:** {v}")
        lines.append(f"- **Wikidata:** {wikidata.get('wikidata_url', 'N/A')}")
    elif infobox:
        for k, v in list(infobox.items())[:10]:
            lines.append(f"- **{k}:** {v}")
    else:
        lines.append("- No structured facts found.")
    lines.append("")

    # 2. INFOBOX
    if infobox:
        lines += ["## 2. Wikipedia Infobox", ""]
        for k, v in list(infobox.items())[:15]:
            lines.append(f"- **{k}:** {v}")
        lines.append("")

    # 3. WIKIPEDIA SUMMARY (English)
    lines += ["## 3. Wikipedia Summary (English)", ""]
    if wiki_en.get("found"):
        lines.append(wiki_en["summary"])
        lines.append(f"\n*Source: {wiki_en['url']}*")
    else:
        lines.append("Not found on English Wikipedia.")
    lines.append("")

    # 4. KEY SECTIONS
    if wiki_en.get("found") and wiki_en.get("sections"):
        lines += ["## 4. Key Wikipedia Sections", ""]
        for title, text in list(wiki_en["sections"].items())[:8]:
            lines.append(f"### {title}")
            lines.append(textwrap.fill(text[:800], width=100))
            lines.append("")

    # 5. SECONDARY-LANGUAGE WIKIPEDIA
    lines += [f"## 5. Wikipedia ({secondary_language})", ""]
    if wiki_hi.get("found"):
        lines.append(wiki_hi["summary"][:1500])
        lines.append(f"\n*Source: {wiki_hi['url']}*")
    else:
        lines.append(f"Wikipedia article in {secondary_language} not found or limited.")
    lines.append("")

    # 6. VISUAL ASSETS
    lines += ["## 6. Visual Assets (Wikimedia Commons)", ""]
    if assets:
        lines.append("*These files are available on Wikimedia Commons — free to use with attribution.*")
        lines.append("")
        for a in assets:
            lines.append(f"- [{a['title']}]({a['commons_url']})")
            if a["snippet"]:
                lines.append(f"  *{a['snippet']}*")
    else:
        lines.append("No assets found. Search manually at https://commons.wikimedia.org")
    lines.append("")

    # 7. WEB RESEARCH
    lines += ["## 7. Web Research (Top Results)", ""]
    if web_results:
        for r in web_results:
            lines.append(f"**{r['title']}**")
            lines.append(f"> {r['snippet']}")
            if r["url"]:
                lines.append(f"> URL: {r['url']}")
            lines.append("")
    else:
        lines.append("No web results retrieved.")
    lines.append("")

    # 8. GRETIL / PRIMARY TEXTS
    lines += ["## 8. Primary Text Pointers (GRETIL)", ""]
    if gretil_hints:
        for h in gretil_hints:
            lines.append(f"- {h}")
    else:
        lines.append("- No direct GRETIL matches. Browse: https://gretil.sub.uni-goettingen.de")
    lines.append("")

    # 9. SUGGESTED RESEARCH ANGLES
    lines += [
        "## 9. Suggested Research Angles for Script",
        "",
        "*(Fill these in manually or ask Claude to expand based on above)*",
        "",
        "- [ ] What is the mainstream narrative about this topic?",
        "- [ ] What do primary sources actually say vs. what is popularly believed?",
        "- [ ] What is the most surprising or counterintuitive fact?",
        "- [ ] What is the modern relevance / why should viewers care today?",
        "- [ ] What visual moments will make this cinematic? (battles, courts, landscapes)",
        "- [ ] What is the controversy or debate among historians?",
        "",
    ]

    # 10. BIBLIOGRAPHY SEED
    lines += ["## 10. Bibliography Seed", ""]
    if wiki_en.get("found"):
        lines.append(f"- Wikipedia contributors. \"{wiki_en['title']}.\" *Wikipedia, The Free Encyclopedia.* {wiki_en['url']}")
    if wikidata.get("wikidata_url"):
        lines.append(f"- Wikidata contributors. \"{topic}.\" *Wikidata.* {wikidata['wikidata_url']}")
    lines += [
        "- *(Add academic sources here after deeper research)*",
        "- *(Cross-reference with JSTOR, Google Scholar, and ASI reports)*",
        "",
        "---",
        "",
        f"*Brief generated by Chitra Yantra Research Aggregator v2.0 — {now}*",
    ]

    return "\n".join(lines)


# ─── MAIN ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Generate a structured, source-linked discovery brief for a video."
    )
    parser.add_argument("topic", help='Topic to research (e.g. "Example Topic University")')
    parser.add_argument("--lang", default="hi", help="Secondary Wikipedia language (default: hi)")
    parser.add_argument("--channel", default="Independent production", help="Channel name used in the brief header")
    parser.add_argument("--out", type=Path, help="Exact output Markdown path")
    parser.add_argument("--open", action="store_true", help="Open the output file after generation")
    args = parser.parse_args()

    topic = args.topic.strip()
    console.print(Panel(f"[bold cyan]Chitra Yantra Research Aggregator[/bold cyan]\nTopic: [yellow]{topic}[/yellow]", expand=False))

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        console=console,
    ) as progress:

        t1 = progress.add_task("Wikipedia (English)...", total=None)
        wiki_en = fetch_wikipedia(topic, lang="en")
        progress.update(t1, description=f"[green]Wikipedia (English): {'✓' if wiki_en['found'] else '✗ not found'}[/green]", completed=True)

        t2 = progress.add_task(f"Wikipedia ({args.lang})...", total=None)
        wiki_hi = fetch_wikipedia(topic, lang=args.lang)
        progress.update(t2, description=f"[green]Wikipedia ({args.lang}): {'✓' if wiki_hi['found'] else '✗ not found'}[/green]", completed=True)

        t3 = progress.add_task("Infobox scrape...", total=None)
        infobox = fetch_wikipedia_infobox(topic)
        progress.update(t3, description=f"[green]Infobox: {len(infobox)} fields[/green]", completed=True)

        t4 = progress.add_task("Wikidata facts...", total=None)
        wikidata = fetch_wikidata_facts(topic)
        progress.update(t4, description=f"[green]Wikidata: {len(wikidata)} facts[/green]", completed=True)

        t5 = progress.add_task("Wikimedia Commons assets...", total=None)
        assets = fetch_wikimedia_assets(topic)
        progress.update(t5, description=f"[green]Commons assets: {len(assets)} found[/green]", completed=True)

        t6 = progress.add_task("DuckDuckGo web search...", total=None)
        web_results = fetch_duckduckgo(topic)
        progress.update(t6, description=f"[green]Web results: {len(web_results)} found[/green]", completed=True)

        t7 = progress.add_task("GRETIL primary text hints...", total=None)
        gretil_hints = find_gretil_hints(topic)
        progress.update(t7, description=f"[green]GRETIL hints: {len(gretil_hints)}[/green]", completed=True)

    # Assemble brief
    brief = assemble_brief(topic, wiki_en, wiki_hi, infobox, wikidata, assets, web_results, gretil_hints, args.channel, args.lang)

    # Save to file
    safe_name = re.sub(r"[^\w\s-]", "", topic).strip().replace(" ", "_").lower()
    timestamp = datetime.now().strftime("%Y%m%d_%H%M")
    output_path = args.out or OUTPUT_DIR / f"{safe_name}_{timestamp}.md"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(brief, encoding="utf-8")

    console.print(Rule())
    console.print(f"[bold green]✓ Brief saved:[/bold green] {output_path}")
    console.print(f"[dim]  Sections: Wikipedia EN/HI, Infobox, Wikidata, {len(assets)} Commons assets, {len(web_results)} web results, GRETIL hints[/dim]")
    console.print("[dim]  Verify source quality and claim coverage before synthesis.[/dim]")

    if args.open:
        command = ["open", str(output_path)] if sys.platform == "darwin" else ["xdg-open", str(output_path)]
        subprocess.run(command, check=False)


if __name__ == "__main__":
    main()
