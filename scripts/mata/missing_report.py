"""
Mata Tracker — coverage report.

Lists every case still in `pending_opinion`, grouped by why we couldn't get
its opinion automatically. Use this after Stage 3B + 3C finish to identify
what (if anything) you want to pursue manually via PACER, state e-filing,
or LexisNexis.

Usage:
    python scripts/mata/missing_report.py            # text report to stdout
    python scripts/mata/missing_report.py --csv      # CSV to stdout
    python scripts/mata/missing_report.py --md       # markdown table

Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
except Exception:
    pass

ENV_FILE = Path(__file__).resolve().parents[2] / ".env"
if ENV_FILE.exists():
    for line in ENV_FILE.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = (
    os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    or os.environ.get("SUPABASE_KEY")
)
if not (SUPABASE_URL and SUPABASE_KEY):
    sys.exit("missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY")

REST = f"{SUPABASE_URL}/rest/v1"
H = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
}


def sb_get(path):
    req = urllib.request.Request(f"{REST}{path}", headers=H)
    return json.loads(urllib.request.urlopen(req, timeout=30).read())


# ---- federal-court heuristic (mirrors fetch_recap.py) -------------------
_FEDERAL_PREFIX = re.compile(
    r"^(D\.|S\.D\.|N\.D\.|E\.D\.|W\.D\.|M\.D\.|C\.D\.|D\.D\.|U\.S\.|USDC)\s",
    re.IGNORECASE,
)
_FEDERAL_OTHER = re.compile(
    r"\b(Cir\.|Circuit|BAP|JPML|ASBCA|GAO|Tax Court|Bankr|Bankruptcy|"
    r"U\.S\.D\.C|J\.P\.M\.L)\b",
    re.IGNORECASE,
)
_STATE_HINTS = re.compile(
    r"\b(state|county|tex\.\s*app|ca\s+\w+|ac\s+\w+|sc\s+\w+|"
    r"sct|ct\.?\s*app|app\.\s*ct|cmwlth|commonwealth|"
    r"superior|family|probate|traffic)\b",
    re.IGNORECASE,
)


def classify(court: str) -> str:
    if not court:
        return "unknown"
    if _FEDERAL_PREFIX.match(court) or _FEDERAL_OTHER.search(court):
        return "federal"
    if _STATE_HINTS.search(court):
        return "state"
    return "unknown"


# ---- fetch all pending --------------------------------------------------
def all_pending() -> list[dict]:
    rows: list[dict] = []
    offset = 0
    while True:
        chunk = sb_get(
            "/cases?select=case_name,court,decision_date,party_type,ai_tool,slug"
            f"&status=eq.pending_opinion&limit=1000&offset={offset}"
        )
        rows.extend(chunk)
        if len(chunk) < 1000:
            break
        offset += 1000
    return rows


def total_counts() -> dict:
    def head(p):
        req = urllib.request.Request(
            f"{REST}{p}",
            headers={**H, "Range": "0-0", "Prefer": "count=exact"},
            method="HEAD",
        )
        r = urllib.request.urlopen(req, timeout=30)
        cr = r.headers.get("content-range") or r.headers.get("Content-Range") or ""
        return int(cr.rsplit("/", 1)[1]) if "/" in cr else 0
    return {
        "total": head("/cases?select=id"),
        "pending": head("/cases?select=id&status=eq.pending_opinion"),
        "fetched": head("/cases?select=id&status=eq.opinion_fetched"),
        "annotated": head("/cases?select=id&status=eq.annotated"),
        "published": head("/cases?select=id&status=eq.published"),
        "opinions": head("/opinions?select=id"),
        "annotations": head("/annotations?select=id"),
    }


# ---- output -------------------------------------------------------------
def main():
    p = argparse.ArgumentParser()
    p.add_argument("--csv", action="store_true")
    p.add_argument("--md", action="store_true")
    args = p.parse_args()

    counts = total_counts()
    rows = all_pending()
    by_class: dict[str, list[dict]] = {"federal": [], "state": [], "unknown": []}
    for r in rows:
        by_class[classify(r["court"])].append(r)

    if args.csv:
        w = csv.writer(sys.stdout)
        w.writerow(["bucket", "case_name", "court", "decision_date", "party_type", "ai_tool", "slug"])
        for bucket in ("federal", "state", "unknown"):
            for r in by_class[bucket]:
                w.writerow([bucket, r["case_name"], r["court"], r["decision_date"],
                            r.get("party_type") or "", r.get("ai_tool") or "", r["slug"]])
        return

    if args.md:
        print(f"# Mata Tracker — coverage report\n")
        print(f"- Total cases indexed: **{counts['total']}**")
        print(f"- Opinions stored: **{counts['opinions']}**  (fetched: {counts['fetched']}, annotated: {counts['annotated']}, published: {counts['published']})")
        print(f"- Annotations: **{counts['annotations']}**")
        print(f"- Still pending opinion: **{counts['pending']}**\n")
        for bucket, label, hint in [
            ("federal", "Federal cases not retrievable",
             "Try CL Pro `/recap-documents/`, PACER directly, or skip — federal cases not on RECAP/IA are uncommon."),
            ("state", "State court cases",
             "Not on RECAP/IA. Manual via state e-filing portals (NYSCEF, re:SearchTX, etc.) or skip."),
            ("unknown", "Court not classifiable",
             "Mostly state appellate (e.g. \"CA Texas\", \"CA California (1st)\"). Treat as state."),
        ]:
            items = by_class[bucket]
            print(f"## {label} ({len(items)})")
            print(f"_{hint}_\n")
            print("| Case | Court | Date | Party | AI Tool |")
            print("|---|---|---|---|---|")
            for r in items[:200]:
                print(f"| {r['case_name']} | {r['court']} | {r['decision_date']} | "
                      f"{r.get('party_type') or ''} | {r.get('ai_tool') or ''} |")
            if len(items) > 200:
                print(f"\n_…and {len(items) - 200} more (use --csv for full list)_")
            print()
        return

    # plain text
    print("=== Mata Tracker — coverage report ===\n")
    print(f"  total cases:      {counts['total']}")
    print(f"  opinions stored:  {counts['opinions']}")
    print(f"  annotations:      {counts['annotations']}")
    print(f"  status counts:")
    print(f"     pending_opinion: {counts['pending']}")
    print(f"     opinion_fetched: {counts['fetched']}")
    print(f"     annotated:       {counts['annotated']}")
    print(f"     published:       {counts['published']}")
    print()
    for bucket, items in by_class.items():
        print(f"--- {bucket} ({len(items)}) ---")
        for r in items[:25]:
            ai = f" · AI: {r.get('ai_tool')}" if r.get("ai_tool") else ""
            print(f"  · {r['case_name']}  ({r['court']}, {r['decision_date']}, "
                  f"{r.get('party_type') or 'Unknown'}){ai}")
        if len(items) > 25:
            print(f"  …and {len(items) - 25} more (use --md or --csv for full)")
        print()


if __name__ == "__main__":
    main()
