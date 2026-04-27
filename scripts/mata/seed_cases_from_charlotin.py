"""
Mata Tracker — Stage 2: seed cases table from the Charlotin index.

CSV is used ONLY as a research index to identify which cases exist. We import
case identification fields (name, court, state, date, party type, AI tool)
and nothing else. All annotation content is generated separately from
primary-source opinions in later stages.

Usage:
    python scripts/mata/seed_cases_from_charlotin.py [path/to/file.csv]

Env (loaded from site/.env):
    SUPABASE_URL
    SUPABASE_SERVICE_ROLE_KEY
"""
from __future__ import annotations

import csv
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

# ---- env ----------------------------------------------------------------
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
if not SUPABASE_URL or not SUPABASE_KEY:
    sys.exit("missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env / .env")

REST = f"{SUPABASE_URL}/rest/v1"
COMMON_HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
}

# ---- thin PostgREST client (stdlib only) --------------------------------
def http(
    method: str,
    path: str,
    *,
    body: object | None = None,
    headers: dict | None = None,
) -> tuple[int, dict, bytes]:
    url = f"{REST}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    h = dict(COMMON_HEADERS)
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = resp.read()
            return resp.status, dict(resp.headers), payload
    except urllib.error.HTTPError as e:
        payload = e.read()
        raise RuntimeError(
            f"{method} {url} -> {e.code}: {payload.decode('utf-8', 'replace')}"
        ) from None


def select_pages(table: str, select: str, page_size: int = 1000):
    offset = 0
    while True:
        path = (
            f"/{table}?select={urllib.parse.quote(select)}"
            f"&limit={page_size}&offset={offset}"
        )
        status, _, payload = http("GET", path)
        rows = json.loads(payload) if payload else []
        for r in rows:
            yield r
        if len(rows) < page_size:
            return
        offset += page_size


def count_rows(table: str, where: str | None = None) -> int:
    path = f"/{table}?select=id"
    if where:
        path += f"&{where}"
    status, headers, _ = http(
        "HEAD",
        path,
        headers={"Prefer": "count=exact", "Range-Unit": "items", "Range": "0-0"},
    )
    cr = headers.get("content-range") or headers.get("Content-Range") or ""
    # Format: "0-0/N" or "*/N"
    if "/" in cr:
        return int(cr.rsplit("/", 1)[1])
    return 0


def upsert(table: str, rows: list[dict], on_conflict: str) -> None:
    if not rows:
        return
    path = f"/{table}?on_conflict={on_conflict}"
    http(
        "POST",
        path,
        body=rows,
        headers={
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
    )


# ---- input --------------------------------------------------------------
CSV_PATH = Path(
    sys.argv[1] if len(sys.argv) > 1
    else r"C:\Users\blake.beyel\Downloads\Charlotin-hallucination_cases.csv"
)
if not CSV_PATH.exists():
    sys.exit(f"CSV not found: {CSV_PATH}")


# ---- helpers ------------------------------------------------------------
PLACEHOLDER_AI = {"", "implied", "unidentified", "unknown", "none", "n/a"}


def clean_str(v: str | None) -> str:
    return (v or "").strip()


def normalize_party_type(raw: str) -> str:
    return clean_str(raw) or "Unknown"


def normalize_ai_tool(raw: str) -> str | None:
    raw = clean_str(raw)
    if not raw or raw.lower() in PLACEHOLDER_AI:
        return None
    return raw


def parse_date(raw: str) -> str | None:
    raw = clean_str(raw)
    if not raw:
        return None
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%Y/%m/%d", "%d %B %Y", "%B %d, %Y"):
        try:
            return datetime.strptime(raw, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def is_us_row(state_field: str) -> bool:
    s = clean_str(state_field).upper()
    return "USA" in s or "UNITED STATES" in s


_SLUG_RE = __import__("re").compile(r"[^a-z0-9]+")


def slugify_simple(value: str, max_length: int = 60) -> str:
    s = value.lower()
    s = _SLUG_RE.sub("-", s).strip("-")
    if len(s) > max_length:
        # cut on word boundary if possible
        cut = s[:max_length]
        if "-" in cut:
            cut = cut.rsplit("-", 1)[0]
        s = cut.strip("-")
    return s or "case"


def build_slug(case_name: str, decision_date: str | None, used: set[str]) -> str:
    base_year = (decision_date or "")[:4] or "n.d."
    base = slugify_simple(case_name)
    candidate = f"{base}-{base_year}"
    if candidate not in used:
        used.add(candidate)
        return candidate
    n = 2
    while f"{candidate}-{n}" in used:
        n += 1
    final = f"{candidate}-{n}"
    used.add(final)
    return final


# ---- read CSV -----------------------------------------------------------
print(f"Reading {CSV_PATH} ...")

print("Loading existing slugs from DB ...", end=" ", flush=True)
existing_slugs = {r["slug"] for r in select_pages("cases", "slug") if r.get("slug")}
print(f"({len(existing_slugs)} found)")

records: list[dict] = []
skipped_non_us = 0
skipped_bad_date = 0
total_rows = 0

with CSV_PATH.open(encoding="utf-8-sig", newline="") as f:
    reader = csv.DictReader(f)
    for row in reader:
        total_rows += 1
        if not is_us_row(row.get("State(s)", "")):
            skipped_non_us += 1
            continue

        case_name = clean_str(row.get("Case Name", ""))
        court = clean_str(row.get("Court", ""))
        decision_date = parse_date(row.get("Date", ""))

        if not case_name or not court or not decision_date:
            skipped_bad_date += 1
            continue

        slug = build_slug(case_name, decision_date, existing_slugs)

        records.append(
            {
                "case_name": case_name,
                "court": court,
                "state": "USA",
                "decision_date": decision_date,
                "party_type": normalize_party_type(row.get("Party(ies)", "")),
                "ai_tool": normalize_ai_tool(row.get("AI Tool", "")),
                "slug": slug,
                "is_us": True,
                "discovery_source": "charlotin_index",
                "status": "pending_opinion",
            }
        )

print(
    f"rows read: {total_rows}  ·  US-eligible: {len(records)}  ·  "
    f"skipped non-US: {skipped_non_us}  ·  skipped bad/missing date: {skipped_bad_date}"
)

# ---- upsert -------------------------------------------------------------
BATCH = 200
inserted = 0
last_print = 0
for i in range(0, len(records), BATCH):
    chunk = records[i : i + BATCH]
    upsert("cases", chunk, on_conflict="slug")
    inserted += len(chunk)
    if inserted - last_print >= 200 or inserted == len(records):
        print(f"  upserted {inserted}/{len(records)}")
        last_print = inserted

print(f"\nDone. Upserted {inserted} cases.")

# ---- verification --------------------------------------------------------
print("\n--- verification ---")
total = count_rows("cases")
lawyers = count_rows("cases", "party_type=eq.Lawyer")
pro_se = count_rows("cases", "party_type=ilike.*Pro%20Se*")
pending = count_rows("cases", "status=eq.pending_opinion")

print(f"total cases:      {total}")
print(f"  party=Lawyer:   {lawyers}")
print(f"  party=Pro Se*:  {pro_se}")
print(f"  pending_opinion:{pending}")
