"""
PyMuPDF-based PDF markup for contract review.

Replaces the Node.js markup-pdf.js drawn-line approach with real PDF
annotations: /Subtype /StrikeOut for delete + replace, /Subtype /Text
sticky-notes for the comment text. PyMuPDF's search_for() handles
multi-line and multi-page text natively, returning per-line quads that
the annotation API consumes directly — no manual coordinate math.

Per markup_type:
  delete    — StrikeOut over source_text. Comment in /Contents popup.
  replace   — StrikeOut over source_text. Comment includes proposed
              replacement language.
  insert    — Sticky-note at the derived section anchor. No strike
              (nothing to strike). Comment includes proposed insertion.
  annotate  — Sticky-note over source_text. No strike. Comment is
              the reasoning verbatim.

Designed to run as either a standalone CLI (for local testing) or
as a hosted HTTP service the Node pipeline calls.

CLI usage:
  python markup.py <findings.json> <input.pdf> <output.pdf>
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pymupdf  # PyMuPDF — `pip install pymupdf`

DEFAULT_AUTHOR = "Legal Overflow"
STRIKE_COLOR = (0.85, 0.2, 0.2)  # red
COMMENT_ICON_COLOR = (1.0, 0.85, 0.2)  # yellow sticky


# ---------------------------------------------------------------------------
# Comment-body templates per markup_type
# ---------------------------------------------------------------------------

def build_comment_body(finding: dict, insert_label: str | None = None) -> str:
    """Customer-facing comment body. PDF has no inline-edit channel like
    Word's tracked changes, so the proposed-change language has to live
    in the comment text itself."""
    reasoning = (finding.get("external_comment") or "").strip()
    sug = (finding.get("suggested_text") or finding.get("proposed_text") or "").strip()
    mtype = finding.get("markup_type")

    if mtype == "delete":
        return _join("We propose striking this language.", reasoning)
    if mtype == "replace":
        if sug:
            return _join(f'We propose replacing the struck text with: "{sug}".', reasoning)
        return _join("We propose striking this language.", reasoning)
    if mtype == "insert":
        where = f" {insert_label}" if insert_label else ""
        if sug:
            return _join(f'We propose inserting the following{where}: "{sug}".', reasoning)
        return _join(f"We propose adding language{where}.", reasoning)
    return reasoning  # annotate or unknown — reasoning only


def _join(prefix: str, rest: str) -> str:
    return f"{prefix} {rest}".strip() if rest else prefix


# ---------------------------------------------------------------------------
# Source-text normalization (specialists sometimes wrap quoted excerpts)
# ---------------------------------------------------------------------------

_PREFIX_RE = re.compile(r"^Section\s+[\d.()a-z]+(?:\s+[^:]*?)?\s*:\s*", re.IGNORECASE)
_TRAIL_QUOTE_RE = re.compile(r"['\"‘’“”]+\s*$")
_LEAD_QUOTE_RE = re.compile(r"^['\"‘’“”]+")
_SEPARATORS = (
    " + Section", " + PROFILE", " AND Section", " AND PROFILE",
    " COMBINED WITH ", " BUT no ", " BUT the ", " BUT a ",
)


def strip_quoted_section_prefix(text: str) -> str | None:
    """Strip a leading 'Section X.Y[: "..."]' wrapper that specialists emit.
    Returns the inner quoted text if the pattern matches, else None.
    Mirrors the JS version in markup-docx.js."""
    if not text or not isinstance(text, str):
        return None
    m = _PREFIX_RE.match(text)
    if not m:
        return None
    inner = text[m.end():]
    inner = _LEAD_QUOTE_RE.sub("", inner)
    for sep in _SEPARATORS:
        idx = inner.find(sep)
        if idx > 0:
            inner = inner[:idx]
            break
    inner = _TRAIL_QUOTE_RE.sub("", inner).strip()
    if len(inner) > 200:
        inner = inner[:200]
    if len(inner) < 12:
        return None
    return inner


# ---------------------------------------------------------------------------
# Text search (multi-page + prefix-ladder fallback)
# ---------------------------------------------------------------------------

def find_text_quads(doc: pymupdf.Document, needle: str) -> list[tuple[int, list[pymupdf.Quad]]]:
    """Search for `needle` across the whole document.

    Returns: list of (page_index, [quads]) tuples. Multi-line and multi-
    page matches yield one entry per page that contains part of the match.

    Uses a prefix-ladder fallback when the full needle doesn't match
    (specialist source_text often differs from doc by one piece of
    punctuation, or wraps across page break)."""
    if not needle or len(needle.strip()) < 12:
        return []

    candidates = [needle, needle[:160], needle[:100], needle[:60]]
    for cand in candidates:
        if not cand or len(cand) < 12:
            continue
        results: list[tuple[int, list[pymupdf.Quad]]] = []
        for page_idx, page in enumerate(doc):
            quads = page.search_for(cand, quads=True)
            if quads:
                results.append((page_idx, quads))
        if results:
            return results
    return []


# ---------------------------------------------------------------------------
# Insert-anchor derivation (port of Round-4 DOCX helper)
# ---------------------------------------------------------------------------

_SECTION_REF_RE = re.compile(r"^\s*(?:Section\s+)?(\d+)\.(\d+)(?:\(([a-z])\))?", re.IGNORECASE)
_SECTION_REF_ANY_RE = re.compile(r"\bSection\s+(\d+)\.(\d+)(?:\(([a-z])\))?", re.IGNORECASE)


def derive_insert_anchor(doc: pymupdf.Document, suggested_text: str) -> tuple[int, pymupdf.Point, str] | None:
    """For insert findings, extract a section ref like 'X.Y' from the
    suggested text and return the page+coordinate of the preceding sibling
    subsection's location, plus a human-readable label.

    Returns (page_index, anchor_point, label) or None."""
    if not suggested_text:
        return None

    m = _SECTION_REF_RE.match(suggested_text)
    if not m:
        m = _SECTION_REF_ANY_RE.search(suggested_text[:200])
    if not m:
        return None

    major = int(m.group(1))
    minor = int(m.group(2))

    # Look for sibling X.W where W < minor (latest occurrence)
    for w in range(minor - 1, 0, -1):
        pat = re.compile(rf"^\s*{major}\.{w}\b")
        # Search each page for that section header
        for page_idx in range(len(doc) - 1, -1, -1):
            page = doc[page_idx]
            text_lines = page.get_text("text").split("\n")
            for line in text_lines:
                if pat.match(line):
                    # Return the page's right margin near the bottom of where this section ends
                    rect = page.rect
                    return (page_idx, pymupdf.Point(rect.width - 60, rect.height / 2),
                            f"after Section {major}.{w}")

    # Fallback: parent section header X.
    parent_pat = re.compile(rf"^\s*(?:Section\s+)?{major}\.\s+", re.IGNORECASE)
    for page_idx, page in enumerate(doc):
        text_lines = page.get_text("text").split("\n")
        for line in text_lines:
            if parent_pat.match(line):
                rect = page.rect
                return (page_idx, pymupdf.Point(rect.width - 60, rect.height / 4),
                        f"as new Section {major}.{minor}")

    return None


# ---------------------------------------------------------------------------
# Citation-style fallback — anchor on a section header line
# ---------------------------------------------------------------------------

def anchor_on_section_header(doc: pymupdf.Document, text: str) -> tuple[int, list[pymupdf.Quad]] | None:
    """Last-resort anchor for delete/replace/annotate findings whose
    source_text is a citation rather than quoted text. Returns the page
    and quads of the first referenced section's header line."""
    if not text:
        return None
    m = re.search(r"Section\s+(\d+)(?:\.(\d+))?(?:\(([a-z])\))?", text, re.IGNORECASE)
    if not m:
        return None
    major = int(m.group(1))
    minor = m.group(2)

    if minor:
        pat = re.compile(rf"^\s*{major}\.{minor}\b")
    else:
        pat = re.compile(rf"^\s*{major}\.(?!\d)")

    for page_idx, page in enumerate(doc):
        for line in page.get_text("text").split("\n"):
            if pat.match(line):
                # Search for the line on the page to get quads
                quads = page.search_for(line.strip()[:80], quads=True)
                if quads:
                    return (page_idx, quads[:1])  # just the header itself
    return None


# ---------------------------------------------------------------------------
# Main markup function
# ---------------------------------------------------------------------------

def apply_pdf_markup(pdf_bytes: bytes, findings: list[dict], author: str | None = None) -> dict:
    """Apply findings to a PDF buffer. Returns:
      { 'pdf': bytes, 'applied': int, 'unanchored': list[finding] }

    `author` is the name attributed on every annotation (defaults to
    "Legal Overflow"). Empty/whitespace falls back to the default."""
    AUTHOR = (author or "").strip() or DEFAULT_AUTHOR
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    applied: list[dict] = []
    unanchored: list[dict] = []

    for f in findings:
        markup_type = f.get("markup_type")

        # ---- insert ----
        if markup_type == "insert":
            anchor = (
                derive_insert_anchor(doc, f.get("suggested_text") or "")
                or derive_insert_anchor(doc, f.get("anchor_text") or "")
            )
            if not anchor:
                # Fallback: top-right of page 1
                page0 = doc[0]
                anchor = (0, pymupdf.Point(page0.rect.width - 60, 60), "")
            page_idx, point, label = anchor
            page = doc[page_idx]
            note = page.add_text_annot(point, build_comment_body(f, label))
            note.set_info(content=build_comment_body(f, label), title=AUTHOR)
            note.set_colors(stroke=COMMENT_ICON_COLOR)
            note.update()
            applied.append(f)
            continue

        # ---- delete / replace / annotate ----
        search_text = f.get("source_text") or f.get("anchor_text") or ""
        if len(search_text) < 8:
            unanchored.append(f)
            continue

        # Strip "Section X.Y: '...'" wrapper if present
        stripped = strip_quoted_section_prefix(search_text)
        if stripped:
            search_text = stripped

        results = find_text_quads(doc, search_text)
        used_citation_fallback = False

        if not results:
            # Citation-style fallback
            citation_anchor = anchor_on_section_header(doc, f.get("source_text") or f.get("anchor_text") or "")
            if citation_anchor:
                results = [citation_anchor]
                used_citation_fallback = True

        if not results:
            unanchored.append(f)
            continue

        comment_body = build_comment_body(f)

        # Add StrikeOut for delete/replace (unless citation fallback)
        if markup_type in ("delete", "replace") and not used_citation_fallback:
            # Multi-page handling: PyMuPDF lets us add one annot per page;
            # they aren't auto-IRT-linked, but Acrobat handles cross-page
            # annotations adequately. The comment body lives on the FIRST
            # page's annotation; subsequent pages get an empty Contents so
            # they don't duplicate.
            first_annot = None
            for page_idx, quads in results:
                page = doc[page_idx]
                annot = page.add_strikeout_annot(quads)
                annot.set_colors(stroke=STRIKE_COLOR)
                if first_annot is None:
                    annot.set_info(content=comment_body, title=AUTHOR)
                    first_annot = annot
                else:
                    annot.set_info(content="", title=AUTHOR)
                annot.update()
        else:
            # annotate (or citation fallback) — sticky-note over source_text
            page_idx, quads = results[0]
            page = doc[page_idx]
            # Place icon at the center-top of the first quad
            q = quads[0]
            icon_point = pymupdf.Point(
                (q.ul.x + q.ur.x) / 2,
                (q.ul.y + q.ll.y) / 2,
            )
            note = page.add_text_annot(icon_point, comment_body)
            note.set_info(content=comment_body, title=AUTHOR)
            note.set_colors(stroke=COMMENT_ICON_COLOR)
            note.update()

        applied.append(f)

    out_bytes = doc.tobytes(deflate=True, garbage=3)
    doc.close()

    return {
        "pdf": out_bytes,
        "applied": len(applied),
        "unanchored": unanchored,
    }


# ---------------------------------------------------------------------------
# CLI for local testing
# ---------------------------------------------------------------------------

def main() -> None:
    if len(sys.argv) != 4:
        print("Usage: python markup.py <findings.json> <input.pdf> <output.pdf>", file=sys.stderr)
        sys.exit(1)

    findings_path = Path(sys.argv[1])
    input_pdf_path = Path(sys.argv[2])
    output_pdf_path = Path(sys.argv[3])

    run = json.loads(findings_path.read_text(encoding="utf-8"))
    findings = run.get("accepted_findings") or run.get("findings") or run.get("priority_three") or []
    # Some test JSONs put findings under top-level "findings"
    if isinstance(findings, list) and findings and isinstance(findings[0], str):
        findings = run.get("all_findings") or []

    pdf_bytes = input_pdf_path.read_bytes()
    print(f"[markup.py] {len(findings)} findings, {len(pdf_bytes)} byte input PDF")

    # Optional 4th arg: author name
    author = sys.argv[4] if len(sys.argv) > 4 else None
    result = apply_pdf_markup(pdf_bytes, findings, author=author)
    output_pdf_path.write_bytes(result["pdf"])
    unanchored_path = output_pdf_path.with_suffix(output_pdf_path.suffix + ".unanchored.json")
    unanchored_path.write_text(json.dumps(result["unanchored"], indent=2), encoding="utf-8")

    print(f"[markup.py] applied: {result['applied']}, unanchored: {len(result['unanchored'])}")
    print(f"[markup.py] wrote {output_pdf_path} and {unanchored_path}")


if __name__ == "__main__":
    main()
