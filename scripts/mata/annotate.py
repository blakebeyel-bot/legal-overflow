"""
Mata Tracker — Stage 4 / 5: practitioner annotations via Claude API.

Reads cases that have at least one stored opinion, sends the longest
opinion text + identification metadata to Claude, parses the structured
JSON response, and writes:
  - one row to `annotations` (status='draft', is_provisional=false, generated_by='claude')
  - one row per recommended Skill into `skill_links`

Idempotent: skips cases that already have a draft/published annotation.
Re-runs on a case re-write the latest draft (versions handled later).

Usage:
    # Stage 4 — pilot on the 5 marquee cases (whichever have opinions)
    python scripts/mata/annotate.py --pilot

    # Stage 5 — every case with an opinion, no annotation yet
    python scripts/mata/annotate.py --all

    # Test run (dry, prints JSON, doesn't write)
    python scripts/mata/annotate.py --pilot --dry

Env (loaded from site/.env):
    SUPABASE_URL
    SUPABASE_SERVICE_ROLE_KEY
    ANTHROPIC_API_KEY
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
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
        k, v = k.strip(), v.strip()
        # Override empty/missing values from the OS environment so a stale
        # blank ANTHROPIC_API_KEY in the shell doesn't shadow our .env.
        if not os.environ.get(k):
            os.environ[k] = v

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = (
    os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    or os.environ.get("SUPABASE_KEY")
)
ANTHROPIC_KEY = (
    os.environ.get("ANTHROPIC_API_KEY")
    or os.environ.get("LO_ANTHROPIC_API_KEY")
)
if not (SUPABASE_URL and SUPABASE_KEY and ANTHROPIC_KEY):
    sys.exit("missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / ANTHROPIC_API_KEY")

REST = f"{SUPABASE_URL}/rest/v1"
SUPA_HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
}

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_HEADERS = {
    "x-api-key": ANTHROPIC_KEY,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
}
MODEL = "claude-sonnet-4-20250514"
MAX_TOKENS = 4096

# ---- HTTP ---------------------------------------------------------------
def http(method: str, url: str, *, body=None, headers=None, timeout=120):
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
            f"{method} {url} -> {e.code}: {payload.decode('utf-8','replace')[:600]}"
        ) from None


def sb_get(path: str) -> list[dict]:
    _, _, payload = http("GET", f"{REST}{path}", headers=SUPA_HEADERS)
    return json.loads(payload) if payload else []


def sb_post(table: str, rows, prefer="return=representation"):
    h = dict(SUPA_HEADERS)
    h["Prefer"] = prefer
    _, _, payload = http("POST", f"{REST}/{table}", body=rows, headers=h)
    return json.loads(payload) if payload else None


# ---- prompt -------------------------------------------------------------
SYSTEM = """You are a practitioner-focused legal analyst writing for Legal Overflow, a field journal on AI and the legal profession. Your audience is in-house counsel, managing partners, and firm risk officers.

You will receive the full text of a judicial opinion involving AI-generated hallucinations or AI misuse in court filings, plus basic case identification data. Your job is to read the opinion carefully and produce a structured practitioner annotation as a JSON object.

CRITICAL: All of your analysis must come from the opinion text itself. Pin-cite to specific pages or paragraphs where possible. Do not import or reference any third-party commentary or database. You are reading the primary source and forming your own analysis.

VOICE AND STYLE:
- Plain, direct English. No jargon for jargon's sake.
- Never use em dashes. Use commas, periods, or parentheses instead.
- Lawyerly without being stuffy. Practitioner-focused, not academic.
- Specific. Pin-cite to the opinion ("The court noted at *4 that...").
- No hedging. State the analysis directly.
- Do not use "it could be argued" or "one might consider."

OUTPUT: Respond with ONLY a valid JSON object. No markdown fences, no preamble, no commentary.

JSON STRUCTURE:
{
  "severity": "low|moderate|high|severe",
  "one_line": "Single-sentence summary, max 150 chars, no em dashes",
  "what_happened": "Plain-language narrative, 2-4 paragraphs, for a busy GC. Pin-cite to opinion.",
  "what_went_wrong": "Root cause analysis, 1-2 paragraphs",
  "outcome_summary": "Short label: e.g. 'Monetary Sanction', 'Bar Referral', 'Warning', 'Brief Struck', 'Pro Hac Vice Revoked'",
  "monetary_penalty_usd": number or null,
  "professional_sanction": true/false,
  "rule_1_1_competence": {"applies": bool, "analysis": "2-3 sentences with pin-cites", "risk_level": "none|low|moderate|high"},
  "rule_1_4_communication": {"applies": bool, "analysis": "2-3 sentences", "risk_level": "none|low|moderate|high"},
  "rule_1_6_confidentiality": {"applies": bool, "analysis": "2-3 sentences", "risk_level": "none|low|moderate|high"},
  "rule_3_3_candor": {"applies": bool, "analysis": "2-3 sentences with pin-cites", "risk_level": "none|low|moderate|high"},
  "rule_5_1_supervisory": {"applies": bool, "analysis": "2-3 sentences", "risk_level": "none|low|moderate|high"},
  "rule_5_3_nonlawyer": {"applies": bool, "analysis": "2-3 sentences", "risk_level": "none|low|moderate|high"},
  "rule_8_4_misconduct": {"applies": bool, "analysis": "2-3 sentences", "risk_level": "none|low|moderate|high"},
  "insurance_exposure": "Malpractice/E&O analysis, 2-3 sentences",
  "bar_referral_risk": "Likelihood and basis, 2-3 sentences",
  "firm_policy_takeaway": "Specific adoptable policy language a firm could use today",
  "prevention_notes": "What workflow would have prevented this, reference Skill slugs",
  "skill_recommendations": [
    {"skill_slug": "slug", "skill_name": "Name", "relevance_note": "1-2 sentences"}
  ]
}

SEVERITY:
- low: Warning/admonishment only, no monetary or professional consequence
- moderate: Monetary sanction under $5,000 or order to show cause
- high: Monetary sanction $5,000+, brief struck, or pro hac vice revoked
- severe: Bar referral, suspension, disbarment, or criminal contempt

AVAILABLE SKILL SLUGS:
- citation-verification-protocol: Bluebook form-check with verification report
- contract-redline-tier-1: Contract review with confidence gates
- deposition-prep-workflow: Transcript ingestion and cross-exam outline
- ai-disclosure-rider: Engagement letter rider for AI use disclosure
- mtd-research-workflow: Motion-to-dismiss research with [VERIFY] discipline
- clause-extractor: Contract segmentation for downstream review
- wills-trusts-estates: Estate planning package with ethics gates"""


USER_TEMPLATE = """Annotate the following case for the Mata Tracker. Read the opinion text carefully and base your entire analysis on what the court actually wrote.

CASE IDENTIFICATION:
- Case name: {case_name}
- Court: {court}
- Decision date: {decision_date}
- Party type: {party_type}
- AI tool: {ai_tool}

FULL OPINION TEXT:
{opinion_text}"""


SKILL_SLUG_TO_URL = {
    "citation-verification-protocol": "/skills/citation-verification-protocol",
    "contract-redline-tier-1": "/skills/contract-redline-tier-1",
    "deposition-prep-workflow": "/skills/deposition-prep-workflow",
    "ai-disclosure-rider": "/skills/ai-disclosure-rider",
    "mtd-research-workflow": "/skills/mtd-research-workflow",
    "clause-extractor": "/skills/clause-extractor",
    "wills-trusts-estates": "/skills/wills-trusts-estates",
}


# ---- selectors ----------------------------------------------------------
def select_pilot() -> list[dict]:
    """Cases with stored opinions whose name matches a pilot pattern."""
    rows: list[dict] = []
    for pat in [
        "%Park%Kim%",
        "%Mata%Avianca%",
        "%Mavy%Commissioner%",
        "%Dehghani%Castro%",
        "%Idehen%",
    ]:
        path = (
            "/cases?select=id,case_name,court,decision_date,party_type,ai_tool,"
            "opinions(id,opinion_text,opinion_type)"
            f"&case_name=ilike.{urllib.parse.quote(pat)}"
            "&opinions.order=created_at.desc&limit=1"
        )
        rows.extend(sb_get(path))
    return [r for r in rows if r.get("opinions")]


def select_all_with_opinion() -> list[dict]:
    """Cases that have an opinion but no annotation yet."""
    # Pull cases with status in opinion_fetched + their opinions joined.
    path = (
        "/cases?select=id,case_name,court,decision_date,party_type,ai_tool,"
        "opinions(id,opinion_text,opinion_type),"
        "annotations(id)"
        "&status=eq.opinion_fetched"
        "&order=decision_date.desc"
    )
    rows = sb_get(path)
    return [r for r in rows if r.get("opinions") and not r.get("annotations")]


def longest_opinion(case: dict) -> dict | None:
    ops = case.get("opinions") or []
    ops = [o for o in ops if (o.get("opinion_text") or "").strip()]
    if not ops:
        return None
    return max(ops, key=lambda o: len(o["opinion_text"]))


# ---- claude call --------------------------------------------------------
def call_claude(case: dict, opinion_text: str) -> dict:
    user_msg = USER_TEMPLATE.format(
        case_name=case["case_name"],
        court=case["court"],
        decision_date=case["decision_date"],
        party_type=case.get("party_type") or "Unknown",
        ai_tool=case.get("ai_tool") or "Unknown",
        opinion_text=opinion_text,
    )
    body = {
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "system": SYSTEM,
        "messages": [{"role": "user", "content": user_msg}],
    }

    # Anthropic 429 retry with exponential backoff. Per-minute token limits
    # are the usual culprit on long opinion texts.
    backoffs = [20, 45, 90, 180]
    last_err: Exception | None = None
    for delay in [0] + backoffs:
        if delay:
            time.sleep(delay)
        try:
            _, _, payload = http(
                "POST", ANTHROPIC_URL, body=body, headers=ANTHROPIC_HEADERS, timeout=180
            )
            data = json.loads(payload)
            parts = data.get("content") or []
            text = "".join(b.get("text", "") for b in parts if b.get("type") == "text").strip()
            if text.startswith("```"):
                text = text.strip("`")
                if text.lower().startswith("json"):
                    text = text[4:].strip()
                text = text.rstrip("`").strip()
            # Try strict first
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                # Lenient fallback: grab first { to last }
                first = text.find("{")
                last = text.rfind("}")
                if first >= 0 and last > first:
                    return json.loads(text[first:last + 1])
                # Re-raise with the original text snippet for debugging
                snippet = text[:200].replace("\n", " ")
                raise RuntimeError(
                    f"non-JSON Claude reply: {snippet!r}"
                ) from None
        except RuntimeError as e:
            msg = str(e)
            last_err = e
            if "-> 429:" in msg or "rate_limit_error" in msg or "-> 529:" in msg:
                # rate-limited or overloaded — back off and retry
                continue
            raise
    if last_err:
        raise last_err
    raise RuntimeError("call_claude: exhausted retries with no result")


# ---- write annotation + skill_links -------------------------------------
def write_annotation(case: dict, opinion: dict, ann: dict, dry: bool) -> str | None:
    row = {
        "case_id": case["id"],
        "opinion_id": opinion["id"],
        "version": 1,
        "status": "draft",
        "is_provisional": False,
        "generated_by": "claude",
        "severity": ann["severity"],
        "one_line": ann["one_line"][:300],
        "what_happened": ann["what_happened"],
        "what_went_wrong": ann["what_went_wrong"],
        "outcome_summary": ann["outcome_summary"],
        "monetary_penalty_usd": ann.get("monetary_penalty_usd"),
        "professional_sanction": bool(ann.get("professional_sanction")),
        "rule_1_1_competence": ann.get("rule_1_1_competence"),
        "rule_1_4_communication": ann.get("rule_1_4_communication"),
        "rule_1_6_confidentiality": ann.get("rule_1_6_confidentiality"),
        "rule_3_3_candor": ann.get("rule_3_3_candor"),
        "rule_5_1_supervisory": ann.get("rule_5_1_supervisory"),
        "rule_5_3_nonlawyer": ann.get("rule_5_3_nonlawyer"),
        "rule_8_4_misconduct": ann.get("rule_8_4_misconduct"),
        "insurance_exposure": ann.get("insurance_exposure"),
        "bar_referral_risk": ann.get("bar_referral_risk"),
        "firm_policy_takeaway": ann.get("firm_policy_takeaway"),
        "prevention_notes": ann.get("prevention_notes"),
    }
    if dry:
        return None
    inserted = sb_post("annotations", row)
    if not inserted:
        return None
    aid = inserted[0]["id"]

    skills = ann.get("skill_recommendations") or []
    skill_rows = []
    for i, s in enumerate(skills):
        slug = s.get("skill_slug") or s.get("slug") or ""
        if not slug:
            continue
        skill_rows.append(
            {
                "annotation_id": aid,
                "skill_slug": slug,
                "skill_name": s.get("skill_name") or slug,
                "skill_url": SKILL_SLUG_TO_URL.get(slug, f"/skills/{slug}"),
                "relevance_note": s.get("relevance_note") or "",
                "display_order": i,
            }
        )
    if skill_rows:
        sb_post("skill_links", skill_rows)
    return aid


# ---- driver -------------------------------------------------------------
def main():
    p = argparse.ArgumentParser()
    p.add_argument("--pilot", action="store_true")
    p.add_argument("--all", action="store_true")
    p.add_argument("--limit", type=int, default=None)
    p.add_argument("--sleep", type=float, default=2.0, help="seconds between API calls")
    p.add_argument("--dry", action="store_true", help="don't write to DB; print JSON")
    p.add_argument("--print-json", action="store_true", help="print full JSON for each annotation")
    args = p.parse_args()

    if args.pilot:
        cases = select_pilot()
    else:
        cases = select_all_with_opinion()
        if args.limit:
            cases = cases[: args.limit]

    print(f"annotating {len(cases)} cases (model={MODEL})\n")
    summary = {
        "attempted": 0, "annotated": 0, "errors": [],
        "by_severity": {"low": 0, "moderate": 0, "high": 0, "severe": 0},
    }

    for i, c in enumerate(cases, 1):
        op = longest_opinion(c)
        if not op:
            print(f"  [{i:>3}/{len(cases)}] NO OPINION  ::  {c['case_name'][:80]}")
            continue
        summary["attempted"] += 1
        try:
            ann = call_claude(c, op["opinion_text"])
        except Exception as e:
            msg = f"{c['case_name']}: {e}"
            summary["errors"].append(msg)
            print(f"  [{i:>3}/{len(cases)}] ERR  ::  {msg[:200]}")
            time.sleep(args.sleep)
            continue

        sev = ann.get("severity", "?")
        if sev in summary["by_severity"]:
            summary["by_severity"][sev] += 1

        aid = write_annotation(c, op, ann, dry=args.dry)
        marker = "DRY" if args.dry else f"-> {aid[:8] if aid else '???'}"
        print(
            f"  [{i:>3}/{len(cases)}] {sev:<8} {marker}  ::  "
            f"{c['case_name'][:80]}  |  {ann.get('one_line', '')[:120]}"
        )
        if args.print_json:
            print(json.dumps(ann, indent=2))

        if not args.dry:
            summary["annotated"] += 1
        time.sleep(args.sleep)

    print("\n=== summary ===")
    print(f"  attempted:  {summary['attempted']}")
    print(f"  annotated:  {summary['annotated']}")
    print(f"  by severity: {summary['by_severity']}")
    if summary["errors"]:
        print(f"  errors ({len(summary['errors'])}):")
        for e in summary["errors"][:20]:
            print(f"     ! {e[:300]}")


if __name__ == "__main__":
    main()
