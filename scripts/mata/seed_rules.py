"""
Mata Tracker — Phase 1: seed the rules table with the 8 verified rules.

Idempotent — uses upsert on slug. Re-run safely after editing entries.
After loading, every row goes in as status='draft'. Publish them in
Supabase SQL Editor with:

    update rules
       set status = 'published', reviewed_by = 'blake', reviewed_at = now()
     where slug in ('aba-formal-opinion-512', ...);

Or to publish them all:

    update rules
       set status = 'published', reviewed_by = 'blake', reviewed_at = now()
     where status = 'draft';
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
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
        if not os.environ.get(k):
            os.environ[k] = v

URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
KEY = (os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
       or os.environ.get("SUPABASE_KEY"))
if not (URL and KEY):
    sys.exit("missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env")

REST = f"{URL}/rest/v1"
H = {
    "apikey": KEY,
    "Authorization": f"Bearer {KEY}",
    "Content-Type": "application/json",
}

# ---- the seed -----------------------------------------------------------
RULES = [
    {
        "slug": "aba-formal-opinion-512",
        "title": "ABA Formal Opinion 512",
        "subtitle": "Generative Artificial Intelligence Tools",
        "citation": "ABA Comm. on Ethics & Pro. Resp., Formal Op. 512 (July 29, 2024)",
        "jurisdiction": "aba",
        "jurisdiction_label": "ABA",
        "state": None,
        "court": None,
        "judge": None,
        "type": "aba_opinion",
        "type_label": "ABA Formal Opinion",
        "effective_date": "2024-07-29",
        "source_url": "https://www.americanbar.org/content/dam/aba/administrative/professional_responsibility/ethics-opinions/aba-formal-opinion-512.pdf",
        "source_archive_url": "https://www.americanbar.org/news/abanews/aba-news-archives/2024/07/aba-issues-first-ethics-guidance-ai-tools/",
        "rules_implicated": ["1.1", "1.4", "1.6", "1.5", "3.1", "3.3", "5.1", "5.3", "8.4"],
        "requires_disclosure": False,
        "requires_verification": True,
        "summary": (
            "The first comprehensive ABA guidance on lawyers' use of generative AI tools. "
            "Establishes that competence (Rule 1.1) requires reasonable understanding of any "
            "AI tool a lawyer uses, including the risk of hallucinated output. Confidentiality "
            "(1.6) requires informed client consent before inputting client information into a "
            "self-learning AI tool. Communication (1.4) may require disclosing AI use depending "
            "on the matter. Supervisory rules (5.1, 5.3) extend to AI tools used by associates "
            "and staff."
        ),
        "takeaways": [
            "Verify every AI-generated citation against a primary source before filing.",
            "Get informed client consent before entering client confidential information into a self-learning AI tool.",
            "Disclose AI use to the client when material to the representation, the fee, or the engagement.",
            "Establish written firm policies on AI use that meet supervisory obligations.",
        ],
        "penalties": (
            "No direct penalty — Formal Opinions are advisory. State bars adopting these "
            "standards may impose Rule 8.4 misconduct charges for material violations."
        ),
        "practitioner_take": (
            "This is the document every practitioner should keep one click away. Most state "
            "bars are now citing it. Treat it as the floor, not the ceiling — your jurisdiction "
            "may go further."
        ),
    },
    {
        "slug": "florida-bar-24-1",
        "title": "Florida Bar Ethics Opinion 24-1",
        "subtitle": "Lawyers' Use of Generative AI",
        "citation": "Fla. Bar Comm. on Pro. Ethics, Op. 24-1 (Jan. 19, 2024)",
        "jurisdiction": "state",
        "jurisdiction_label": "Florida",
        "state": "FL",
        "court": None,
        "judge": None,
        "type": "ethics_opinion",
        "type_label": "State Bar Ethics Opinion",
        "effective_date": "2024-01-19",
        "source_url": "https://www.floridabar.org/etopinions/opinion-24-1/",
        "source_archive_url": None,
        "rules_implicated": ["1.1", "1.4", "1.5", "1.6", "5.3"],
        "requires_disclosure": True,
        "requires_verification": True,
        "summary": (
            "One of the first state bar opinions to address generative AI in detail. Permits "
            "lawyers to use AI but requires informed client consent for confidential information, "
            "prohibits charging clients for time saved by AI without disclosure, and requires the "
            "lawyer to verify any AI-generated work product before using it."
        ),
        "takeaways": [
            "You may use AI but you must verify the output.",
            "Bill clients for the actual time spent (including verification), not the time the AI saved you.",
            "Inform clients in writing if you intend to enter their confidential information into a generative AI tool.",
            "Treat AI like a non-lawyer assistant under Rule 4-5.3 — you supervise it, you sign for it.",
        ],
        "penalties": (
            "Standard Florida Bar disciplinary process for Rule violations. Sanctions range from "
            "admonishment to disbarment depending on severity."
        ),
        "practitioner_take": (
            "If you practice in Florida or have Florida-barred attorneys at your firm, this is "
            "binding. The verification requirement is the operational center of gravity — build "
            "it into your workflow, not your aspirations."
        ),
    },
    {
        "slug": "california-state-bar-genai-guidance",
        "title": "Practical Guidance for the Use of Generative AI in the Practice of Law",
        "subtitle": "California State Bar — Standing Committee on Professional Responsibility",
        "citation": "Cal. State Bar, COPRAC, Practical Guidance (Nov. 16, 2023)",
        "jurisdiction": "state",
        "jurisdiction_label": "California",
        "state": "CA",
        "court": None,
        "judge": None,
        "type": "ethics_opinion",
        "type_label": "State Bar Practical Guidance",
        "effective_date": "2023-11-16",
        "source_url": "https://www.calbar.ca.gov/Portals/0/documents/ethics/Generative-AI-Practical-Guidance.pdf",
        "source_archive_url": None,
        "rules_implicated": ["1.1", "1.5", "1.6", "3.3", "5.1", "5.3", "5.4", "8.4.1"],
        "requires_disclosure": False,
        "requires_verification": True,
        "summary": (
            "Practical, non-binding guidance issued before any state bar opinion. Frames "
            "competence under Rule 1.1 as requiring reasonable understanding of the AI tool, "
            "output verification, and protection against confidentiality breaches. Specifically "
            "addresses anti-discrimination concerns under Rule 8.4.1 — biased AI output that "
            "disadvantages a class of people may be misconduct."
        ),
        "takeaways": [
            "Understand the tool before you use it — what data it was trained on, where prompts go, what it can and cannot do.",
            "Verify all AI-generated output against authoritative sources.",
            "Audit AI tools for bias against protected classes; biased output you fail to correct may be Rule 8.4.1 misconduct.",
            "Don't bill clients for AI usage as if it were attorney time.",
        ],
        "penalties": (
            "Advisory — not directly enforceable. California State Bar disciplinary actions may "
            "cite this as the standard of care."
        ),
        "practitioner_take": (
            "Less prescriptive than Florida 24-1 but broader in scope. The bias / 8.4.1 angle is "
            "unique among state guidance and worth flagging for any AI tool used in employment, "
            "criminal defense, or housing matters."
        ),
    },
    {
        "slug": "nysba-task-force-report-ai",
        "title": "NYSBA Report and Recommendations of the Task Force on Artificial Intelligence",
        "subtitle": "New York State Bar Association",
        "citation": "NYSBA Task Force on AI, Report and Recommendations (Apr. 6, 2024)",
        "jurisdiction": "state",
        "jurisdiction_label": "New York",
        "state": "NY",
        "court": None,
        "judge": None,
        "type": "task_force_report",
        "type_label": "State Bar Task Force Report",
        "effective_date": "2024-04-06",
        "source_url": "https://nysba.org/wp-content/uploads/2022/03/2024-April-Report-and-Recommendations-of-the-Task-Force-on-Artificial-Intelligence.pdf",
        "source_archive_url": None,
        "rules_implicated": ["1.1", "1.6", "5.1", "5.3", "8.4"],
        "requires_disclosure": False,
        "requires_verification": True,
        "summary": (
            "A 92-page comprehensive report covering AI fundamentals, ethics, regulatory "
            "landscape, and recommendations for the New York legal profession. Less a binding "
            "rule and more a framework — but heavily cited by NY courts and bar discipline "
            "panels. Includes specific recommendations for CLE on AI competence and proposed "
            "amendments to NY Rules of Professional Conduct."
        ),
        "takeaways": [
            "Treat AI competence as a CLE requirement, not just a personal-development hobby.",
            "Document your firm's AI policy in writing — the report frames this as central to Rule 5.1 compliance.",
            "Vet third-party AI vendors for confidentiality and data-handling practices before adoption.",
            "Stay current on the regulatory landscape; the task force expects rule changes within 24 months.",
        ],
        "penalties": "Advisory. NY Departmental Disciplinary Committees may cite the report's standards.",
        "practitioner_take": (
            "The most thorough state-bar treatment of AI in legal practice to date. Worth a full "
            "read for managing partners and risk officers, even if you're not in NY."
        ),
    },
    {
        "slug": "dc-bar-388",
        "title": "DC Bar Ethics Opinion 388",
        "subtitle": "Attorneys' Use of Generative Artificial Intelligence in Client Matters",
        "citation": "D.C. Bar Legal Ethics Comm., Op. 388 (Apr. 2024)",
        "jurisdiction": "state",
        "jurisdiction_label": "District of Columbia",
        "state": "DC",
        "court": None,
        "judge": None,
        "type": "ethics_opinion",
        "type_label": "State Bar Ethics Opinion",
        "effective_date": "2024-04-01",
        "source_url": "https://www.dcbar.org/for-lawyers/legal-ethics/ethics-opinions-210-present/ethics-opinion-388",
        "source_archive_url": None,
        "rules_implicated": ["1.1", "1.3", "1.5", "1.6", "5.1", "5.3"],
        "requires_disclosure": False,
        "requires_verification": True,
        "summary": (
            "DC's comprehensive opinion on generative AI. Allows broad use but requires "
            "understanding of tools used, protection of client confidences, supervision of AI "
            "as a non-lawyer assistant, and reasonable fees that account for AI efficiency gains."
        ),
        "takeaways": [
            "AI tools are non-lawyer assistants under Rule 5.3 — you are responsible for their work product.",
            "You may not pass through the cost of an AI subscription as if it were attorney time.",
            "Confidential information may be entered into AI tools only with informed client consent OR if the tool meets confidentiality requirements (i.e., closed/private deployment).",
            "Diligence (Rule 1.3) requires staying current on AI capabilities relevant to your practice.",
        ],
        "penalties": "Advisory. DC Office of Disciplinary Counsel may cite this opinion in disciplinary proceedings.",
        "practitioner_take": (
            "Tracks closely with ABA 512 and Florida 24-1, but adds an explicit closed-deployment "
            "carve-out for confidentiality. Useful if your firm has rolled out an enterprise AI "
            "tool with a no-training agreement."
        ),
    },
    {
        "slug": "judge-starr-ndtx-standing-order",
        "title": "Mandatory Certification Regarding Generative Artificial Intelligence",
        "subtitle": "Standing Order — U.S. District Judge Brantley Starr (N.D. Tex.)",
        "citation": "N.D. Tex., J. Starr, Standing Order (May 30, 2023)",
        "jurisdiction": "federal",
        "jurisdiction_label": "N.D. Tex. — J. Starr",
        "state": None,
        "court": "N.D. Tex.",
        "judge": "Hon. Brantley Starr",
        "type": "standing_order",
        "type_label": "Federal Standing Order",
        "effective_date": "2023-05-30",
        "source_url": "https://reason.com/volokh/2023/05/30/federal-judge-requires-all-lawyers-to-file-certificates-related-to-use-of-generative-ai/",
        "source_archive_url": "https://www.txnd.uscourts.gov/judge/judge-brantley-starr",
        "rules_implicated": ["11", "3.3"],
        "requires_disclosure": True,
        "requires_verification": True,
        "summary": (
            "The first published federal standing order requiring AI disclosure. Issued the same "
            "week the Mata v. Avianca sanctions hit the news. Requires every attorney appearing "
            "before Judge Starr to file a certification that either (a) no portion of any filing "
            "was drafted by generative AI, OR (b) any AI-drafted portion was reviewed for "
            "accuracy by a human using print reporters or traditional databases."
        ),
        "takeaways": [
            "You must file a separate certification per case before any filing.",
            "You may use AI — but you must affirm a human verified every assertion.",
            "Failure to comply may result in striking the filing and sanctions.",
            "This template has been adopted (with variations) by ~30 other federal judges.",
        ],
        "penalties": "Filing strikes, monetary sanctions, Rule 11 referrals.",
        "practitioner_take": (
            "If you have a matter in N.D. Tex., this certification is non-negotiable. The broader "
            "value of this order is as a template — practitioners can use the certification "
            "language as their own internal AI verification gate."
        ),
    },
    {
        "slug": "judge-vaden-uscit-order",
        "title": "Order on Artificial Intelligence",
        "subtitle": "Standing Order — Judge Stephen A. Vaden (USCIT)",
        "citation": "USCIT, J. Vaden, Order on Artificial Intelligence (June 8, 2023)",
        "jurisdiction": "federal",
        "jurisdiction_label": "USCIT — J. Vaden",
        "state": None,
        "court": "USCIT",
        "judge": "Hon. Stephen A. Vaden",
        "type": "standing_order",
        "type_label": "Federal Standing Order",
        "effective_date": "2023-06-08",
        "source_url": "https://www.cit.uscourts.gov/sites/cit/files/Order%20on%20Artificial%20Intelligence.pdf",
        "source_archive_url": None,
        "rules_implicated": ["11"],
        "requires_disclosure": True,
        "requires_verification": True,
        "summary": (
            "A more demanding variant of the Starr template, issued by Judge Vaden of the U.S. "
            "Court of International Trade. Requires not only certification of AI use but also "
            "disclosure of which AI program was used, the specific portions generated, and an "
            "attestation that all generated text was reviewed for accuracy. Adds explicit concern "
            "about inadvertent disclosure of confidential or business-proprietary information "
            "through AI prompts."
        ),
        "takeaways": [
            'Disclose the specific AI tool by name (e.g., "ChatGPT", "Claude").',
            "Identify which sections of the filing were AI-drafted.",
            "Attest that every generated assertion was independently verified.",
            "Apply this even to non-substantive sections like procedural histories or fact summaries.",
        ],
        "penalties": "Striking of filings, Rule 11 sanctions, contempt referrals.",
        "practitioner_take": (
            "The USCIT has a small, specialized bar, but the Vaden order is one of the strictest "
            "disclosure regimes published. Useful as a worst-case template for what your firm's "
            "internal AI-use log should capture."
        ),
    },
    {
        "slug": "5th-cir-proposed-rule-32-3",
        "title": "Proposed Local Rule 32.3 — Certification Regarding Use of Generative AI",
        "subtitle": "United States Court of Appeals for the Fifth Circuit",
        "citation": "5th Cir., Proposed Local Rule 32.3 (Nov. 21, 2023; not adopted June 2024)",
        "jurisdiction": "federal",
        "jurisdiction_label": "5th Cir.",
        "state": None,
        "court": "5th Cir.",
        "judge": None,
        "type": "proposed_rule",
        "type_label": "Proposed Federal Rule (Not Adopted)",
        "effective_date": "2023-11-21",
        "source_url": "https://www.ca5.uscourts.gov/docs/default-source/default-document-library/public-comment-local-rule-32-3-and-form-6.pdf?sfvrsn=fe96c92d_0",
        "source_archive_url": None,
        "rules_implicated": ["11"],
        "requires_disclosure": True,
        "requires_verification": True,
        "summary": (
            "The 5th Circuit proposed a court-wide AI disclosure rule that would have required "
            "every brief filed in the circuit to certify whether AI was used and, if so, that "
            "all AI-generated assertions were verified. After the public comment period, the "
            "court announced in June 2024 that it would not adopt the rule. The proposed text "
            "remains influential as a reference for individual judges adopting their own "
            "standing orders."
        ),
        "takeaways": [
            "A circuit-wide rule would have unified disclosure requirements across all 5th Cir. judges.",
            "The decision not to adopt does not mean the issue is settled — multiple individual 5th Cir. judges have since adopted Starr-style standing orders.",
            "Watch the Federal Rules Advisory Committee — a national rule is in active discussion.",
        ],
        "penalties": "N/A — never adopted.",
        "practitioner_take": (
            "Keep this on your radar. The non-adoption doesn't mean the issue is dead; it likely "
            "means the FRAP committee will take it up. A national rule, when it comes, will "
            "probably look more like Starr or Vaden than this proposed text."
        ),
    },
]

# ---- upsert -------------------------------------------------------------
def main():
    print(f"loading {len(RULES)} rules...")
    headers = {**H, "Prefer": "resolution=merge-duplicates,return=representation"}
    body = json.dumps(RULES).encode("utf-8")
    req = urllib.request.Request(
        f"{REST}/rules?on_conflict=slug",
        data=body, headers=headers, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            payload = r.read()
            inserted = json.loads(payload) if payload else []
            print(f"OK status={r.status}, rows={len(inserted)}")
            for row in inserted:
                print(f"  · [{row.get('status', '?'):>9}] {row.get('slug')}")
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:600]}")
        sys.exit(1)

    # quick verification count
    for url_path, label in [
        ("/rules?select=id", "total rules"),
        ("/rules?select=id&status=eq.draft", "drafts"),
        ("/rules?select=id&status=eq.published", "published"),
    ]:
        head_req = urllib.request.Request(
            f"{REST}{url_path}",
            headers={**H, "Range": "0-0", "Prefer": "count=exact"},
            method="HEAD",
        )
        with urllib.request.urlopen(head_req, timeout=30) as r:
            cr = r.headers.get("content-range") or ""
            count = int(cr.rsplit("/", 1)[1]) if "/" in cr else 0
            print(f"  {label:>14}: {count}")


if __name__ == "__main__":
    main()
