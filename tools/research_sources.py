"""Durable, local source capture for Chitrayantra research cycles.

Search results are discovery leads. This module turns selected leads into an
auditable local corpus with retrieval time, content hash, original URL and a
best-effort text extraction. It intentionally records failures instead of
silently treating a URL as evidence.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self._ignored = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "noscript", "svg", "nav"}:
            self._ignored += 1
        elif tag in {"p", "br", "li", "h1", "h2", "h3", "blockquote", "tr"}:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript", "svg", "nav"} and self._ignored:
            self._ignored -= 1

    def handle_data(self, data: str) -> None:
        if not self._ignored:
            self.parts.append(data)

    def text(self) -> str:
        return re.sub(r"\n{3,}", "\n\n", re.sub(r"[ \t]+", " ", "".join(self.parts))).strip()


def _extract_text(payload: bytes, content_type: str) -> tuple[str, str]:
    """Return extracted text and a transparent extractor label."""
    if "pdf" in content_type:
        try:
            from pypdf import PdfReader  # optional dependency
            import io
            return "\n\n".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(payload)).pages).strip(), "pypdf"
        except Exception:
            return "", "pdf-stored-not-extracted"
    decoded = payload.decode("utf-8", errors="replace")
    if "html" in content_type or "<html" in decoded[:1000].lower():
        parser = _TextExtractor()
        parser.feed(decoded)
        return parser.text(), "html-parser"
    return decoded.strip(), "text"


def capture_sources(urls: list[str], cycle_dir: Path, *, max_sources: int = 18, timeout: int = 20) -> list[dict]:
    """Fetch unique HTTP(S) URLs into ``cycle_dir`` and return source records."""
    raw_dir = cycle_dir / "raw"
    text_dir = cycle_dir / "extracted"
    raw_dir.mkdir(parents=True, exist_ok=True)
    text_dir.mkdir(parents=True, exist_ok=True)
    seen: set[str] = set()
    records: list[dict] = []
    for raw_url in urls:
        url = str(raw_url).strip().rstrip(".,;`")
        parsed = urlsplit(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc or url in seen:
            continue
        seen.add(url)
        if len(records) >= max_sources:
            break
        source_id = hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]
        record: dict = {"id": source_id, "url": url, "retrievedAt": datetime.now(timezone.utc).isoformat(), "status": "failed"}
        try:
            request = Request(url, headers={"User-Agent": "ChitraYantraResearch/4.0 (+local editorial corpus)"})
            with urlopen(request, timeout=timeout) as response:
                content_type = response.headers.get_content_type() or "application/octet-stream"
                payload = response.read(10 * 1024 * 1024 + 1)
                if len(payload) > 10 * 1024 * 1024:
                    raise ValueError("source exceeds 10 MB capture limit")
            extension = ".pdf" if "pdf" in content_type else ".html" if "html" in content_type else ".txt"
            raw_path = raw_dir / f"{source_id}{extension}"
            raw_path.write_bytes(payload)
            extracted, extractor = _extract_text(payload, content_type)
            extracted_path = text_dir / f"{source_id}.txt"
            if extracted:
                extracted_path.write_text(extracted, encoding="utf-8")
            record.update({
                "status": "fetched" if extracted else "stored_unparsed",
                "contentType": content_type,
                "bytes": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
                "rawPath": str(raw_path.relative_to(cycle_dir.parent.parent)),
                "extractedPath": str(extracted_path.relative_to(cycle_dir.parent.parent)) if extracted else None,
                "extractor": extractor,
                "excerpt": extracted[:800] if extracted else "",
            })
        except (HTTPError, URLError, TimeoutError, ValueError, OSError) as error:
            record["error"] = str(error)
        records.append(record)
    return records


def write_catalog(path: Path, sources: list[dict], *, cycle: str, source_notes: str = "") -> None:
    path.write_text(json.dumps({
        "schemaVersion": 1,
        "cycle": cycle,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sourceNotes": source_notes,
        "sources": sources,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
