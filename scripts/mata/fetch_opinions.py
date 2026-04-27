"""
Mata Tracker — Stage 3 / 3B: fetch judicial opinion text from CourtListener.

Reads cases from Supabase where status = 'pending_opinion', searches
CourtListener for each, fetches the opinion cluster + sub-opinion text, and
writes to the `opinions` table. Updates `cases.docket_number` / `cases.judge`
opportunistically.

Usage:
    # Stage 3 pilot — 5 marquee cases
    python scripts/mata/fetch_opinions.py --pilot

    # Stage 3B — remaining cases (50 at a time, with --limit to cap)
    python scripts/mata/fetch_opinions.py --batch 50 --limit 50

    # Run everything still pending
    python scripts/mata/fetch_opinions.py --all

Env (loaded from site/.env):
    SUPABASE_URL
    SUPABASE_SERVICE_ROLE_KEY
    COURTLISTENER_TOKEN
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
from html.parser import HTMLParser
from pathlib import Path

# Force UTF-8 stdout/stderr — Windows cp1252 chokes on Unicode case names
# (Hawaiian okina, accented characters, etc.) and crashes the whole batch.
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

# ---- HTTP ---------------------------------------------------------------
def http(
    method: str,
    url: str,
    *,
    body: object | None = None,
    headers: dict | None = None,
    timeout: int = 60,
) -> tuple[int, dict, bytes]:
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


# ---- Supabase mini-client -----------------------------------------------
def sb_get(path: str) -> list[dict]:
    status, _, payload = http("GET", f"{REST}{path}", headers=SUPA_HEADERS)
    return json.loads(payload) if payload else []


def sb_post(table: str, rows: list[dict] | dict, prefer: str = "return=minimal") -> bytes:
    body = rows
    headers = dict(SUPA_HEADERS)
    headers["Prefer"] = prefer
    status, _, payload = http("POST", f"{REST}/{table}", body=body, headers=headers)
    return payload


def sb_patch(table: str, where_qs: str, patch: dict) -> None:
    headers = dict(SUPA_HEADERS)
    headers["Prefer"] = "return=minimal"
    http("PATCH", f"{REST}/{table}?{where_qs}", body=patch, headers=headers)


# ---- helpers ------------------------------------------------------------
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


_NAME_NORM = re.compile(r"[^a-z0-9]+")


def name_tokens(s: str) -> set[str]:
    s = s.lower()
    s = _NAME_NORM.sub(" ", s)
    junk = {
        "v", "vs", "in", "re", "the", "of", "et", "al", "a", "an", "and",
        "co", "inc", "llc", "lp", "ltd", "corp", "company",
    }
    return {w for w in s.split() if len(w) >= 3 and w not in junk}


def names_match(query_name: str, result_name: str) -> bool:
    """Strict-ish check: require at least min(2, |query_tokens|) shared
    significant tokens — handles 'Park v. Kim' (2 tokens) and longer cases."""
    a, b = name_tokens(query_name), name_tokens(result_name)
    if not a or not b:
        return False
    overlap = len(a & b)
    needed = min(2, len(a))
    return overlap >= needed


def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


# ---- CourtListener helpers ---------------------------------------------
def cl_get(url: str) -> dict:
    status, _, payload = http("GET", url, headers=CL_HEADERS, timeout=60)
    return json.loads(payload) if payload else {}


def _build_search_query(case_name: str) -> str:
    """Strip Inc/LLC/et al boilerplate AND Elasticsearch reserved chars
    (`+ - = && || > < ! ( ) { } [ ] ^ " ~ * ? : \\ /` and `&`) — CourtListener's
    backend 500s if these reach the q parameter unescaped."""
    name = re.sub(r",\s*(Inc\.?|LLC|L\.L\.C\.?|LP|Ltd\.?|Corp\.?|Co\.?)\b",
                  "", case_name, flags=re.IGNORECASE)
    name = re.sub(r"\bet\s+al\.?", "", name, flags=re.IGNORECASE)
    # nuke ES reserved + a couple of common offenders (slash, ampersand)
    name = re.sub(r"[+\-=&|><!(){}\[\]^\"~*?:\\/]", " ", name)
    name = re.sub(r"[,\.]", " ", name)
    return re.sub(r"\s+", " ", name).strip()


def search_case(case_name: str, decision_date: str | None = None) -> dict | None:
    """Score-sorted search with optional ±180 day window around decision_date.
    Walks top results until one matches our case-name token check."""
    q = _build_search_query(case_name)
    params = {"q": q, "type": "o", "order_by": "score desc"}
    if decision_date and len(decision_date) >= 4:
        try:
            from datetime import date, timedelta
            d = date.fromisoformat(decision_date)
            params["filed_after"] = (d - timedelta(days=180)).isoformat()
            params["filed_before"] = (d + timedelta(days=180)).isoformat()
        except Exception:
            pass

    qs = urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
    url = f"{CL_BASE}/search/?{qs}"
    res = cl_get(url)
    results = res.get("results") or []
    # walk top 5 looking for an actual name match
    for r in results[:5]:
        rname = r.get("caseName") or r.get("caseNameFull") or ""
        if names_match(case_name, rname):
            return r
    # fall back: top result (caller validates again)
    return results[0] if results else None


def fetch_cluster(cluster_id: int | str) -> dict:
    return cl_get(f"{CL_BASE}/clusters/{cluster_id}/")


def fetch_opinion_doc(url: str) -> dict:
    return cl_get(url)


def extract_text_from_opinion(op: dict) -> str:
    txt = (op.get("plain_text") or "").strip()
    if txt:
        return txt
    htmlc = op.get("html_with_citations") or op.get("html") or op.get("xml_harvard") or ""
    if htmlc:
        return html_to_text(htmlc)
    return ""


# ---- core pipeline ------------------------------------------------------
def select_pending(case_filters: list[str] | None, limit: int | None) -> list[dict]:
    qparts = ["select=id,case_name,court,decision_date,docket_number,judge",
              "status=eq.pending_opinion",
              "order=decision_date.desc"]
    if limit:
        qparts.append(f"limit={limit}")
    if case_filters:
        # OR of ilike patterns
        ors = ",".join(f"case_name.ilike.*{urllib.parse.quote(p)}*" for p in case_filters)
        qparts.append(f"or=({ors})")
    return sb_get("/cases?" + "&".join(qparts))


def opinion_already_stored(case_id: str, file_hash: str) -> bool:
    qs = (
        f"/opinions?select=id"
        f"&case_id=eq.{case_id}"
        f"&file_hash=eq.{file_hash}"
        f"&limit=1"
    )
    rows = sb_get(qs)
    return bool(rows)


def process_case(case: dict, sleep_s: float = 1.0) -> dict:
    name = case["case_name"]
    cid = case["id"]
    out = {"case": name, "match": False, "stored": False, "chars": 0, "note": ""}

    try:
        result = search_case(name, case.get("decision_date"))
    except Exception as e:
        out["note"] = f"search error: {e}"
        return out
    if not result:
        out["note"] = "no search results"
        return out

    result_name = result.get("caseName") or result.get("caseNameFull") or ""
    if not names_match(name, result_name):
        out["note"] = f"name mismatch (got: {result_name!r})"
        return out
    out["match"] = True
    out["matched_name"] = result_name

    cluster_id = result.get("cluster_id") or result.get("id")
    if not cluster_id:
        out["note"] = "no cluster id in search hit"
        return out
    time.sleep(sleep_s)

    try:
        cluster = fetch_cluster(cluster_id)
    except Exception as e:
        out["note"] = f"cluster fetch error: {e}"
        return out

    docket_number = cluster.get("docket_number") or result.get("docketNumber")
    judge = cluster.get("judges") or result.get("judge")

    sub_urls = cluster.get("sub_opinions") or []
    if not sub_urls and cluster.get("opinions"):
        sub_urls = [op.get("resource_uri") for op in cluster["opinions"] if op.get("resource_uri")]

    if not sub_urls:
        out["note"] = "no sub_opinions"
        return out

    longest_text = ""
    longest_op_url = ""
    for op_url in sub_urls:
        time.sleep(sleep_s)
        try:
            op = fetch_opinion_doc(op_url)
        except Exception as e:
            out["note"] = f"opinion fetch err: {e}"
            continue
        text = extract_text_from_opinion(op)
        if len(text) > len(longest_text):
            longest_text = text
            longest_op_url = op.get("absolute_url") or op_url

    if not longest_text:
        out["note"] = "all opinions empty"
        return out

    fh = sha256_hex(longest_text)
    if opinion_already_stored(cid, fh):
        out["note"] = "already stored (hash match)"
        out["stored"] = True
        out["chars"] = len(longest_text)
        return out

    source_url = (
        f"https://www.courtlistener.com{longest_op_url}"
        if longest_op_url and longest_op_url.startswith("/")
        else longest_op_url
    )

    sb_post(
        "opinions",
        {
            "case_id": cid,
            "source": "courtlistener",
            "source_url": source_url,
            "source_doc_id": str(cluster_id),
            "opinion_text": longest_text,
            "opinion_type": "sanctions",
            "file_hash": fh,
        },
    )

    patch = {}
    if docket_number and not case.get("docket_number"):
        patch["docket_number"] = docket_number
    if judge and not case.get("judge"):
        patch["judge"] = judge if isinstance(judge, str) else str(judge)
    if patch:
        sb_patch("cases", f"id=eq.{cid}", patch)

    out["stored"] = True
    out["chars"] = len(longest_text)
    return out


# ---- entry --------------------------------------------------------------
PILOT_PATTERNS = [
    "Mata",       # Mata v. Avianca (also matches some others - tightened below)
    "Park",       # Park v. Kim
    "Mavy",       # Mavy v. Commissioner
    "Dehghani",   # Dehghani v. Castro
    "Idehen",     # Idehen v. Stoute-Phillip
]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--pilot", action="store_true", help="run the 5 marquee pilot cases")
    p.add_argument("--all", action="store_true", help="run all pending cases")
    p.add_argument("--batch", type=int, default=50, help="progress checkpoint size")
    p.add_argument("--limit", type=int, default=None, help="cap N cases this run")
    p.add_argument("--sleep", type=float, default=1.0, help="seconds between CL calls")
    args = p.parse_args()

    if args.pilot:
        # Tight ilike patterns — match against the 5 specific cases
        cases: list[dict] = []
        for pat in [
            "%Mata%Avianca%",
            "%Park%Kim%",
            "%Mavy%Commissioner%",
            "%Dehghani%Castro%",
            "%Idehen%",
        ]:
            qs = (
                f"/cases?select=id,case_name,court,decision_date,docket_number,judge"
                f"&case_name=ilike.{urllib.parse.quote(pat)}"
                f"&limit=1"
            )
            cases.extend(sb_get(qs))
        # de-dup by id
        seen = set()
        cases = [c for c in cases if not (c["id"] in seen or seen.add(c["id"]))]
    else:
        cases = select_pending(None, args.limit)

    print(f"processing {len(cases)} cases\n")
    summary = {"attempted": 0, "found": 0, "stored": 0, "not_found": [], "errors": []}

    for i, c in enumerate(cases, 1):
        summary["attempted"] += 1
        res = process_case(c, sleep_s=args.sleep)
        match_str = "yes" if res.get("match") else "no "
        store_str = "stored" if res.get("stored") else "skip "
        print(
            f"  [{i:>3}/{len(cases)}] match={match_str} {store_str} "
            f"chars={res['chars']:>6}  ·  {c['case_name'][:80]}  "
            f"{('— ' + res['note']) if res.get('note') else ''}"
        )
        if res.get("match"):
            summary["found"] += 1
        if res.get("stored"):
            summary["stored"] += 1
        if not res.get("match") and "error" not in res.get("note", ""):
            summary["not_found"].append(c["case_name"])
        if "error" in res.get("note", ""):
            summary["errors"].append(f"{c['case_name']} :: {res['note']}")

        if args.batch and i % args.batch == 0:
            print(
                f"\n  --- progress: {summary['stored']}/{summary['attempted']} stored ---\n"
            )
        # tiny breather between cases — search has its own rate limit
        time.sleep(args.sleep)

    print("\n=== summary ===")
    print(f"  attempted: {summary['attempted']}")
    print(f"  match:     {summary['found']}")
    print(f"  stored:    {summary['stored']}")
    print(f"  not found: {len(summary['not_found'])}")
    if summary["not_found"]:
        for n in summary["not_found"][:30]:
            print(f"     - {n}")
    if summary["errors"]:
        print(f"  errors:    {len(summary['errors'])}")
        for e in summary["errors"][:10]:
            print(f"     ! {e}")


if __name__ == "__main__":
    main()
