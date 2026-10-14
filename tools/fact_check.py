#!/usr/bin/env python3
"""Build a reproducible claim ledger from the draft and approved research corpus."""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path


URL_RE = re.compile(r"https?://[^\s)>\]]+")
CLAIM_RE = re.compile(r"(?<=[।.!?])\s+|\n+")
TOKEN_RE = re.compile(r"[\w\u0900-\u097f]{4,}", re.UNICODE)


def words(text: str) -> set[str]:
    return {token.casefold() for token in TOKEN_RE.findall(text)}


def captured_evidence(research_dir: Path) -> list[dict]:
    """Load only successfully extracted, locally captured sources as support."""
    catalog_path = research_dir / "corpus" / "sources.json"
    try:
        sources = json.loads(catalog_path.read_text(encoding="utf-8")).get("sources", [])
    except (OSError, ValueError, TypeError):
        return []
    evidence = []
    for source in sources:
        if source.get("status") != "fetched" or not source.get("extractedPath"):
            continue
        try:
            text = (research_dir / str(source["extractedPath"])).read_text(encoding="utf-8", errors="ignore")
            evidence.append({"id": source.get("id"), "url": source.get("url"), "text": text})
        except OSError:
            continue
    return evidence


def check_claims(target_text: str, evidence_texts: list[str | dict], source_urls: list[str]) -> tuple[list[dict], dict]:
    """Trace claims to local passages.

    Plain strings are deliberately treated as unattributed discovery material and
    can never produce a SUPPORTED verdict. Structured records must name a local
    source ID and URL, making the result reviewable rather than a word-overlap
    score presented as truth.
    """
    paragraphs = []
    for evidence in evidence_texts:
        if isinstance(evidence, dict):
            text = str(evidence.get("text", ""))
            source_id = str(evidence.get("id", "unattributed"))
            source_url = str(evidence.get("url", ""))
        else:
            text, source_id, source_url = str(evidence), "unattributed", ""
        paragraphs.extend({"text": part.strip(), "sourceId": source_id, "sourceUrl": source_url}
                          for part in re.split(r"\n{2,}", text) if part.strip())
    claims = []
    for sentence in CLAIM_RE.split(target_text):
        claim = sentence.strip(" #-*\t")
        if len(claim) < 35 or claim.startswith("["):
            continue
        claim_words = words(claim)
        if len(claim_words) < 4:
            continue
        best, best_score = None, 0.0
        for paragraph in paragraphs:
            paragraph_words = words(paragraph["text"])
            if not paragraph_words:
                continue
            score = len(claim_words & paragraph_words) / len(claim_words)
            if score > best_score:
                best, best_score = paragraph, score
        attributable = bool(best and best["sourceId"] != "unattributed" and best["sourceUrl"])
        status = "SUPPORTED" if attributable and best_score >= 0.55 else "PARTIAL" if best_score >= 0.3 else "UNVERIFIED"
        claims.append({
            "id": f"claim-{len(claims) + 1:03d}",
            "claim": claim[:800],
            "status": status,
            "matchScore": round(best_score, 3),
            "evidenceExcerpt": best["text"][:500] if best else "",
            "evidenceSourceId": best["sourceId"] if best else None,
            "evidenceSourceUrl": best["sourceUrl"] if best else None,
        })
    counts = {status: sum(item["status"] == status for item in claims) for status in ("SUPPORTED", "PARTIAL", "UNVERIFIED")}
    return claims, counts


def main() -> int:
    parser = argparse.ArgumentParser(description="Cross-check research or script claims against the local evidence.")
    parser.add_argument("video_dir", type=Path)
    parser.add_argument("--stage", choices=["research", "script", "auto"], default="auto", help="Stage to verify (default: auto)")
    parser.add_argument("--output", type=Path, help="Exact versioned report path")
    args = parser.parse_args()
    root = args.video_dir.resolve()

    stage = args.stage
    if stage == "auto":
        if args.output and "01_research" in str(args.output):
            stage = "research"
        elif (root / "02_script" / "draft.md").is_file() or list((root / "02_script").glob("script_v*.md")):
            stage = "script"
        else:
            stage = "research"

    if stage == "research":
        research_dir = root / "01_research"
        corpus_dir = research_dir / "corpus"
        target_docs = sorted(corpus_dir.glob("research_corpus*.md"), reverse=True) or sorted(corpus_dir.glob("synthesis_v*.md"), reverse=True) or sorted(corpus_dir.glob("*.md"))
        if not target_docs:
            print(f"No research corpus found in: {corpus_dir}", file=sys.stderr)
            return 2
        target_text = "\n\n".join(doc.read_text(encoding="utf-8") for doc in target_docs)

        # Evidence files: raw briefs, sources, followup queries
        evidence_files = [
            f for f in research_dir.rglob("*.md")
            if f not in target_docs and not f.name.startswith("factcheck") and not f.name.startswith("material_discarded")
        ] + [
            f for f in research_dir.rglob("*.json")
            if not f.name.startswith("claim_ledger")
        ]
        evidence_texts = captured_evidence(research_dir)
        # Discovery notes remain visible as context but are never sufficient for a
        # SUPPORTED verdict because check_claims treats plain strings as unattributed.
        evidence_texts.extend(f.read_text(encoding="utf-8", errors="ignore") for f in evidence_files)

        source_urls = sorted({
            *[str(item.get("url")) for item in evidence_texts if isinstance(item, dict) and item.get("url")],
            *URL_RE.findall("\n\n".join([item["text"] if isinstance(item, dict) else item for item in evidence_texts] + [target_text])),
        })
        claims, counts = check_claims(target_text, evidence_texts, source_urls)

        output = args.output.resolve() if args.output else research_dir / "factcheck_report.md"
        ledger_path = research_dir / "claim_ledger.json"
        banner_title = "# Research Fact-Check & Verification Report"
    else:
        scripts = sorted(
            [
                * (root / "02_script").glob("final_v*_*.md"),
                * (root / "02_script").glob("draft_v*_*.md"),
                * (root / "02_script").glob("script_v*_*.md"),
            ],
            reverse=True,
        )
        draft = scripts[0] if scripts else root / "02_script" / "draft.md"
        if not draft.is_file():
            print(f"Draft not found: {draft}", file=sys.stderr)
            return 2
        research_dirs = [
            root / "01_research" / "corpus",
            root / "01_research" / "dossiers",
            root / "01_research" / "passes",
        ]
        documents = [file for directory in research_dirs if directory.is_dir() for file in directory.rglob("*.md") if file.is_file()]
        if not documents:
            print(f"Research evidence is empty under: {root / '01_research'}", file=sys.stderr)
            return 2

        evidence_texts = captured_evidence(root / "01_research")
        evidence_texts.extend(file.read_text(encoding="utf-8") for file in documents)
        source_urls = sorted({
            *[str(item.get("url")) for item in evidence_texts if isinstance(item, dict) and item.get("url")],
            *URL_RE.findall("\n\n".join(item["text"] if isinstance(item, dict) else item for item in evidence_texts)),
        })
        claims, counts = check_claims(draft.read_text(encoding="utf-8"), evidence_texts, source_urls)

        output = args.output.resolve() if args.output else root / "02_script" / "factcheck_report.md"
        ledger_path = root / "02_script" / "claim_ledger.json"
        banner_title = "# Script Fact-Check Report"

    output.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        f"{banner_title}\n\n",
        f"Generated: {datetime.now(timezone.utc).isoformat()}\n\n",
        "> This is a corpus-traceability check, not an independent truth determination. A human must verify primary sources.\n\n",
        f"Claims checked: {len(claims)} · Supported: {counts['SUPPORTED']} · Partial: {counts['PARTIAL']} · Unverified: {counts['UNVERIFIED']}\n\n",
        f"Research URLs indexed: {len(source_urls)}\n\n",
    ]
    for item in claims:
        source_ref = item.get("evidenceSourceUrl")
        source_line = f"Evidence source: [{item.get('evidenceSourceId')}]({source_ref})\n\n" if source_ref else "Evidence source: No captured source matched.\n\n"
        lines.extend([
            f"## {item['id']} — {item['status']}\n\n",
            f"{item['claim']}\n\n",
            f"Match score: {item['matchScore']:.3f}\n\n",
            source_line,
            f"Evidence candidate: {item['evidenceExcerpt'] or 'None found in the local corpus.'}\n\n",
        ])
    output.write_text("".join(lines), encoding="utf-8")
    ledger_path.write_text(
        json.dumps({"counts": counts, "sources": source_urls, "claims": claims}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"Wrote {output} ({len(claims)} claims)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
