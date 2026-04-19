# Deposition Prep in One Afternoon — Prompt Pack (any chat model)

Four chained prompts. Run sequentially in GPT, Gemini, Claude web, or any chat model. Each prompt stands alone — paste it, attach or paste the corpus where indicated, run.

Designed for the case where the deposition is tomorrow morning, the senior lawyer is in trial, and you have one afternoon. Built by a litigator for a litigator.

Licensed MIT. Not legal advice. Confirm protective-order compliance and privilege before sending anything.

---

## Privilege check — read before Prompt 1

Before pasting anything into a hosted chat model, confirm:

1. The corpus is produced discovery (Bates-stamped) or publicly filed material — not your firm's privileged work product.
2. The protective order's "permitted recipients" or "permitted purposes" clause permits processing through your model vendor. If unclear, stop.
3. PHI/PII is redacted unless your deployment is covered by the appropriate BAA/DPA.
4. You have a local list of what you withheld and why. That list is your audit trail.

If anything is unclear, do not run the prompts.

---

## Prompt 1 — Transcript ingestion and cleanup

```
You are a litigation associate prepping a senior trial lawyer for a deposition tomorrow morning. The senior lawyer has been in trial for two weeks. You have one afternoon. You are not summarizing — you are arming a deposition. Every fact must be tied to a Bates number or transcript pin cite.

Step 1 of 4. Do only this step.

Ingest the materials below into a single structured corpus. The corpus may include: the witness's prior depositions, prior trial or hearing testimony, sworn declarations, affidavits, interrogatory verifications, 30(b)(6) testimony, congressional or agency testimony, and produced exhibits.

Output a JSON object conforming to the schema in the appendix at the end of this prompt. For each transcript, normalize page/line numbers, identify speakers, strip stenographer artifacts, preserve objections verbatim. For each exhibit, capture Bates range, date, type, custodians, a one-sentence factual summary, and key verbatim quotes with pin cites.

Flag and quarantine: any item that may be subject to clawback (FRE 502(d)); anything marked DRAFT that may be work product; anything dated after the discovery cutoff.

After producing the JSON, report: total transcripts, total transcript pages, total exhibits, quarantined count.

CONFIDENCE GATE: rate 1–5. If below 4, list missing items and stop. If ≥4, end with "INGESTION COMPLETE — proceed to Prompt 2."

HANDOFF: This JSON is "the Corpus" in subsequent prompts.

CORPUS:
<<<paste transcripts and exhibits here, or attach files>>>

APPENDIX — transcript-schema.json:
<<<paste transcript-schema.json contents (see bottom of this file)>>>
```

---

## Prompt 2 — Witness timeline

```
Step 2 of 4.

Using the Corpus, build a single chronological timeline of every event involving the witness. Include: every document the witness sent, received, was copied on, or signed; every meeting the witness attended; every prior sworn statement the witness made; every public statement (earnings call, interview, social media) the witness made; every contractual or fiduciary obligation that came due.

Each timeline entry must include:
- Date (YYYY-MM-DD; mark uncertain dates as approximate and explain)
- Event description (one sentence, factual, no characterization)
- Source citation (Bates page, transcript pin cite, or other source)
- Witness's role (author / recipient / cc / attendee / signatory / deponent / declarant / speaker)
- Cross-reference to other timeline entries on the same date or topic

Do not skip dates because they look unimportant. A boring date may anchor a critical contradiction in Stage 3.

Output as a markdown table or JSON list. Then list:
- Total entries
- Date range
- Top 5 dates flagged for impeachment build-out (where the witness's expected testimony is likely to conflict with a contemporaneous document or prior sworn statement)

CONFIDENCE GATE: rate 1–5. End with "TIMELINE COMPLETE — proceed to Prompt 3" if ≥4.

HANDOFF: This timeline is "the Timeline."
```

---

## Prompt 3 — Impeachment-material finder

```
Step 3 of 4.

Walk the Timeline and identify every place where the witness's prior statement, prior writing, or prior conduct contradicts a fact the witness is expected to admit, deny, or not recall at the deposition.

For each contradiction, output:
- IMP-#
- Strength: HIGH / MEDIUM / LOW
- Expected deposition position (what the witness will say)
- Contradicting statement (verbatim quote)
- Citation pin (Bates page or transcript page:line)
- Impeachment basis: pick the rule(s) — FRE 613 (prior inconsistent statement); FRE 801(d)(2)(A) (party admission); FRE 801(d)(1)(A) (prior inconsistent under oath); FRE 803(6) (business record); FRE 608(b) (specific instance); FRE 609 (prior conviction); adoptive admission; bias; lack of personal knowledge
- "If the witness wiggles" — predict the most likely evasion (e.g., "I don't recall," "that was a draft," "that wasn't my final view," "I was relying on counsel") and the close-the-door follow-up
- Suggested exhibit handling at the depo (mark and identify, refresh recollection, impeachment, lock-in admission, or demonstrative)

Strength scale:
- HIGH: direct verbatim contradiction, signed or sent by the witness, easy to authenticate
- MEDIUM: inferential contradiction or one removed from the witness; requires light foundation work
- LOW: colorable but the witness can plausibly distinguish; do not include in the outline unless explicitly asked

Output the HIGH and MEDIUM items only by default. Note how many LOW items were excluded.

CONFIDENCE GATE: rate 1–5. End with "IMPEACHMENT ANALYSIS COMPLETE — proceed to Prompt 4" if ≥4.

HANDOFF: This list is "the Impeachment Set."
```

---

## Prompt 4 — Cross-exam outline

```
Step 4 of 4. Produce the cross-exam outline.

Structure (default 3 sections; adjust if case theory requires):
- I. Background — who the witness is, role, tenure, reporting lines, comp structure (especially comp tied to the conduct at issue), document-handling practices. Closes the door on later "I'm not familiar with that" answers. Typical: 10–15 questions.
- II. Timeline — walk the witness through events in chronological order, anchored to documents at every step. Lock in the witness's account. Build the foundation for impeachment in section III. Typical: longest section, 25+ questions.
- III. Impeachment — confront the witness with HIGH and MEDIUM items from the Impeachment Set, in priority order. Each impeachment block follows: (a) commit the witness to the position, (b) introduce the exhibit and have the witness identify it, (c) read the contradicting language verbatim, (d) ask the closing question that locks in the contradiction.

For each question, capture:
- q_number (e.g., I.1, II.34, III.3)
- question_text (LEADING form on cross; open form only when fishing for a useful admission)
- exhibits used [{exhibit_id, pin_cite, purpose}]
- transcript_cite (if confronting with a prior sworn statement)
- anticipated_answer
- if_witness_wiggles (predicted evasion + close)
- follow_up_if_denied / follow_up_if_admitted
- impeachment_flag (true/false)
- impeachment_basis (FRE rule)
- priority (high/medium/low)
- objection_risk + objection_response (predicted opposing-counsel objection and your response)

At the top of the outline include:
- Witness name, role, case caption, deposition date, examiner
- Estimated total time (cap at the jurisdiction's statutory limit, e.g., 7 hours under FRCP 30(d)(1))
- "Top 5 Goals" — the 5 admissions the trial lawyer must walk out with, each with the exhibit anchors that lock it down
- Ground-rules reminder (30(b)(6) topic designations, prior orders limiting scope, errata practice)

At the end include:
- Exhibits index (table: Ex. number, Bates range, date, description, link, confidentiality designation)
- Open issues for lead counsel (clawback questions, 30(b)(6) scope decisions, etc.)

Output structure must conform to the outline-schema.json in the appendix to this prompt. Render the final outline as a clean markdown document if you cannot produce a Word file in your environment; otherwise produce a .docx.

CONFIDENCE GATE: final confidence 1–5. Note any LOW-rated impeachment items excluded.

APPENDIX — outline-schema.json:
<<<paste outline-schema.json contents (see bottom of this file)>>>
```

---

## Reference example — what a good run looks like

Witness: Renata Hsu, CFO of Meridian Robotics Corp. Topics: Q2 revenue restatement, audit committee communications, board deck versioning. Securities-class-action context.

A correct run produces:

- **I. Background — 12 questions.** Establishes role, tenure, reporting line to CEO and Audit Committee Chair, PSU comp tied to three-year cumulative revenue, document-retention practices, SOX §302 certification status.
- **II. Timeline — 34 questions.** Walks each key date from the start of Q2 through the May 8 restatement. Critical: the March 28 board meeting (Hsu reaffirms $82M Q2 guidance via deck v4) and the April 11 internal email (Hsu writes to Controller and Deputy CFO that "we'll need to cycle back on the CPS-4 number; I don't see how we hit the deck"). Section II locks in both before Section III confronts.
- **III. Impeachment — 9 questions in two blocks.** Block A confronts with Ex. 14 (Apr 9–11 email chain) showing Hsu knew the deck number was unsupportable before signing the April 25 SOX §302 cert. Block B confronts with Ex. 22 (board deck v4) vs. Ex. 22a (board deck v3) showing Hsu personally raised the Q2 revenue forecast from $79M to $82M after the FP&A team had set it at $79M, with no forecasting memo to support the change.
- **41 exhibits** linked in the exhibits index, with Bates ranges and one-sentence descriptions.
- Top 5 Goals listed at the top, including the v3 → v4 deck change, the April 11 email, the absence of audit-committee disclosure on April 18, and the SOX cert post-dating the April 11 admission.

If your output materially under-delivers on this benchmark for a comparable witness, the prompts ran short — most often Stage 3 was rushed. Re-run Prompt 3 with explicit instruction to produce no fewer than 7 HIGH/MEDIUM items.

---

## Appendix — Inlined schemas

### transcript-schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.com/schemas/deposition-prep/transcript-corpus.json",
  "title": "Deposition Prep Transcript Corpus",
  "type": "object",
  "required": ["case_caption", "matter_number", "witness", "transcripts", "exhibits"],
  "properties": {
    "case_caption": { "type": "string" },
    "matter_number": { "type": "string" },
    "protective_order": {
      "type": "object",
      "properties": {
        "docket_entry": { "type": "string" },
        "date_entered": { "type": "string", "format": "date" },
        "permits_ai_processing": { "type": "string", "enum": ["yes", "no", "unclear_consult_lead"] },
        "tiers": {
          "type": "array",
          "items": { "type": "string", "enum": ["Confidential", "Highly Confidential", "Attorneys' Eyes Only", "Source Code", "Other"] }
        }
      }
    },
    "witness": {
      "type": "object",
      "required": ["name", "role"],
      "properties": {
        "name": { "type": "string" },
        "role": { "type": "string" },
        "deposition_date": { "type": "string", "format": "date" },
        "deposition_type": { "type": "string", "enum": ["fact_witness", "30b6", "expert", "treating_physician", "custodian", "other"] },
        "represented_by": { "type": "string" },
        "prior_sworn_statements": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["type", "date", "citation"],
            "properties": {
              "type": { "type": "string", "enum": ["deposition", "trial_testimony", "hearing_testimony", "affidavit", "declaration", "interrogatory_verification", "agency_testimony", "congressional_testimony", "sec_testimony", "other"] },
              "date": { "type": "string", "format": "date" },
              "citation": { "type": "string" },
              "transcript_id": { "type": "string" }
            }
          }
        }
      }
    },
    "transcripts": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "type", "date", "deponent", "pages"],
        "properties": {
          "id": { "type": "string" },
          "type": { "type": "string", "enum": ["deposition", "30b6", "trial", "hearing", "affidavit", "declaration", "interrogatory", "agency", "congressional", "sec", "other"] },
          "date": { "type": "string", "format": "date" },
          "deponent": { "type": "string" },
          "proceeding": { "type": "string" },
          "volume": { "type": "integer" },
          "certified": { "type": "boolean" },
          "errata_applied": { "type": "boolean" },
          "pages": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["page", "lines"],
              "properties": {
                "page": { "type": "integer" },
                "lines": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "required": ["line", "speaker", "text"],
                    "properties": {
                      "line": { "type": "integer" },
                      "speaker": { "type": "string" },
                      "text": { "type": "string" },
                      "objection": { "type": "boolean" },
                      "objection_basis": { "type": "string" },
                      "marked_exhibit": { "type": "string" }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "exhibits": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "bates_start", "bates_end", "type", "summary"],
        "properties": {
          "id": { "type": "string" },
          "bates_start": { "type": "string" },
          "bates_end": { "type": "string" },
          "date": { "type": "string", "format": "date" },
          "type": { "type": "string", "enum": ["email", "email_chain", "memo", "letter", "slide_deck", "spreadsheet", "contract", "meeting_minutes", "board_deck", "board_minutes", "financial_statement", "sec_filing", "calendar_entry", "text_message", "chat_log", "recording_transcript", "handwritten_note", "photograph", "other"] },
          "custodian": { "type": "string" },
          "author": { "type": "string" },
          "recipients": { "type": "array", "items": { "type": "string" } },
          "cc": { "type": "array", "items": { "type": "string" } },
          "subject": { "type": "string" },
          "summary": { "type": "string" },
          "key_language": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["bates_page", "quote"],
              "properties": {
                "bates_page": { "type": "string" },
                "quote": { "type": "string" }
              }
            }
          },
          "version_lineage": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "predecessor_exhibit_id": { "type": "string" },
                "successor_exhibit_id": { "type": "string" },
                "material_changes": { "type": "string" }
              }
            }
          },
          "confidentiality_designation": { "type": "string", "enum": ["none", "Confidential", "Highly Confidential", "Attorneys' Eyes Only", "Source Code"] },
          "privilege_status": { "type": "string", "enum": ["none", "claimed_by_producing_party", "on_privilege_log", "clawback_requested", "disputed"] },
          "ocr_text": { "type": "string" },
          "quarantined": { "type": "boolean" },
          "quarantine_reason": { "type": "string" }
        }
      }
    },
    "corpus_stats": {
      "type": "object",
      "properties": {
        "total_transcripts": { "type": "integer" },
        "total_transcript_pages": { "type": "integer" },
        "total_exhibits": { "type": "integer" },
        "quarantined_count": { "type": "integer" },
        "ingestion_timestamp": { "type": "string", "format": "date-time" }
      }
    }
  }
}
```

### outline-schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.com/schemas/deposition-prep/cross-exam-outline.json",
  "title": "Cross-Examination Outline",
  "type": "object",
  "required": ["case_caption", "witness", "examiner", "deposition_date", "sections", "exhibits_index"],
  "properties": {
    "case_caption": { "type": "string" },
    "matter_number": { "type": "string" },
    "witness": {
      "type": "object",
      "required": ["name", "role"],
      "properties": {
        "name": { "type": "string" },
        "role": { "type": "string" }
      }
    },
    "deposition_date": { "type": "string", "format": "date" },
    "deposition_location": { "type": "string" },
    "examiner": { "type": "string" },
    "estimated_total_minutes": { "type": "integer" },
    "top_5_goals": {
      "type": "array",
      "minItems": 1, "maxItems": 7,
      "items": {
        "type": "object",
        "required": ["goal", "why_it_matters"],
        "properties": {
          "goal": { "type": "string" },
          "why_it_matters": { "type": "string" },
          "exhibit_anchors": { "type": "array", "items": { "type": "string" } }
        }
      }
    },
    "ground_rules_reminder": { "type": "string" },
    "sections": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "title", "goal", "questions"],
        "properties": {
          "id": { "type": "string" },
          "title": { "type": "string" },
          "goal": { "type": "string" },
          "estimated_minutes": { "type": "integer" },
          "questions": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["q_number", "question_text"],
              "properties": {
                "q_number": { "type": "string" },
                "question_text": { "type": "string" },
                "question_form": { "type": "string", "enum": ["leading", "open", "compound_avoid", "foundation"] },
                "exhibits": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "required": ["exhibit_id"],
                    "properties": {
                      "exhibit_id": { "type": "string" },
                      "pin_cite": { "type": "string" },
                      "purpose": { "type": "string", "enum": ["mark_and_identify", "refresh_recollection", "impeachment", "lock_in_admission", "demonstrative"] }
                    }
                  }
                },
                "transcript_cite": { "type": "string" },
                "anticipated_answer": { "type": "string" },
                "if_witness_wiggles": { "type": "string" },
                "follow_up_if_denied": { "type": "string" },
                "follow_up_if_admitted": { "type": "string" },
                "impeachment_flag": { "type": "boolean" },
                "impeachment_basis": { "type": "string", "enum": ["FRE_613_prior_inconsistent_statement", "FRE_801(d)(2)_party_opponent", "FRE_801(d)(1)(A)_prior_inconsistent_under_oath", "FRE_803(6)_business_record", "FRE_608(b)_specific_instance", "FRE_609_prior_conviction", "adoptive_admission", "bias", "lack_of_personal_knowledge"] },
                "priority": { "type": "string", "enum": ["high", "medium", "low"] },
                "objection_risk": { "type": "string", "enum": ["none", "form", "foundation", "calls_for_legal_conclusion", "calls_for_speculation", "privilege", "scope", "asked_and_answered", "compound", "argumentative"] },
                "objection_response": { "type": "string" }
              }
            }
          }
        }
      }
    },
    "exhibits_index": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["exhibit_id", "bates_range", "description"],
        "properties": {
          "exhibit_id": { "type": "string" },
          "bates_range": { "type": "string" },
          "date": { "type": "string", "format": "date" },
          "description": { "type": "string" },
          "type": { "type": "string" },
          "link": { "type": "string" },
          "confidentiality_designation": { "type": "string", "enum": ["none", "Confidential", "Highly Confidential", "Attorneys' Eyes Only", "Source Code"] }
        }
      }
    },
    "open_issues_for_lead_counsel": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["issue", "why"],
        "properties": {
          "issue": { "type": "string" },
          "why": { "type": "string" },
          "needs_decision_before": { "type": "string", "format": "date-time" }
        }
      }
    },
    "metadata": {
      "type": "object",
      "properties": {
        "prep_time_minutes": { "type": "integer" },
        "generated_at": { "type": "string", "format": "date-time" },
        "skill_version": { "type": "string" }
      }
    }
  }
}
```

---

## Sample run summary (full run is in `sample-run.md` of the skill bundle)

**Witness:** Renata Hsu, CFO, Meridian Robotics Corp.
**Case:** *In re Meridian Robotics Corp. Securities Litigation*, No. 24-cv-01847 (N.D. Cal.)
**Corpus:** 4 transcripts (Sidorov deposition 2022; congressional testimony 2021; PI declaration; interrogatory verifications), 41 exhibits, 375 transcript pages.
**Quarantined at Stage 1:** 2 emails (Hsu / outside SEC counsel) pending FRE 502(d) clawback determination.
**Timeline:** 78 entries, Jan 2023 through May 2024.
**Impeachment set:** 9 items (4 HIGH, 5 MEDIUM); 6 LOW excluded.
**Outline:** I. Background (12 Q), II. Timeline (34 Q), III. Impeachment (9 Q in two blocks). 41 exhibits indexed. Estimated 5 hr 45 min.
**Top 5 Goals:** (1) Hsu personally raised Q2 forecast from $79M to $82M (Ex. 22, Ex. 22a, Ex. 21); (2) by April 11 Hsu wrote internally that $82M was unachievable (Ex. 14); (3) April 18 audit committee minutes contain no disclosure of the CPS-4 issue (Ex. 28); (4) SOX §302 cert on the April 25 10-Q post-dates the April 11 email (Ex. 31); (5) Hsu's PSU comp turns on three-year cumulative revenue (Ex. 2, 3, 5).

---

*MIT-licensed. Not legal advice. Confirm protective-order compliance and privilege before sending discovery to any model.*
