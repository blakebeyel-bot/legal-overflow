"""
Mata Tracker — Stage 7: weekly automated discovery of new AI-sanction cases.

Searches CourtListener (and optionally Google Scholar Case Law) for recent
opinions matching a battery of AI-misconduct queries. Deduplicates against
the existing cases table, inserts brand-new cases, fetches their opinion
text, and (optionally) annotates them via the Claude API.

Every run is recorded in `discovery_log` with the queries used and the
counts found / added / skipped.

Usage:
    python scripts/mata/discover_new_cases.py                # discover only
    python scripts/mata/discover_new_cases.py --annotate     # discover + annotate
    python scripts/mata/discover_new_cases.py --lookback 60  # last 60 days
    python scripts/mata/discover_new_cases.py --scholar      # also try Google Scholar
    python scripts/mata/discover_new_cases.py --dry          # don't write to DB

Env (loaded from site/.env):
    SUPABASE_URL
    SUPABASE_SERVICE_ROLE_KEY
    COURTLISTENER_TOKEN
    ANTHROPIC_API_KEY  (only required for --annotate)
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from html.parser import HTMLParser
from pathlib import Path

# Force UTF-8 stdout/stderr — Windows cp1252 chokes on Unicode case names.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
except Exception:
    pass

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
CL_TOKEN = os.environ.get("COURTLISTENER_TOKEN")
ANTHROPIC_KEY = (
    os.environ.get("ANTHROPIC_API_KEY")
    or os.environ.get("LO_ANTHROPIC_API_KEY")
)
if not (SUPABASE_URL and SUPABASE_KEY and CL_TOKEN):
    sys.exit("missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / COURTLISTENER_TOKEN")

REST = f"{SUPABASE_URL}/rest/v1"
SUPA_HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
}
CL_BASE = "https://www.courtlistener.com/api/rest/v4"
CL_HEADERS = {
    "Authorization": f"Token {CL_TOKEN}",
    "User-Agent": "LegalOverflow-MataTracker/1.0 (blake@legaloverflow.com)",
}

# ---- HTTP helpers -------------------------------------------------------
def http(method: str, url: str, *, body=None, headers=None, timeout=60):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    h = dict(headers or {})
    if data is not None:
        h.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        payload = e.read()
        raise RuntimeError(
            f"{method} {url} -> {e.code}: {payload.decode('utf-8','replace')[:400]}"
        ) from None


def sb_get(path: str) -> list[dict]:
    _, _, payload = http("GET", f"{REST}{path}", headers=SUPA_HEADERS)
    return json.loads(payload) if payload else []


def sb_post(table: str, rows, prefer="return=representation"):
    h = dict(SUPA_HEADERS)
    h["Prefer"] = prefer
    _, _, payload = http("POST", f"{REST}/{table}", body=rows, headers=h)
    return json.loads(payload) if payload else None


def sb_patch(table: str, where_qs: str, patch: dict) -> None:
    h = dict(SUPA_HEADERS)
    h["Prefer"] = "return=minimal"
    http("PATCH", f"{REST}/{table}?{where_qs}", body=patch, headers=h)


# ---- HTML stripper for opinion fallback ---------------------------------
class _Stripper(HTMLParser):
    def __init__(self):
        super().__init__()
        self.buf: list[str] = []

    def handle_data(self, data):
        self.buf.append(data)

    def handle_endtag(self, tag):
        if tag in ("p", "div", "br", "li"):
            self.buf.append("\n")


def html_to_text(s: str) -> str:
    p = _Stripper()
    try:
        p.feed(s)
    except Exception:
        return ""
    out = "".join(p.buf)
    out = html.unescape(out)
    out = re.sub(r"[ \t]+\n", "\n", out)
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out.strip()


# ---- token / slug helpers -----------------------------------------------
_NAME_NORM = re.compile(r"[^a-z0-9]+")
_SLUG_RE = re.compile(r"[^a-z0-9]+")


def name_tokens(s: str) -> set[str]:
    s = s.lower()
    s = _NAME_NORM.sub(" ", s)
    junk = {
        "v", "vs", "in", "re", "the", "of", "et", "al", "a", "an", "and",
        "co", "inc", "llc", "lp", "ltd", "corp", "company",
    }
    return {w for w in s.split() if len(w) >= 3 and w not in junk}


def names_match(a: str, b: str) -> bool:
    ta, tb = name_tokens(a), name_tokens(b)
    if not ta or not tb:
        return False
    return len(ta & tb) >= min(2, len(ta))


def slugify(value: str, max_length: int = 60) -> str:
    s = value.lower()
    s = _SLUG_RE.sub("-", s).strip("-")
    if len(s) > max_length:
        cut = s[:max_length]
        if "-" in cut:
            cut = cut.rsplit("-", 1)[0]
        s = cut.strip("-")
    return s or "case"


def build_slug(case_name: str, decision_date: str | None, used: set[str]) -> str:
    base_year = (decision_date or "")[:4] or "n.d."
    base = slugify(case_name)
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


def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def _build_search_query(case_name: str) -> str:
    name = re.sub(r",\s*(Inc\.?|LLC|L\.L\.C\.?|LP|Ltd\.?|Corp\.?|Co\.?)\b",
                  "", case_name, flags=re.IGNORECASE)
    name = re.sub(r"\bet\s+al\.?", "", name, flags=re.IGNORECASE)
    name = re.sub(r"[+\-=&|><!(){}\[\]^\"~*?:\\/]", " ", name)
    name = re.sub(r"[,\.]", " ", name)
    return re.sub(r"\s+", " ", name).strip()


# ---- queries (Stage 7 spec) ---------------------------------------------
QUERIES = [
    '"artificial intelligence" AND "sanctions"',
    '"ChatGPT" AND "sanctions"',
    '"AI generated" AND "fabricated"',
    '"hallucinated" AND "citations"',
    '"generative AI" AND "Rule 11"',
    '"AI tool" AND "show cause"',
    '"large language model" AND "sanctions"',
]


def cl_search(query: str, filed_after: str, page: int = 1) -> dict:
    qs = urllib.parse.urlencode(
        {"q": query, "type": "o", "order_by": "dateFiled desc",
         "filed_after": filed_after, "page": page},
        quote_via=urllib.parse.quote,
    )
    _, _, payload = http("GET", f"{CL_BASE}/search/?{qs}", headers=CL_HEADERS)
    return json.loads(payload) if payload else {}


def cl_cluster(cluster_id) -> dict:
    _, _, payload = http("GET", f"{CL_BASE}/clusters/{cluster_id}/", headers=CL_HEADERS)
    return json.loads(payload) if payload else {}


def cl_opinion(url: str) -> dict:
    _, _, payload = http("GET", url, headers=CL_HEADERS)
    return json.loads(payload) if payload else {}


def extract_opinion_text(op: dict) -> str:
    txt = (op.get("plain_text") or "").strip()
    if txt:
        return txt
    htmlc = op.get("html_with_citations") or op.get("html") or op.get("xml_harvard") or ""
    return html_to_text(htmlc) if htmlc else ""


# ---- dedup against existing cases ---------------------------------------
def load_existing_signatures() -> tuple[set[str], list[tuple[set[str], str]]]:
    """Return (slugs, [(token_set, case_name)]) for fuzzy match."""
    slugs: set[str] = set()
    sigs: list[tuple[set[str], str]] = []
    offset = 0
    while True:
        path = f"/cases?select=slug,case_name&limit=1000&offset={offset}"
        rows = sb_get(path)
        for r in rows:
            if r.get("slug"):
                slugs.add(r["slug"])
            if r.get("case_name"):
                sigs.append((name_tokens(r["case_name"]), r["case_name"]))
        if len(rows) < 1000:
            break
        offset += 1000
    return slugs, sigs


def is_duplicate_name(name: str, sigs: list[tuple[set[str], str]]) -> str | None:
    """Returns matching existing case name if a fuzzy duplicate, else None."""
    tokens = name_tokens(name)
    if not tokens:
        return None
    for tk, existing in sigs:
        if not tk:
            continue
        # Require strong overlap: at least 3 shared tokens OR ≥80% of the smaller set
        overlap = len(tokens & tk)
        smaller = min(len(tokens), len(tk))
        if smaller and (overlap >= 3 or overlap / smaller >= 0.8):
            return existing
    return None


# ---- Google Scholar (best-effort) ---------------------------------------
class _ScholarParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_h3 = False
        self.in_link = False
        self.cur_text: list[str] = []
        self.cur_href = ""
        self.results: list[dict] = []

    def handle_starttag(self, tag, attrs):
        if tag == "h3":
            self.in_h3 = True
            self.cur_text = []
        if tag == "a" and self.in_h3:
            self.in_link = True
            d = dict(attrs)
            self.cur_href = d.get("href", "")

    def handle_endtag(self, tag):
        if tag == "h3" and self.in_h3:
            text = "".join(self.cur_text).strip()
            if text:
                self.results.append({"title": text, "href": self.cur_href})
            self.in_h3 = False
            self.in_link = False

    def handle_data(self, data):
        if self.in_h3:
            self.cur_text.append(data)


def scholar_search(query: str, lookback_days: int) -> list[dict]:
    """Best-effort Scholar Case Law scrape. Google may rate-limit / captcha;
    use lightly and only as a backup signal."""
    iso = (date.today() - timedelta(days=lookback_days)).isoformat()
    q = f'{query} after:{iso}'
    qs = urllib.parse.urlencode({"q": q, "hl": "en", "as_sdt": "6,33"})
    url = f"https://scholar.google.com/scholar?{qs}"
    try:
        _, _, payload = http("GET", url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                          "AppleWebKit/537.36 (KHTML, like Gecko) "
                          "Chrome/124.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9",
        }, timeout=30)
    except Exception as e:
        print(f"  scholar query failed: {e}")
        return []
    p = _ScholarParser()
    try:
        p.feed(payload.decode("utf-8", "replace"))
    except Exception:
        pass
    return p.results


# ---- last-run lookback -------------------------------------------------
def last_run_date(default_lookback_days: int) -> str:
    rows = sb_get(
        "/discovery_log?select=run_date&source=eq.courtlistener_search"
        "&order=run_date.desc&limit=1"
    )
    if rows and rows[0].get("run_date"):
        return rows[0]["run_date"][:10]
    return (date.today() - timedelta(days=default_lookback_days)).isoformat()


# ---- core --------------------------------------------------------------
def fetch_and_store_opinion(case_id: str, cluster_id, sleep_s: float, dry: bool) -> int:
    """Returns opinion text length stored, or 0 if nothing stored."""
    cluster = cl_cluster(cluster_id)
    time.sleep(sleep_s)
    docket_number = cluster.get("docket_number")
    judge = cluster.get("judges")
    sub_urls = cluster.get("sub_opinions") or []
    longest_text, longest_url = "", ""
    for op_url in sub_urls:
        time.sleep(sleep_s)
        try:
            op = cl_opinion(op_url)
        except Exception:
            continue
        txt = extract_opinion_text(op)
        if len(txt) > len(longest_text):
            longest_text = txt
            longest_url = op.get("absolute_url") or op_url
    if not longest_text:
        return 0
    if dry:
        return len(longest_text)
    fh = sha256_hex(longest_text)
    src_url = (
        f"https://www.courtlistener.com{longest_url}"
        if longest_url and longest_url.startswith("/")
        else longest_url
    )
    sb_post("opinions", {
        "case_id": case_id,
        "source": "courtlistener",
        "source_url": src_url,
        "source_doc_id": str(cluster_id),
        "opinion_text": longest_text,
        "opinion_type": "sanctions",
        "file_hash": fh,
    })
    patch = {}
    if docket_number:
        patch["docket_number"] = docket_number
    if judge:
        patch["judge"] = judge if isinstance(judge, str) else str(judge)
    if patch:
        sb_patch("cases", f"id=eq.{case_id}", patch)
    return len(longest_text)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--annotate", action="store_true",
                   help="run annotation Skill on newly added cases")
    p.add_argument("--lookback", type=int, default=None,
                   help="search last N days (default: since last run, or 30)")
    p.add_argument("--scholar", action="store_true",
                   help="also try Google Scholar Case Law (best-effort)")
    p.add_argument("--dry", action="store_true",
                   help="don't write to DB")
    p.add_argument("--sleep", type=float, default=2.0,
                   help="seconds between API calls")
    args = p.parse_args()

    filed_after = last_run_date(args.lookback or 30)
    if args.lookback:
        filed_after = (date.today() - timedelta(days=args.lookback)).isoformat()
    print(f"discovery: searching cases filed after {filed_after}")

    print("loading existing case signatures...", end=" ", flush=True)
    slugs, sigs = load_existing_signatures()
    print(f"({len(slugs)} cases)")

    summary = {
        "results_total": 0,
        "added": [],
        "skipped_dup": [],
        "opinion_failed": [],
    }

    seen_in_run: set[int] = set()  # cluster ids we've already processed this run

    for q in QUERIES:
        print(f"\n[CL] {q}")
        try:
            res = cl_search(q, filed_after)
        except Exception as e:
            print(f"  search error: {e}")
            continue
        results = res.get("results") or []
        summary["results_total"] += len(results)
        print(f"  {len(results)} hits")
        for hit in results:
            cid = hit.get("cluster_id") or hit.get("id")
            if cid in seen_in_run:
                continue
            seen_in_run.add(cid)
            case_name = hit.get("caseName") or hit.get("caseNameFull") or ""
            court = hit.get("court") or hit.get("court_id") or "Unknown"
            decided = (hit.get("dateFiled") or "")[:10] or None
            if not (case_name and decided):
                continue
            existing = is_duplicate_name(case_name, sigs)
            if existing:
                summary["skipped_dup"].append((case_name, existing))
                continue

            slug = build_slug(case_name, decided, slugs)
            new_case = {
                "case_name": case_name,
                "court": court if isinstance(court, str) else str(court),
                "state": "USA",
                "decision_date": decided,
                "party_type": "Unknown",
                "ai_tool": None,
                "slug": slug,
                "is_us": True,
                "discovery_source": "courtlistener_search",
                "status": "pending_opinion",
            }
            print(f"  + {case_name}  ({court}, {decided})")
            if args.dry:
                summary["added"].append(new_case)
                continue
            try:
                inserted = sb_post("cases", new_case)
                cid_uuid = inserted[0]["id"]
                # add to signature list so further hits in same run dedupe correctly
                sigs.append((name_tokens(case_name), case_name))
            except Exception as e:
                print(f"    insert error: {e}")
                continue
            try:
                chars = fetch_and_store_opinion(cid_uuid, cid, args.sleep, args.dry)
                if chars:
                    print(f"    opinion stored ({chars} chars)")
                    new_case["_opinion_chars"] = chars
                else:
                    print("    opinion not retrievable")
                    summary["opinion_failed"].append(case_name)
            except Exception as e:
                print(f"    opinion fetch error: {e}")
                summary["opinion_failed"].append(case_name)
            summary["added"].append(new_case)
            time.sleep(args.sleep)

    # Google Scholar (best-effort) — only emits potential leads, doesn't auto-add
    if args.scholar:
        print("\n[Scholar] best-effort secondary search")
        for q in QUERIES:
            try:
                hits = scholar_search(q, args.lookback or 30)
            except Exception as e:
                print(f"  {q}: {e}")
                continue
            print(f"  {q!r:.50}  -> {len(hits)} hits")
            for h in hits[:5]:
                title = h.get("title", "")
                if is_duplicate_name(title, sigs):
                    continue
                print(f"    ? {title[:120]}")
            time.sleep(args.sleep)

    # log the run
    queries_concat = " | ".join(QUERIES)
    if not args.dry:
        sb_post("discovery_log", {
            "source": "courtlistener_search",
            "query_used": queries_concat[:5000],
            "results_found": summary["results_total"],
            "cases_added": len(summary["added"]),
            "cases_skipped": len(summary["skipped_dup"]),
            "notes": f"opinion_failed={len(summary['opinion_failed'])}; lookback_from={filed_after}",
        })

    print("\n=== summary ===")
    print(f"  results found: {summary['results_total']}")
    print(f"  cases added:   {len(summary['added'])}")
    for c in summary["added"]:
        chars = f"  ({c['_opinion_chars']} chars)" if c.get("_opinion_chars") else ""
        print(f"     + {c['case_name']}  ::  {c['court']}  ::  {c['decision_date']}{chars}")
    print(f"  duplicates skipped: {len(summary['skipped_dup'])}")
    for n, e in summary["skipped_dup"][:10]:
        print(f"     ~ {n}  (matches existing: {e})")
    print(f"  opinion fetch failed: {len(summary['opinion_failed'])}")
    for n in summary["opinion_failed"][:10]:
        print(f"     ! {n}")

    # optional annotation pass
    if args.annotate and summary["added"] and not args.dry:
        print("\n--- running annotation pass on new cases ---")
        # Reuse the annotation script via subprocess to keep the codepaths separate.
        import subprocess
        # Annotate every case currently in 'opinion_fetched' with no annotation —
        # this catches the new cases plus any prior leftovers cleanly.
        result = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("annotate.py")), "--all"],
            cwd=str(Path(__file__).resolve().parents[2]),
            capture_output=True,
            text=True,
        )
        print(result.stdout[-4000:])
        if result.returncode != 0:
            print(result.stderr[-2000:])


if __name__ == "__main__":
    main()
