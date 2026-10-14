#!/usr/bin/env python3
"""Compile an approved Markdown production script into TTS-safe narration chunks.

This is deliberately a compiler, not an LLM prompt: production directives and
source metadata must never become speech merely because a script is long.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any


NARRATION_MARKER = re.compile(r"^\*\*NARRATION:\*\*\s*$", re.I)
HEADING = re.compile(r"^#{1,6}\s+")
DIRECTIVE = re.compile(r"^\[(?:GEN|ART|TEXT|MUSIC|MAP|PHOTO|SOURCE|CLAIM):", re.I)
STOP_HEADINGS = re.compile(r"^##\s+(?:bibliography|production handoff|hindi-adaptation handoff)\b", re.I)
SENTENCE_BOUNDARY = re.compile(r"(?<=[.!?।！？])\s+")
MARKDOWN_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
URL = re.compile(r"https?://\S+", re.I)
EMPHASIS = re.compile(r"(?<!\*)\*{1,3}([^*]+?)\*{1,3}(?!\*)")
LATIN_TEXT = re.compile(r"[A-Za-z]")


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def spoken_line(line: str) -> str:
    """Remove presentation-only Markdown without changing narration words."""
    line = MARKDOWN_LINK.sub(r"\1", line)
    line = EMPHASIS.sub(r"\1", line)
    return re.sub(r"[ \t]+", " ", line).strip()


def extract_narration(markdown: str) -> list[dict[str, Any]]:
    """Return paragraphs that occur only inside explicit NARRATION blocks."""
    paragraphs: list[dict[str, Any]] = []
    active = False
    lines: list[str] = []
    start_line = 0

    def flush(end_line: int) -> None:
        nonlocal lines, start_line
        text = " ".join(lines).strip()
        if text:
            paragraphs.append({"text": text, "sourceLines": [start_line, end_line]})
        lines = []
        start_line = 0

    for number, raw in enumerate(markdown.splitlines(), start=1):
        line = raw.strip()
        if NARRATION_MARKER.match(line):
            flush(number - 1)
            active = True
            continue
        if STOP_HEADINGS.match(line):
            flush(number - 1)
            active = False
            break
        if HEADING.match(line):
            flush(number - 1)
            active = False
            continue
        if DIRECTIVE.match(line):
            # Editorial cues may be interleaved with an otherwise continuous
            # narration block.  They create a speech boundary, not spoken text.
            flush(number - 1)
            continue
        if not active:
            continue
        if not line:
            flush(number - 1)
            continue
        cleaned = spoken_line(line)
        if cleaned:
            if not lines:
                start_line = number
            lines.append(cleaned)
    flush(len(markdown.splitlines()))
    if not paragraphs:
        raise ValueError("No **NARRATION:** blocks were found in the source script")
    return paragraphs


def validate_hindi_narration(paragraphs: list[dict[str, Any]]) -> None:
    """Reject mixed-script narration; compilation must not alter author text."""
    for paragraph in paragraphs:
        text = str(paragraph["text"])
        if LATIN_TEXT.search(text):
            raise ValueError(
                f"Hindi narration contains Latin-script text at source lines "
                f"{paragraph['sourceLines'][0]}-{paragraph['sourceLines'][1]}. "
                "Edit the approved script before compiling; chunking never rewrites narration."
            )


def split_long_paragraph(paragraph: dict[str, Any], max_chars: int) -> list[dict[str, Any]]:
    text = str(paragraph["text"])
    if len(text) <= max_chars:
        return [paragraph]
    sentences = [item.strip() for item in SENTENCE_BOUNDARY.split(text) if item.strip()]
    if not sentences:
        raise ValueError("A narration paragraph has no usable sentence boundary")
    result: list[dict[str, Any]] = []
    current = ""
    for sentence in sentences:
        if len(sentence) > max_chars:
            raise ValueError(f"Sentence exceeds max_chars ({len(sentence)} > {max_chars}): {sentence[:80]!r}")
        candidate = f"{current} {sentence}".strip()
        if current and len(candidate) > max_chars:
            result.append({**paragraph, "text": current, "boundary": "sentence"})
            current = sentence
        else:
            current = candidate
    if current:
        result.append({**paragraph, "text": current, "boundary": "paragraph"})
    return result


def compile_manifest(source: Path, language: str, max_chars: int) -> dict[str, Any]:
    raw = source.read_text(encoding="utf-8")
    paragraphs = extract_narration(raw)
    if language.lower().split("-", 1)[0] == "hi":
        validate_hindi_narration(paragraphs)
    units = [piece for paragraph in paragraphs for piece in split_long_paragraph(paragraph, max_chars)]
    chunks: list[dict[str, Any]] = []
    current: list[dict[str, Any]] = []
    current_text = ""
    for unit in units:
        candidate = f"{current_text} <|prosody:pause|> {unit['text']}" if current else unit["text"]
        if current and (len(candidate) > max_chars or len(candidate.split()) > 70):
            chunks.append(make_chunk(len(chunks) + 1, current, current_text))
            current, current_text = [unit], unit["text"]
        else:
            current.append(unit)
            current_text = candidate
    if current:
        chunks.append(make_chunk(len(chunks) + 1, current, current_text))
    validate_chunks(chunks, max_chars)
    narration = "\n\n".join(item["text"] for item in paragraphs)
    return {
        "schema_version": 1,
        "kind": "tts_narration_manifest",
        "source": {"path": str(source.resolve()), "sha256": digest(raw), "language": language},
        "narration_sha256": digest(narration),
        "max_chars": max_chars,
        "chunks": chunks,
        "validation": {"passed": True, "rules": ["narration_blocks_only", "no_directives_or_sources", "sentence_aware_boundaries", "stable_order"]},
    }


def make_chunk(index: int, units: list[dict[str, Any]], text: str) -> dict[str, Any]:
    return {"id": f"n{index:04d}", "index": index, "text": text, "characters": len(text), "words": len(text.replace("<|prosody:pause|>", "").split()), "sourceLines": [units[0]["sourceLines"][0], units[-1]["sourceLines"][1]], "boundary": units[-1].get("boundary", "paragraph")}


def validate_chunks(chunks: list[dict[str, Any]], max_chars: int) -> None:
    forbidden = ("[source:", "[gen:", "[art:", "[text:", "[music:", "[map:", "[photo:", "http://", "https://", "**", "##")
    for expected, chunk in enumerate(chunks, start=1):
        text = str(chunk["text"])
        lowered = text.lower()
        if chunk.get("index") != expected or not text:
            raise ValueError("Chunks must be non-empty and sequential")
        if len(text) > max_chars:
            raise ValueError(f"Chunk {expected} exceeds max_chars")
        if any(token in lowered for token in forbidden) or URL.search(text):
            raise ValueError(f"Chunk {expected} contains non-narration production text")


def main() -> int:
    parser = argparse.ArgumentParser(description="Compile Markdown narration into a TTS-safe JSON manifest")
    parser.add_argument("source", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--language", default="und")
    parser.add_argument("--max-chars", type=int, default=320)
    args = parser.parse_args()
    if args.max_chars < 120:
        raise SystemExit("--max-chars must be at least 120")
    manifest = compile_manifest(args.source.expanduser().resolve(), args.language, args.max_chars)
    output = args.output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.tmp")
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(output)
    print(json.dumps({"output": str(output), "chunks": len(manifest["chunks"]), "validation": manifest["validation"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
