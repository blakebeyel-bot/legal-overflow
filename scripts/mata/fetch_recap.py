"""
Mata Tracker — Stage 3C: RECAP fallback via Internet Archive.

CourtListener mirrors every RECAP document to Internet Archive. The IA item
identifier is `gov.uscourts.{court_id}.{pacer_case_id}` and individual docs
are named `gov.uscourts.{court_id}.{pacer_case_id}.{doc_number}.{att}.pdf`.
IA hosts the full PDFs publicly with no auth — we extract text with pypdf.

Pipeline per case:
  1. Search CL type=rd for case_name + sanctions keywords (free tier).
  2. Parse docket_id + doc_number from each result's absolute_url.
  3. Score each doc's description for sanctions-relevance.
  4. For top candidates, fetch /dockets/{docket_id}/ -> court_id, pacer_case_id.
  5. Construct IA download URL, fetch PDF, extract text with pypdf.
  6. Store the longest/highest-scoring text as opinion.

Usage:
    python scripts/mata/fetch_recap.py --pilot
    python scripts/mata/fetch_recap.py --all
    python scripts/mata/fetch_recap.py --limit 25
    python scripts/mata/fetch_recap.py --sleep 1.5

Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, COURTLISTENER_TOKEN
Requires: pypdf (already installed)
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

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
IA_HEADERS = {
    "User-Agent": "LegalOverflow-MataTracker/1.0 (blake@legaloverflow.com)",
}

import pypdf  # noqa: E402

# ---- HTTP ---------------------------------------------------------------
def http(method, url, *, body=None, headers=None, timeout=120, raw=False):
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
            f"{method} {url} -> {e.code}: {payload.decode('utf-8','replace')[:200]}"
        ) from None


def sb_get(path: str) -> list[dict]:
    _, _, payload = http("GET", f"{REST}{path}", headers=SUPA_HEADERS)
    return json.loads(payload) if payload else []


def sb_post(table, rows, prefer="return=minimal"):
    h = dict(SUPA_HEADERS)
    h["Prefer"] = prefer
    _, _, payload = http("POST", f"{REST}/{table}", body=rows, headers=h)
    return json.loads(payload) if payload else None


def sb_patch(table, where_qs, patch):
    h = dict(SUPA_HEADERS)
    h["Prefer"] = "return=minimal"
    http("PATCH", f"{REST}/{table}?{where_qs}", body=patch, headers=h)


def cl_get(url: str) -> dict:
    _, _, payload = http("GET", url, headers=CL_HEADERS, timeout=60)
    return json.loads(payload) if payload else {}


def ia_metadata(identifier: str) -> dict:
    url = f"https://archive.org/metadata/{identifier}"
    _, _, payload = http("GET", url, headers=IA_HEADERS, timeout=60)
    return json.loads(payload) if payload else {}


def ia_download(identifier: str, filename: str) -> bytes:
    url = f"https://archive.org/download/{identifier}/{filename}"
    _, _, payload = http("GET", url, headers=IA_HEADERS, timeout=180)
    return payload


# ---- helpers ------------------------------------------------------------
_NAME_NORM = re.compile(r"[^a-z0-9]+")


def name_tokens(s: str) -> set[str]:
    s = s.lower()
    s = _NAME_NORM.sub(" ", s)
    junk = {"v", "vs", "in", "re", "the", "of", "et", "al", "a", "an", "and",
            "co", "inc", "llc", "lp", "ltd", "corp", "company"}
    return {w for w in s.split() if len(w) >= 3 and w not in junk}


def names_match(a: str, b: str) -> bool:
    ta, tb = name_tokens(a), name_tokens(b)
    if not ta or not tb: return False
    return len(ta & tb) >= min(2, len(ta))


def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def _build_search_query(case_name: str) -> str:
    name = re.sub(r",\s*(Inc\.?|LLC|L\.L\.C\.?|LP|Ltd\.?|Corp\.?|Co\.?)\b",
                  "", case_name, flags=re.IGNORECASE)
    name = re.sub(r"\bet\s+al\.?", "", name, flags=re.IGNORECASE)
    name = re.sub(r"[+\-=&|><!(){}\[\]^\"~*?:\\/]", " ", name)
    name = re.sub(r"[,\.]", " ", name)
    return re.sub(r"\s+", " ", name).strip()


# Federal-court detector. Matches:
#   "D. Nevada", "S.D. New York", "E.D. Michigan", etc. (district prefix)
#   "9th Cir.", "Federal Circuit", "BAP", "JPML", "ASBCA", "Tax Court", etc.
# Does NOT match state-appellate prefixes "CA California", "AC Illinois", etc.
_FEDERAL_PREFIX = re.compile(
    r"^(D\.|S\.D\.|N\.D\.|E\.D\.|W\.D\.|M\.D\.|C\.D\.|D\.D\.|U\.S\.|USDC)\s",
    re.IGNORECASE,
)
_FEDERAL_OTHER = re.compile(
    r"\b(Cir\.|Circuit|BAP|JPML|ASBCA|GAO|Tax Court|Bankr|Bankruptcy|U\.S\.D\.C)\b",
    re.IGNORECASE,
)


def is_federal_court(court: str) -> bool:
    if not court:
        return False
    return bool(_FEDERAL_PREFIX.match(court) or _FEDERAL_OTHER.search(court))


# ---- doc scoring --------------------------------------------------------
_POS = [
    (r"\b(rule\s*11|rule\s*37|sanction(?:s|ed|ing)?)\b", 8),
    (r"\bshow\s+cause\b", 7),
    (r"\b(memorandum|opinion\s+and\s+order|memorandum\s+opinion)\b", 5),
    (r"\b(order|ruling|judgment|decision|findings|opinion)\b", 2),
    (r"\b(report\s+and\s+recommendation|r\s*&\s*r)\b", 3),
    (r"\b(grievance|disciplin|bar\s+referral|attorney(?:\s+is)?\s+referred)\b", 5),
    (r"\b(strike|stricken|frivolous|fabricated|hallucinat)\b", 4),
]
_NEG = [
    (r"\bnotice\s+of\s+appearance\b", -10),
    (r"\bcase\s+assigned\b", -10),
    (r"\bclerk('s)?\s+(notice|judgment|certificate)\b", -8),
    (r"\bsummons\b", -8),
    (r"\bcorporate\s+disclosure\b", -8),
    (r"\bcivil\s+cover\s+sheet\b", -8),
    (r"\baffidavit\b", -3),
    (r"\bin\s+forma\s+pauperis\b", -3),
    (r"\bmotion\s+(to|for)\b", -3),
    (r"\bcomplaint\b", -4),
    (r"\b(stipulation|consent)\b", -4),
    (r"\b(scheduling\s+order|status\s+conference)\b", -4),
    (r"\bmandate\b", -2),
]


def score_doc(description: str, snippet: str) -> int:
    blob = (description or "") + " " + (snippet or "")
    s = 0
    for pat, w in _POS:
        if re.search(pat, blob, re.IGNORECASE): s += w
    for pat, w in _NEG:
        if re.search(pat, blob, re.IGNORECASE): s += w
    return s


def hit_name(r: dict) -> str:
    n = r.get("caseName") or r.get("caseNameFull") or ""
    if n:
        return n
    url = r.get("absolute_url") or ""
    m = re.search(r"/docket/\d+/[^/]+/([^/]+)/?", url)
    return m.group(1).replace("-", " ") if m else ""


def parse_doc_number(absolute_url: str) -> str | None:
    """absolute_url like /docket/63107798/54/mata-v-avianca-inc/ or /docket/{docket_id}/{doc_num}/{att}/{slug}/"""
    m = re.match(r"/docket/\d+/(\d+)/", absolute_url or "")
    return m.group(1) if m else None


def parse_attachment_number(absolute_url: str) -> str:
    """Returns attachment number; default '0' if URL has 4 path segments."""
    # /docket/{docket_id}/{doc}/{slug}/ → att 0
    # /docket/{docket_id}/{doc}/{att}/{slug}/ → att N
    parts = (absolute_url or "").strip("/").split("/")
    # ['docket', '63107798', '54', '1', 'mata-v-avianca-inc']
    if len(parts) >= 5 and parts[3].isdigit():
        return parts[3]
    return "0"


# ---- search -------------------------------------------------------------
def search_recap_documents(case_name: str, decision_date: str | None) -> list[dict]:
    base_q = _build_search_query(case_name)
    q = (
        f'{base_q} AND ('
        f'sanctions OR "show cause" OR "rule 11" OR memorandum OR ruling OR '
        f'fabricated OR hallucinat* OR "opinion and order"'
        f')'
    )
    params = {"q": q, "type": "rd", "order_by": "score desc"}
    if decision_date and len(decision_date) >= 4:
        try:
            from datetime import date, timedelta
            d = date.fromisoformat(decision_date)
            params["filed_after"] = (d - timedelta(days=540)).isoformat()
            params["filed_before"] = (d + timedelta(days=540)).isoformat()
        except Exception:
            pass
    qs = urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
    res = cl_get(f"{CL_BASE}/search/?{qs}")
    return res.get("results") or []


# ---- IA fetcher ---------------------------------------------------------
class IAClient:
    def __init__(self):
        self._docket_meta_cache: dict[int, dict] = {}
        self._ia_meta_cache: dict[str, dict] = {}

    def docket_meta(self, docket_id: int) -> dict:
        if docket_id in self._docket_meta_cache:
            return self._docket_meta_cache[docket_id]
        try:
            d = cl_get(f"{CL_BASE}/dockets/{docket_id}/")
        except Exception:
            d = {}
        self._docket_meta_cache[docket_id] = d
        return d

    def ia_id_for_docket(self, docket_id: int) -> tuple[str | None, str | None]:
        d = self.docket_meta(docket_id)
        court = d.get("court_id")
        pacer = d.get("pacer_case_id")
        if not (court and pacer):
            return None, None
        ia_id = f"gov.uscourts.{court}.{pacer}"
        return ia_id, court

    def find_filename(self, ia_id: str, doc_number: str, attachment: str) -> str | None:
        if ia_id in self._ia_meta_cache:
            meta = self._ia_meta_cache[ia_id]
        else:
            try:
                meta = ia_metadata(ia_id)
            except Exception:
                meta = {}
            self._ia_meta_cache[ia_id] = meta
        files = (meta or {}).get("files") or []
        # Prefer exact match: gov.uscourts.X.Y.{doc}.{att}.pdf
        target = f"{ia_id}.{doc_number}.{attachment}.pdf"
        for f in files:
            if f.get("name") == target:
                return target
        # Fallback: any pdf matching .{doc}.<n>.pdf
        prefix = f"{ia_id}.{doc_number}."
        for f in files:
            n = f.get("name", "")
            if n.startswith(prefix) and n.endswith(".pdf"):
                return n
        return None

    def fetch_text(self, ia_id: str, filename: str) -> str:
        pdf_bytes = ia_download(ia_id, filename)
        try:
            reader = pypdf.PdfReader(io.BytesIO(pdf_bytes))
        except Exception as e:
            raise RuntimeError(f"PDF parse error: {e}") from None
        parts = []
        for page in reader.pages:
            try:
                parts.append(page.extract_text() or "")
            except Exception:
                continue
        text = "\n\n".join(parts)
        text = re.sub(r"[ \t]+\n", "\n", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()


# ---- selectors ----------------------------------------------------------
def select_pending_federal(limit: int | None) -> list[dict]:
    qparts = [
        "select=id,case_name,court,decision_date,docket_number,judge",
        "status=eq.pending_opinion",
        "order=decision_date.desc",
    ]
    if limit:
        qparts.append(f"limit={limit}")
    rows = sb_get("/cases?" + "&".join(qparts))
    return [r for r in rows if is_federal_court(r["court"])]


def select_pilot() -> list[dict]:
    rows: list[dict] = []
    for pat in ["%Mata%Avianca%", "%Mavy%Commissioner%",
                "%Dehghani%Castro%"]:
        path = (
            "/cases?select=id,case_name,court,decision_date,docket_number,judge"
            f"&case_name=ilike.{urllib.parse.quote(pat)}"
            "&status=eq.pending_opinion&limit=1"
        )
        rows.extend(sb_get(path))
    seen = set()
    return [r for r in rows if not (r["id"] in seen or seen.add(r["id"]))]


def opinion_already_stored(case_id: str, file_hash: str) -> bool:
    rows = sb_get(
        f"/opinions?select=id&case_id=eq.{case_id}"
        f"&file_hash=eq.{file_hash}&limit=1"
    )
    return bool(rows)


# ---- core ---------------------------------------------------------------
def process_case(case: dict, ia: IAClient, sleep_s: float, fetch_top_n: int = 2) -> dict:
    name = case["case_name"]
    cid = case["id"]
    out = {"case": name, "match": False, "stored": False, "chars": 0,
           "score": None, "note": ""}

    try:
        results = search_recap_documents(name, case.get("decision_date"))
    except Exception as e:
        out["note"] = f"search err: {e}"
        return out
    if not results:
        out["note"] = "no rd hits"
        return out

    # Filter and score
    matched: list[tuple[int, dict]] = []
    for r in results[:25]:
        rname = hit_name(r)
        if not names_match(name, rname):
            continue
        s = score_doc(r.get("description", ""), r.get("snippet", ""))
        if s < 4:
            continue
        matched.append((s, r))

    if not matched:
        for r in results[:5]:
            if names_match(name, hit_name(r)):
                matched.append((1, r))
                break
        if not matched:
            top = hit_name(results[0]) if results else ""
            out["note"] = f"no name-matched docs (top: {top[:60]})"
            return out

    matched.sort(key=lambda x: -x[0])
    out["match"] = True

    best_text = ""
    best_doc: dict | None = None
    best_score = -999
    last_err = ""

    for s, doc in matched[:fetch_top_n]:
        url = doc.get("absolute_url") or ""
        docket_id = doc.get("docket_id")
        doc_num = parse_doc_number(url)
        att = parse_attachment_number(url)
        if not (docket_id and doc_num):
            continue

        time.sleep(sleep_s)
        ia_id, court_id = ia.ia_id_for_docket(int(docket_id))
        if not ia_id:
            last_err = "no IA identifier (no pacer_case_id)"
            continue

        time.sleep(sleep_s)
        try:
            filename = ia.find_filename(ia_id, doc_num, att)
        except Exception as e:
            last_err = f"IA metadata err: {e}"
            continue
        if not filename:
            last_err = f"file not on IA ({ia_id} doc {doc_num})"
            continue

        time.sleep(sleep_s)
        try:
            text = ia.fetch_text(ia_id, filename)
        except Exception as e:
            last_err = f"PDF/extract err: {e}"
            continue
        if len(text) > len(best_text):
            best_text = text
            best_doc = doc
            best_doc["_ia_id"] = ia_id
            best_doc["_ia_filename"] = filename
            best_score = s

    if not best_text:
        out["note"] = last_err or "no extractable text"
        return out

    out["score"] = best_score
    fh = sha256_hex(best_text)
    if opinion_already_stored(cid, fh):
        out["stored"] = True
        out["chars"] = len(best_text)
        out["note"] = "already stored"
        return out

    abs_url = best_doc.get("absolute_url") or ""
    cl_url = (
        f"https://www.courtlistener.com{abs_url}"
        if abs_url and abs_url.startswith("/") else abs_url
    )

    sb_post("opinions", {
        "case_id": cid,
        "source": "courtlistener_recap_ia",
        "source_url": cl_url,
        "source_doc_id": str(best_doc.get("id") or ""),
        "opinion_text": best_text,
        "opinion_type": "sanctions",
        "page_count": best_doc.get("page_count"),
        "file_hash": fh,
    })

    docket_number = best_doc.get("docketNumber") or best_doc.get("docket_number")
    patch: dict = {}
    if docket_number and not case.get("docket_number"):
        patch["docket_number"] = docket_number
    if patch:
        sb_patch("cases", f"id=eq.{cid}", patch)

    out["stored"] = True
    out["chars"] = len(best_text)
    return out


# ---- driver -------------------------------------------------------------
def main():
    p = argparse.ArgumentParser()
    p.add_argument("--pilot", action="store_true")
    p.add_argument("--all", action="store_true")
    p.add_argument("--limit", type=int, default=None)
    p.add_argument("--sleep", type=float, default=1.0)
    p.add_argument("--batch", type=int, default=25)
    p.add_argument("--top-n", type=int, default=2)
    args = p.parse_args()

    cases = select_pilot() if args.pilot else select_pending_federal(args.limit)
    print(f"RECAP/IA fallback: processing {len(cases)} federal pending cases\n")
    summary = {"attempted": 0, "match": 0, "stored": 0, "errors": []}
    ia = IAClient()

    for i, c in enumerate(cases, 1):
        summary["attempted"] += 1
        try:
            res = process_case(c, ia, sleep_s=args.sleep, fetch_top_n=args.top_n)
        except Exception as e:
            res = {"case": c["case_name"], "match": False, "stored": False,
                   "chars": 0, "score": None, "note": f"unhandled: {e}"}
            summary["errors"].append(f"{c['case_name']}: {e}")

        m = "yes" if res.get("match") else "no "
        s = "stored" if res.get("stored") else "skip "
        print(
            f"  [{i:>3}/{len(cases)}] match={m} {s} score={str(res.get('score') or '-'):>4} "
            f"chars={res['chars']:>6}  ::  {c['case_name'][:70]}  "
            f"{('— ' + res['note']) if res.get('note') else ''}"
        )
        if res.get("match"): summary["match"] += 1
        if res.get("stored"): summary["stored"] += 1
        if "err" in res.get("note", ""):
            summary["errors"].append(f"{c['case_name']}: {res['note']}")

        if args.batch and i % args.batch == 0:
            print(f"\n  --- progress: {summary['stored']}/{summary['attempted']} stored via IA ---\n")
        time.sleep(args.sleep)

    print("\n=== summary ===")
    print(f"  attempted: {summary['attempted']}")
    print(f"  matched:   {summary['match']}")
    print(f"  stored:    {summary['stored']}")
    print(f"  errors:    {len(summary['errors'])}")
    for e in summary["errors"][:15]:
        print(f"     ! {e[:200]}")


if __name__ == "__main__":
    main()
