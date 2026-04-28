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
    # ----- expansion: 12 additional verified rules / orders -----
    {
        "slug": "pennsylvania-joint-formal-op-2024-200",
        "title": "Joint Formal Opinion 2024-200",
        "subtitle": "Ethical Issues Regarding the Use of Artificial Intelligence",
        "citation": "Pa. Bar Ass'n Comm. on Legal Ethics & Phila. Bar Ass'n Pro. Guidance Comm., Joint Formal Op. 2024-200 (June 2024)",
        "jurisdiction": "state",
        "jurisdiction_label": "Pennsylvania",
        "state": "PA",
        "court": None, "judge": None,
        "type": "ethics_opinion",
        "type_label": "State Bar Joint Formal Opinion",
        "effective_date": "2024-06-01",
        "source_url": "https://www.pabar.org/Members/catalogs/Ethics%20Opinions/Formal/Joint%20Formal%20Opinion%202024-200.pdf",
        "source_archive_url": "https://www.lawnext.com/wp-content/uploads/2024/06/Joint-Formal-Opinion-2024-200.pdf",
        "rules_implicated": ["1.1", "1.4", "1.5", "1.6", "3.3", "5.1", "5.3", "8.4"],
        "requires_disclosure": True, "requires_verification": True,
        "summary": "A joint opinion from the Pennsylvania Bar Association and the Philadelphia Bar Association — among the most thorough state opinions issued. Frames AI competence as an extension of existing technology-competence obligations under Rule 1.1, requires verification of citations and substantive content, prohibits inputting confidential client information into tools without adequate confidentiality protections, and recommends transparency with clients and courts about AI use.",
        "takeaways": [
            "Understand the technology — what it does, how it works, what it does not do.",
            "Verify all citations and substantive AI output before relying on it.",
            "Get informed client consent before entering confidential information into AI tools that lack adequate protections.",
            "Be transparent about AI use with clients, opposing counsel, and the court when material.",
        ],
        "penalties": "Standard PA disciplinary process; Office of Disciplinary Counsel may pursue Rule violations under usual procedures.",
        "practitioner_take": "If you have a Pennsylvania practice, this is the most prescriptive guidance currently in force. Pair it with ABA 512 — the two together give you defensible policy language for most firm scenarios.",
    },
    {
        "slug": "new-jersey-preliminary-ai-guidelines",
        "title": "Preliminary Guidelines on the Use of Artificial Intelligence by Lawyers",
        "subtitle": "New Jersey Supreme Court — Notice to the Bar",
        "citation": "N.J. Sup. Ct., Notice to the Bar, Preliminary Guidelines on Use of AI (Jan. 25, 2024)",
        "jurisdiction": "state",
        "jurisdiction_label": "New Jersey",
        "state": "NJ",
        "court": None, "judge": None,
        "type": "court_rule",
        "type_label": "State Supreme Court Notice",
        "effective_date": "2024-01-25",
        "source_url": "https://www.njcourts.gov/sites/default/files/notices/2024/01/n240125a.pdf",
        "source_archive_url": "https://www.njcourts.gov/attorneys/artificial-intelligence-use-courts",
        "rules_implicated": ["1.1", "1.6", "3.3", "5.3", "8.4"],
        "requires_disclosure": False, "requires_verification": True,
        "summary": "New Jersey took an unusual approach: rather than issue a separate ethics opinion, the Supreme Court issued an immediate-effect Notice to the Bar applying existing Rules of Professional Conduct to AI. The guidelines do not create new obligations but make explicit that lawyers must verify AI output, remain responsible for submissions, and may not use AI to manipulate or fabricate evidence.",
        "takeaways": [
            "Existing RPCs already cover AI — no carve-outs, no new safe harbors.",
            "Verify all AI-generated content before relying on it for any submission.",
            "You remain fully responsible for the validity of pleadings, arguments, and evidence regardless of AI use.",
            "Using AI to manipulate or fabricate evidence is per se misconduct, and you may not allow a client to do so either.",
        ],
        "penalties": "Standard NJ disciplinary process; the Notice creates no new sanctions but reinforces existing RPC enforcement.",
        "practitioner_take": "The 'guidelines don't create new obligations' framing is a feature, not a bug — it puts every existing RPC violation by AI misuse on the table without waiting for new rules. Read it once and treat your existing risk policies as already covering the AI surface.",
    },
    {
        "slug": "virginia-leo-1901",
        "title": "Legal Ethics Opinion 1901 — Reasonable Fees and the Use of Generative AI",
        "subtitle": "Virginia State Bar Standing Committee on Legal Ethics",
        "citation": "Va. State Bar Standing Comm. on Legal Ethics, LEO 1901 (approved Nov. 24, 2025)",
        "jurisdiction": "state",
        "jurisdiction_label": "Virginia",
        "state": "VA",
        "court": None, "judge": None,
        "type": "ethics_opinion",
        "type_label": "State Bar Legal Ethics Opinion",
        "effective_date": "2025-11-24",
        "source_url": "https://www.vacourts.gov/static/courts/scv/amendments/leo_1901.pdf",
        "source_archive_url": "https://vsb.org/Site/Site/news/rules-news/20250327-prop-1901-fees-ai.aspx",
        "rules_implicated": ["1.5"],
        "requires_disclosure": False, "requires_verification": False,
        "summary": "Virginia's narrow but practically important opinion focuses on Rule 1.5 reasonableness when AI saves a lawyer time. Concludes that AI-driven productivity gains should not automatically reduce fees — value, skill, and experience remain valid factors. But if AI makes a task dramatically faster, the lawyer should give the client meaningful context to justify the fee.",
        "takeaways": [
            "Time spent is one factor of fee reasonableness — not the only factor.",
            "If AI dramatically increases your efficiency, give the client context about why your skill, expertise, or other efficiencies still justify the fee.",
            "Don't bill clients for hours not actually worked just because the AI got the result faster.",
            "Reasonable AI subscription / usage costs may be passed through with prior client agreement.",
        ],
        "penalties": "Advisory; VA Disciplinary Board may cite the opinion's standard in fee-related complaints.",
        "practitioner_take": "Most practitioners are looking at this question wrong. The right answer isn't 'I won't bill for AI time' — it's 'AI saves the client money on the task, but my judgment, vetting, and integration time still cost what they cost.' This opinion validates that frame.",
    },
    {
        "slug": "michigan-ji-155",
        "title": "Ethics Opinion JI-155 — Judges' and Lawyers' Use of Artificial Intelligence",
        "subtitle": "State Bar of Michigan Standing Committee on Judicial Ethics",
        "citation": "State Bar of Mich. Standing Comm. on Judicial Ethics, JI-155 (Oct. 2023)",
        "jurisdiction": "state",
        "jurisdiction_label": "Michigan",
        "state": "MI",
        "court": None, "judge": None,
        "type": "ethics_opinion",
        "type_label": "State Bar Judicial Ethics Opinion",
        "effective_date": "2023-10-01",
        "source_url": "https://www.michbar.org/opinions/ethics/numbered_opinions/JI-155",
        "source_archive_url": None,
        "rules_implicated": ["1.1", "5.3", "8.4"],
        "requires_disclosure": False, "requires_verification": True,
        "summary": "An early state opinion focused primarily on judicial ethics but with broader implications. Holds that judicial officers — and by extension lawyers — must maintain technological competence in AI as in any other tool. Defines AI broadly to cover modern multi-component systems, not just generative chatbots. Addresses bias, hallucination, and supervision themes that later state opinions adopted.",
        "takeaways": [
            "Technological competence under Rule 1.1 explicitly includes AI proficiency.",
            "AI is not one tool; it is many. Different categories carry different risks.",
            "Bias in AI output can implicate Rule 8.4 misconduct if a lawyer fails to address it.",
            "Treat AI like any other delegated work — supervise it under Rule 5.3 standards.",
        ],
        "penalties": "Advisory. Michigan Attorney Discipline Board may cite the opinion's competence standard.",
        "practitioner_take": "One of the earliest state-level treatments. The judicial-ethics framing makes it especially useful for understanding how courts will view lawyers' AI use — judges think about competence and bias before they think about disclosure.",
    },
    {
        "slug": "north-carolina-2024-feo-1",
        "title": "2024 Formal Ethics Opinion 1 — Use of Artificial Intelligence in a Law Practice",
        "subtitle": "North Carolina State Bar — Ethics Committee",
        "citation": "N.C. State Bar Ethics Comm., 2024 Formal Ethics Op. 1 (Nov. 1, 2024)",
        "jurisdiction": "state",
        "jurisdiction_label": "North Carolina",
        "state": "NC",
        "court": None, "judge": None,
        "type": "ethics_opinion",
        "type_label": "State Bar Formal Ethics Opinion",
        "effective_date": "2024-11-01",
        "source_url": "https://www.ncbar.gov/for-lawyers/ethics/adopted-opinions/2024-formal-ethics-opinion-1/",
        "source_archive_url": None,
        "rules_implicated": ["1.1", "1.6", "3.3", "4.1", "5.1", "5.3"],
        "requires_disclosure": False, "requires_verification": True,
        "summary": "NC adopts the now-standard framework: AI is permitted, but the lawyer remains responsible. Specifically: third-party AI tools may be used if the lawyer is satisfied they are sufficiently secure under Rule 1.6(c); citations and AI-generated content must be rigorously verified before any court submission; clients should be informed when their confidential information may be processed by AI; informed consent may be required.",
        "takeaways": [
            "You may not abrogate your RPC duties by relying on AI — accuracy, candor, and confidentiality remain yours.",
            "Vet third-party AI tools for security under Rule 1.6(c) before allowing client information to flow through them.",
            "Submitting AI-generated work to a court without rigorous review violates Rule 3.3 and Rule 4.1.",
            "Tell clients when their confidential information may be processed by AI; some matters will require informed consent.",
        ],
        "penalties": "Standard NC disciplinary process for RPC violations.",
        "practitioner_take": "Tracks ABA 512 closely with NC-specific framing. The 4.1 (truthfulness in statements to others) hook is worth noting — it's an underused hook for AI-misuse claims that don't quite reach Rule 3.3.",
    },
    {
        "slug": "texas-opinion-705",
        "title": "Texas Ethics Opinion 705",
        "subtitle": "Ethical Issues Raised by Use of Generative Artificial Intelligence",
        "citation": "Tex. Pro. Ethics Comm., Op. 705 (Feb. 2025)",
        "jurisdiction": "state",
        "jurisdiction_label": "Texas",
        "state": "TX",
        "court": None, "judge": None,
        "type": "ethics_opinion",
        "type_label": "State Bar Ethics Opinion",
        "effective_date": "2025-02-01",
        "source_url": "https://www.legalethicstexas.com/resources/opinions/opinion-705/",
        "source_archive_url": None,
        "rules_implicated": ["1.01", "1.05", "3.03", "5.03"],
        "requires_disclosure": False, "requires_verification": True,
        "summary": "Texas's framework opinion. Anchors AI obligations in four pillars: competence (Rule 1.01) requires understanding how AI works; confidentiality (Rule 1.05) limits inputs; verification (Rule 3.03 candor) requires independent check of output before filing; reasonable billing means time actually spent, not time AI saved — though pass-through of subscription fees with client agreement is allowed.",
        "takeaways": [
            "Competence requires understanding the AI tool — its training, limits, where prompts go.",
            "Don't put confidential client information into tools that don't have adequate confidentiality protections.",
            "Verify everything the AI says before relying on it in client work or court filings.",
            "Bill the time you actually spent. AI subscription costs may be passed through with prior client agreement.",
        ],
        "penalties": "State Bar of Texas disciplinary procedures; sanctions per Texas Rules of Disciplinary Procedure.",
        "practitioner_take": "Very practical. The four-pillar framing is easy to map onto firm policy. Don't be confused by the rule numbering — Texas uses 1.01 / 1.05 / 3.03 / 5.03 instead of the ABA's 1.1 / 1.6 / 3.3 / 5.3, but the substance is the same.",
    },
    {
        "slug": "illinois-supreme-court-ai-policy",
        "title": "Illinois Supreme Court Policy on Artificial Intelligence",
        "subtitle": "Illinois Judicial Conference — Effective January 1, 2025",
        "citation": "Ill. Sup. Ct., Policy on Artificial Intelligence (eff. Jan. 1, 2025)",
        "jurisdiction": "state",
        "jurisdiction_label": "Illinois",
        "state": "IL",
        "court": None, "judge": None,
        "type": "court_rule",
        "type_label": "State Supreme Court Policy",
        "effective_date": "2025-01-01",
        "source_url": "https://ilcourtsaudio.blob.core.windows.net/antilles-resources/resources/e43964ab-8874-4b7a-be4e-63af019cb6f7/Illinois%20Supreme%20Court%20AI%20Policy.pdf",
        "source_archive_url": "https://www.illinoiscourts.gov/News/1485/Illinois-Supreme-Court-Announces-Policy-on-Artificial-Intelligence/news-detail/",
        "rules_implicated": ["1.1", "1.6", "3.3", "8.4"],
        "requires_disclosure": False, "requires_verification": True,
        "summary": "A notably permissive court-system policy. Authorizes AI use by lawyers, judges, clerks, and self-represented litigants, expressly says disclosure of AI use should NOT be required in pleadings, but reaffirms that all existing rules of professional conduct and judicial ethics apply fully. Lawyers face sanctions for unfounded pleadings whether or not AI helped produce them.",
        "takeaways": [
            "Illinois has affirmatively decided NOT to require disclosure of AI use — running counter to several federal judges' standing orders.",
            "Existing rules apply fully; novelty is no shield.",
            "You may be sanctioned for legally or factually unfounded pleadings even if you blame AI.",
            "Confidentiality and judicial accuracy obligations remain unchanged.",
        ],
        "penalties": "Sanctions under existing Rules of Professional Conduct and Code of Civil Procedure for unfounded pleadings.",
        "practitioner_take": "If you practice in Illinois state courts, this is the cleanest 'use AI freely, just don't get it wrong' regime in the country. But note federal judges sitting in Illinois may still impose their own disclosure orders.",
    },
    {
        "slug": "massachusetts-sjc-interim-ai-guidelines",
        "title": "Interim Guidelines for Use of Generative Artificial Intelligence",
        "subtitle": "Massachusetts Supreme Judicial Court",
        "citation": "Mass. Sup. Jud. Ct., Interim Guidelines on Generative AI (2024)",
        "jurisdiction": "state",
        "jurisdiction_label": "Massachusetts",
        "state": "MA",
        "court": None, "judge": None,
        "type": "court_rule",
        "type_label": "State Supreme Court Interim Guidelines",
        "effective_date": "2024-09-01",
        "source_url": "https://www.mass.gov/guidance/interim-guidelines-for-use-of-generative-ai",
        "source_archive_url": None,
        "rules_implicated": ["1.1", "1.6", "3.3", "8.4"],
        "requires_disclosure": False, "requires_verification": True,
        "summary": "Massachusetts took a court-administration angle: the SJC issued interim guidelines binding on judges, court employees, clerks, and law clerks. While directly aimed at court personnel, the guidelines extend to lawyers practically — any document filed must be thoroughly reviewed for accuracy, and lawyers cannot blame AI errors on the technology. Followed in early 2024 by a Superior Court ruling sanctioning a Massachusetts lawyer $2,000 for filing fictitious AI-generated case citations.",
        "takeaways": [
            "Court personnel may use AI only in limited circumstances — a stricter line than for lawyers.",
            "Any document you file must be thoroughly reviewed; you can't blame errors on the AI.",
            "MA courts have already begun sanctioning lawyers ($2,000 in one Superior Court matter) for AI-fabricated citations.",
            "Treat the guidelines as a floor for your firm's own AI policy.",
        ],
        "penalties": "Court personnel face administrative discipline. Lawyers face Rule 11 sanctions and disciplinary referral.",
        "practitioner_take": "The MA approach previews where many states will likely land — administrative restrictions on court use of AI plus sanctioning enforcement against lawyers. The 2024 Superior Court sanction makes clear MA judges will use this framework actively.",
    },
    {
        "slug": "ny-ucs-ai-policy",
        "title": "Interim Policy on the Use of Artificial Intelligence",
        "subtitle": "New York State Unified Court System",
        "citation": "N.Y. Unified Ct. Sys., Interim Policy on Artificial Intelligence (effective Oct. 2025)",
        "jurisdiction": "state",
        "jurisdiction_label": "New York",
        "state": "NY",
        "court": None, "judge": None,
        "type": "court_rule",
        "type_label": "State Court System Interim Policy",
        "effective_date": "2025-10-10",
        "source_url": "https://www.nycourts.gov/LegacyPDFS/a.i.-policy.pdf",
        "source_archive_url": "https://www.nycourts.gov/LegacyPDFS/press/pdfs/PR25_23.pdf",
        "rules_implicated": ["1.1", "1.6", "3.3"],
        "requires_disclosure": False, "requires_verification": True,
        "summary": "New York's first official court-system AI policy, released October 10, 2025. Applies to UCS judges, clerks, and non-judicial personnel — not directly to attorneys. But every NY-court-practicing attorney should know it because individual NY judges are increasingly imposing their own disclosure requirements through part rules. NYC Bar Formal Op. 2024-5 separately addressed attorney obligations.",
        "takeaways": [
            "The UCS policy binds court personnel — not attorneys directly — but signals where the system is headed.",
            "Individual NY judges' part rules now sometimes require attorney AI disclosure on a case-by-case basis.",
            "No statewide attorney disclosure mandate exists today; NYC Bar Op. 2024-5 confirms no blanket disclosure obligation.",
            "Watch pending Senate bill S2698, which would impose mandatory attorney disclosure if enacted.",
        ],
        "penalties": "Court personnel face administrative discipline. Attorneys face individual judges' enforcement under their part rules.",
        "practitioner_take": "If you practice across multiple NY judges, build an AI-use log and a per-judge disclosure cheat sheet. The fragmented landscape means uniform compliance is impossible without tooling.",
    },
    {
        "slug": "judge-baylson-edpa-standing-order",
        "title": "Standing Order — In re: Artificial Intelligence in Cases Assigned to Judge Baylson",
        "subtitle": "Standing Order — Senior Judge Michael M. Baylson (E.D. Pa.)",
        "citation": "E.D. Pa., J. Baylson, Standing Order Re: AI (June 6, 2023)",
        "jurisdiction": "federal",
        "jurisdiction_label": "E.D. Pa. — J. Baylson",
        "state": None,
        "court": "E.D. Pa.",
        "judge": "Hon. Michael M. Baylson",
        "type": "standing_order",
        "type_label": "Federal Standing Order",
        "effective_date": "2023-06-06",
        "source_url": "https://www.paed.uscourts.gov/sites/paed/files/documents/procedures/Standing%20Order%20Re%20Artificial%20Intelligence%206.6.pdf",
        "source_archive_url": "https://www.paed.uscourts.gov/rules-orders/standing-order-re-artificial-intelligence-ai-cases-assigned-judge-baylson",
        "rules_implicated": ["11", "3.3"],
        "requires_disclosure": True, "requires_verification": True,
        "summary": "One of the earliest follow-on standing orders after Mata and Starr. Notable for its breadth: applies to ANY use of AI — generative or otherwise — not just LLMs. Requires attorneys and pro se litigants to disclose AI use and certify that all citations have been verified for accuracy. Judge Baylson has publicly emphasized the order is not an AI ban — it is a transparency and verification requirement.",
        "takeaways": [
            "The order's breadth is the distinguishing feature: 'AI' covers more than ChatGPT.",
            "If you use any AI tool in preparing a filing for Judge Baylson, you must disclose it.",
            "Citation verification is mandatory and must be certified.",
            "The judge is publicly on record as not banning AI — comply and you can use it.",
        ],
        "penalties": "Striking of filings, Rule 11 sanctions, contempt referrals.",
        "practitioner_take": "Baylson's broad definition of AI is closer to where the rest of the federal bench will eventually land. If you have a matter in EDPA, scope your AI inventory broadly — assistive tools (translation, OCR, predictive coding) may all be in scope.",
    },
    {
        "slug": "judge-boyko-ndoh-standing-order",
        "title": "Court's Standing Order on the Use of Generative AI",
        "subtitle": "Standing Order — Judge Christopher A. Boyko (N.D. Ohio)",
        "citation": "N.D. Ohio, J. Boyko, Standing Order on Use of Generative AI",
        "jurisdiction": "federal",
        "jurisdiction_label": "N.D. Ohio — J. Boyko",
        "state": None,
        "court": "N.D. Ohio",
        "judge": "Hon. Christopher A. Boyko",
        "type": "standing_order",
        "type_label": "Federal Standing Order",
        "effective_date": "2023-08-22",
        "source_url": "https://www.ohnd.uscourts.gov/sites/ohnd/files/Boyko.StandingOrder.GenerativeAI.pdf",
        "source_archive_url": "https://www.ohnd.uscourts.gov/content/judge-christopher-boyko",
        "rules_implicated": ["11", "3.3"],
        "requires_disclosure": True, "requires_verification": True,
        "summary": "A Starr-template standing order applied in N.D. Ohio. Issued under the Court's inherent authority and Rule 11. Requires certification on AI use in any filing, with verification of accuracy. Functions identically to the original Starr order in spirit.",
        "takeaways": [
            "If you appear before Judge Boyko, file an AI-use certificate consistent with the order.",
            "Verify every AI-generated citation against a primary source.",
            "Rule 11 supplies the enforcement teeth.",
            "Treat this as the Starr template applied at a different bench.",
        ],
        "penalties": "Filing strikes, Rule 11 sanctions, contempt.",
        "practitioner_take": "Useful as evidence that the Starr template is propagating. If your firm has a Starr-compliant internal certification, you are likely already Boyko-compliant too.",
    },
    {
        "slug": "judge-newman-sdoh-standing-order",
        "title": "Notice Regarding Use of Artificial Intelligence",
        "subtitle": "Standing Order — Judge Michael J. Newman (S.D. Ohio)",
        "citation": "S.D. Ohio, J. Newman, Notice Regarding Use of AI (Nov. 2023)",
        "jurisdiction": "federal",
        "jurisdiction_label": "S.D. Ohio — J. Newman",
        "state": None,
        "court": "S.D. Ohio",
        "judge": "Hon. Michael J. Newman",
        "type": "standing_order",
        "type_label": "Federal Standing Order",
        "effective_date": "2023-11-01",
        "source_url": "https://www.ohsd.uscourts.gov/FPNewman",
        "source_archive_url": "https://reason.com/volokh/2023/11/16/from-judge-michael-j-newman-s-d-ohio-on-use-of-ai-to-prepare-filings/",
        "rules_implicated": ["11"],
        "requires_disclosure": True, "requires_verification": True,
        "summary": "One of the strictest published federal AI orders. Judge Newman effectively prohibits ANY use of AI in preparing filings, with a narrow carve-out for AI-enhanced legal search engines (Westlaw / Lexis / similar). Violators face economic sanctions, stricken pleadings, contempt, and dismissal.",
        "takeaways": [
            "Functional AI ban — no AI in drafting, except for searches in established legal databases.",
            "If you are unsure whether a tool counts, do not use it.",
            "Penalties include up to dismissal of the entire suit, far heavier than Starr-style certification orders.",
            "If you have a matter in this court, configure your AI tools to be off-limits for that matter.",
        ],
        "penalties": "Economic sanctions, stricken pleadings, contempt, and case dismissal.",
        "practitioner_take": "The most aggressive published federal stance on AI. Practitioners need a per-judge tooling-disable feature in their workflow — there's no defensible reason to forget which judge bans AI use altogether.",
    },
    # ----- round 2 expansion: more federal standing orders + admin orders -----
    {
        "slug": "judge-martinez-olguin-ndcal-standing-order",
        "title": "Civil Standing Order — AI Verification Requirement",
        "subtitle": "Standing Order — Judge Araceli Martínez-Olguín (N.D. Cal.)",
        "citation": "N.D. Cal., J. Martínez-Olguín, Civil Standing Order (rev. Oct. 20, 2025)",
        "jurisdiction": "federal",
        "jurisdiction_label": "N.D. Cal. — J. Martínez-Olguín",
        "state": None,
        "court": "N.D. Cal.",
        "judge": "Hon. Araceli Martínez-Olguín",
        "type": "standing_order",
        "type_label": "Federal Standing Order",
        "effective_date": "2025-10-20",
        "source_url": "https://cand.uscourts.gov/sites/default/files/standing-orders/AMO-CivilStandingOrder-10-20-2025.pdf",
        "source_archive_url": "https://cand.uscourts.gov/judges/amo/martinez-olguin-araceli",
        "rules_implicated": ["11", "3.3"],
        "requires_disclosure": False, "requires_verification": True,
        "summary": "Lead-counsel personal-verification model. Any submission containing AI-generated content must include a certification that lead trial counsel has personally verified the accuracy of that content. Sanctions are explicitly authorized for non-compliance, and the court has applied this rule in a separate matter sanctioning attorney Edward A. Quesada.",
        "takeaways": [
            "Lead counsel — not associates, not staff — must personally verify AI content before submission.",
            "The certification is required only when AI content is in the filing; pure-human filings need no cert.",
            "Sanctions have been imposed under this rule in an actual case, so it has teeth.",
            "Build a 'lead-counsel sign-off' step into your AI workflow before any NDCAL filing.",
        ],
        "penalties": "Sanctions explicitly authorized; the court has applied this rule to sanction non-compliant counsel.",
        "practitioner_take": "The lead-counsel-personal-verification rule is more restrictive than it sounds. If your firm uses AI assistance widely across associates, this rule effectively requires the lead trial counsel to redo the verification — even on routine motions. Build the workflow accordingly.",
    },
    {
        "slug": "judge-padin-njd-standing-order",
        "title": "General Pretrial and Trial Procedures — Generative AI Disclosure",
        "subtitle": "Standing Order — Judge Evelyn Padin (D.N.J.)",
        "citation": "D.N.J., J. Padin, General Pretrial and Trial Procedures (Aug. 2023)",
        "jurisdiction": "federal",
        "jurisdiction_label": "D.N.J. — J. Padin",
        "state": None,
        "court": "D.N.J.",
        "judge": "Hon. Evelyn Padin",
        "type": "standing_order",
        "type_label": "Federal Standing Order",
        "effective_date": "2023-08-23",
        "source_url": "https://www.njd.uscourts.gov/sites/njd/files/EPProcedures.pdf",
        "source_archive_url": None,
        "rules_implicated": ["11", "3.3"],
        "requires_disclosure": True, "requires_verification": True,
        "summary": "A more specific variant of the Starr template, embedded in Judge Padin's general pretrial and trial procedures. Mandates disclosure / certification that (1) identifies which generative AI program was used, (2) identifies the specific portion of the filing drafted by GAI, and (3) certifies that the GAI work product was diligently reviewed for accuracy and applicability by a human being.",
        "takeaways": [
            "Identify the specific AI tool by name (e.g., 'ChatGPT 4o', 'Claude Sonnet 4').",
            "Identify which specific sections were AI-drafted — not just the filing as a whole.",
            "Human verification of accuracy AND applicability is required.",
            "Track this in your matter file so you can produce the cert if challenged.",
        ],
        "penalties": "Strikes, Rule 11 sanctions, contempt referrals.",
        "practitioner_take": "Padin's portion-by-portion specificity is the harder ask compared to Starr's blanket cert. If your firm doesn't already track AI provenance at the section level, you'll need a workflow change — color-coding drafts or maintaining a per-section AI log.",
    },
    {
        "slug": "judge-wang-cod-standing-order",
        "title": "Standing Order Regarding the Use of Generative Artificial Intelligence",
        "subtitle": "Standing Order — Judge Nina Y. Wang (D. Colo.)",
        "citation": "D. Colo., J. Wang, Standing Order Re: Use of Generative AI",
        "jurisdiction": "federal",
        "jurisdiction_label": "D. Colo. — J. Wang",
        "state": None,
        "court": "D. Colo.",
        "judge": "Hon. Nina Y. Wang",
        "type": "standing_order",
        "type_label": "Federal Standing Order",
        "effective_date": "2024-01-01",
        "source_url": "https://www.cod.uscourts.gov/Portals/0/Documents/Judges/NYW/NYW_Standing_Order_Regarding_AI_Certification.pdf",
        "source_archive_url": "http://www.cod.uscourts.gov/Portals/0/Documents/Judges/NYW/NYW_Civil_Practice_Standards.pdf",
        "rules_implicated": ["11"],
        "requires_disclosure": True, "requires_verification": True,
        "summary": "Standard certification model implemented in the District of Colorado. Filers must certify either no AI use OR that any AI-generated content was personally reviewed by a human for accuracy. The order is part of Judge Wang's broader civil practice standards.",
        "takeaways": [
            "File a per-case AI cert before any substantive motion.",
            "Even AI-assisted research that doesn't appear in the final filing should be tracked.",
            "Wang's order is part of broader civil-practice standards — read all of them, not just the AI section.",
            "Colorado has multiple AI-active judges (also Judge Prose); know which one you're in front of.",
        ],
        "penalties": "Standard Rule 11 enforcement; striking of filings.",
        "practitioner_take": "Wang's order is operationally identical to Starr's and Boyko's. If you have a Starr-compliant cert template, it'll work in Colorado.",
    },
    {
        "slug": "judge-prose-cod-standing-order",
        "title": "Standing Order Requiring Certification — Use of AI in Filings",
        "subtitle": "Standing Order — Magistrate Judge Susan Prose (D. Colo.)",
        "citation": "D. Colo., Mag. J. Prose, Standing Order Requiring AI Certification",
        "jurisdiction": "federal",
        "jurisdiction_label": "D. Colo. — Mag. J. Prose",
        "state": None,
        "court": "D. Colo.",
        "judge": "Magistrate Judge Susan Prose",
        "type": "standing_order",
        "type_label": "Federal Magistrate Standing Order",
        "effective_date": "2023-12-01",
        "source_url": "https://www.cod.uscourts.gov/Portals/0/Documents/Judges/SP/SP_Standing_Order_AI_Filings.pdf",
        "source_archive_url": None,
        "rules_implicated": ["11"],
        "requires_disclosure": True, "requires_verification": True,
        "summary": "Targeted certification: applies specifically to motions filed under Rule 12, Rule 56, motions to amend a pleading, and any opposed motion. The certification states either that no AI was used, or that AI-generated language was personally reviewed by a human for accuracy. Notably narrower than the universal-applicability orders.",
        "takeaways": [
            "Only triggered by specific motion types — Rule 12, Rule 56, motions to amend, and opposed motions.",
            "Routine procedural filings without these triggers may not require the cert.",
            "Read carefully before relying on the narrowness — if in doubt, file the cert.",
            "Useful precedent for firms wanting a 'high-stakes-only' internal AI verification standard.",
        ],
        "penalties": "Standard Rule 11 enforcement.",
        "practitioner_take": "Prose's order is interesting because it shows judicial thinking about which filings actually need scrutiny. If your firm wants to right-size AI verification effort, the Prose model is a defensible compromise — verify aggressively for dispositive motions, lighter touch elsewhere.",
    },
    {
        "slug": "edtx-general-order-25-07",
        "title": "General Order 25-07 — Amending Local Rule CV-11(g) for AI Filings",
        "subtitle": "Eastern District of Texas — Chief Judge Mazzant",
        "citation": "E.D. Tex., G.O. 25-07 (Oct. 31, 2025; eff. Dec. 1, 2025)",
        "jurisdiction": "federal",
        "jurisdiction_label": "E.D. Tex. — Court-wide",
        "state": None,
        "court": "E.D. Tex.",
        "judge": None,
        "type": "local_rule",
        "type_label": "Federal District Local Rule",
        "effective_date": "2025-12-01",
        "source_url": "https://txed.uscourts.gov/sites/default/files/goFiles/GO%2025-07%20Amending%20Local%20Rules.pdf",
        "source_archive_url": None,
        "rules_implicated": ["11"],
        "requires_disclosure": False, "requires_verification": True,
        "summary": "A district-wide administrative amendment to Local Rule CV-11(g), expanding the AI verification requirement from pro se litigants to ALL litigants. Issued by Chief Judge Mazzant. Establishes verification — not just disclosure — as the operative obligation: all litigants must review and verify the accuracy and quality of any AI-generated information used in a filing.",
        "takeaways": [
            "Court-wide, not per-judge: this rule applies to every case in E.D. Tex.",
            "Verification is the obligation — disclosure of AI use is not separately required.",
            "Effective December 1, 2025, after a public-comment period.",
            "This is the model most district-wide rules will likely follow: verification as the floor, no per-filing certification.",
        ],
        "penalties": "Standard Rule 11 sanctions and local rule enforcement.",
        "practitioner_take": "Watch this approach — it's likely the template other federal districts will adopt because it's cleaner than per-judge orders. If you have a multi-district practice, build firm policy to the E.D. Tex. standard and you're roughly compliant everywhere.",
    },
    {
        "slug": "judge-kobayashi-hid-standing-order",
        "title": "Disclosure and Certification Requirements — Generative AI",
        "subtitle": "Guidelines — Senior Judge Leslie E. Kobayashi (D. Haw.)",
        "citation": "D. Haw., J. Kobayashi, AI Guidelines (LEK)",
        "jurisdiction": "federal",
        "jurisdiction_label": "D. Haw. — J. Kobayashi",
        "state": None,
        "court": "D. Haw.",
        "judge": "Hon. Leslie E. Kobayashi",
        "type": "standing_order",
        "type_label": "Federal Standing Order",
        "effective_date": "2023-08-01",
        "source_url": "https://www.hid.uscourts.gov/cms/assets/95f11dcf-7411-42d2-9ac2-92b2424519f6/AI%20Guidelines%20LEK.pdf",
        "source_archive_url": "https://www.hid.uscourts.gov/judges/3",
        "rules_implicated": ["11"],
        "requires_disclosure": True, "requires_verification": True,
        "summary": "Rule 11(b)-anchored disclosure and certification regime. Any party using a generative AI tool in preparation of court documents must disclose the use and identify the specific tool used. Tracks the Starr template with a Hawaii-specific Rule 11(b) framing.",
        "takeaways": [
            "Disclose AI use AND identify the specific tool by name in the filing.",
            "Anchored explicitly in Rule 11(b) — non-disclosure invites Rule 11 sanctions.",
            "Standard Starr-template architecture; if you're Starr-compliant, you're Kobayashi-compliant.",
            "Useful for in-house lawyers tracking nationwide AI rules — Hawaii bench is on the train.",
        ],
        "penalties": "Rule 11 sanctions, striking of filings.",
        "practitioner_take": "Hawaii doesn't generate massive litigation volumes for most firms, but Kobayashi's order is part of the proof that the Starr template has gone broadly geographic. Build firm-wide policy as if every federal district will eventually have one.",
    },
    {
        "slug": "judge-palk-okwd-standing-order",
        "title": "Standing Order on Use of Generative AI in Filings",
        "subtitle": "Standing Order — Judge Scott L. Palk (W.D. Okla.)",
        "citation": "W.D. Okla., J. Palk, Standing Order on Generative AI",
        "jurisdiction": "federal",
        "jurisdiction_label": "W.D. Okla. — J. Palk",
        "state": None,
        "court": "W.D. Okla.",
        "judge": "Hon. Scott L. Palk",
        "type": "standing_order",
        "type_label": "Federal Standing Order",
        "effective_date": "2023-08-15",
        "source_url": "https://www.okwd.uscourts.gov/judge-scott-l-palk",
        "source_archive_url": None,
        "rules_implicated": ["11"],
        "requires_disclosure": True, "requires_verification": True,
        "summary": "Disclosure-and-certification model: any party using generative AI to draft or prepare a court filing must (1) disclose that GAI was used, (2) identify the specific tool, and (3) certify that the filer has checked the accuracy of any AI-drafted portion, including all citations and legal authority. Judge Robertson of E.D. Okla. has reportedly adopted a similar order.",
        "takeaways": [
            "Both disclosure and certification — the dual obligation common to Starr-template orders.",
            "Citation-by-citation verification is explicit.",
            "If you have a matter in W.D. Okla., set up a per-case AI cert workflow before first filing.",
            "Watch for Judge Robertson (E.D. Okla.) adopting a parallel order if you have Eastern Oklahoma matters.",
        ],
        "penalties": "Standard Rule 11 enforcement; striking of filings.",
        "practitioner_take": "Oklahoma joining the Starr camp is significant for firms with energy / IP / patent practices that touch the state. Standard cert template covers this.",
    },
    {
        "slug": "judge-molloy-mtd-pro-hac-vice",
        "title": "Pro Hac Vice Admission Order — AI Prohibition for Out-of-State Counsel",
        "subtitle": "Standing Order — Judge Donald W. Molloy (D. Mont.)",
        "citation": "D. Mont., J. Molloy, Pro Hac Vice Admission Order (June 2023)",
        "jurisdiction": "federal",
        "jurisdiction_label": "D. Mont. — J. Molloy",
        "state": None,
        "court": "D. Mont.",
        "judge": "Hon. Donald W. Molloy",
        "type": "standing_order",
        "type_label": "Federal Standing Order (Pro Hac Vice)",
        "effective_date": "2023-06-29",
        "source_url": "https://www.mtd.uscourts.gov/hon-donald-w-molloy-chambers",
        "source_archive_url": "https://reason.com/volokh/2023/06/29/federal-judge-forbids-use-of-chatgpt-by-out-of-state-lawyers/",
        "rules_implicated": ["11"],
        "requires_disclosure": False, "requires_verification": False,
        "summary": "An unusual scope: Judge Molloy's standard pro hac vice admission order prohibits 'use of artificial intelligence automated drafting programs, such as Chat GPT' — but only by counsel admitted pro hac vice. Locally barred counsel are not covered. The framing treats pro hac vice as a discretionary privilege subject to additional conditions.",
        "takeaways": [
            "Out-of-state counsel: if you're seeking pro hac vice in D. Mont. before Judge Molloy, AI is off-limits.",
            "Local Montana counsel are not subject to this prohibition.",
            "Failure to comply jeopardizes your pro hac vice status itself.",
            "If your firm's drafting workflow assumes AI assist, you may need a strict no-AI track for D. Mont. matters.",
        ],
        "penalties": "Revocation of pro hac vice admission; Rule 11 exposure.",
        "practitioner_take": "Molloy's order is uniquely scoped. If you're a national firm, build a per-judge AI-use registry — there's no other practical way to track which case bans AI for whom. The pro-hac-vice-only scope shows how AI rules can grow asymmetric and subject-specific.",
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
