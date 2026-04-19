# Motion-to-Dismiss Research & Draft — Multi-Model Prompt Pack

Seven chained prompts that take any capable chat model from complaint to filing-ready draft. Written for use when Claude Skills infrastructure is not available. The prompts reproduce the seven-stage workflow of the `Motion-to-Dismiss Research & Draft` skill; the JSON shapes at each stage match `intake-schema.json` and `draft-schema.json`.

Ground rules (paste once at the top of the session, before Prompt 1):

> You are assisting an attorney drafting a Rule 12(b) motion to dismiss in federal court (unless the attorney tells you otherwise). Two non-negotiable rules:
>
> 1. Every case citation you produce is flagged `[VERIFY]` and is not treated as verified unless and until I tell you it has been cleared by the citation-verification protocol.
> 2. Every factual assertion about the complaint is cited to a paragraph number, in the form "(Compl. ¶ __)" or "(Compl. Ex. __)". If you cannot cite a paragraph, do not include the assertion.
>
> If any stage's output is ambiguous or the complaint is not coherent (e.g., paragraphs not numbered, claims not clearly delineated), stop and tell me what needs to be fixed before proceeding.

MIT-licensed.

---

## Prompt 1 — Complaint intake and allegation extraction

> I will paste the complaint below. Parse it and produce a JSON object with the following fields:
>
> - `caption`, `court` (name, level, docket_number, judge, division), `filing_date`, `parties` (plaintiffs, defendants; for each: name, party_type, state_of_citizenship, role).
> - `jurisdiction_basis` — type (federal_question / diversity / supplemental / removal / admiralty / state_original), and on the face, whether diversity is complete, whether amount in controversy is pleaded above $75,000, and any facial defects.
> - `claims` — an array. For each claim: `claim_id` ("claim_1", "claim_2", …), `count_label` ("Count I"), `name`, `governing_law` (the body of law under which elements are assessed), `elements_by_forum` (a list with element_number and name — use the forum state's elements for state-law claims and the statute + controlling construction for federal claims), and `supporting_paragraphs` (the paragraph numbers in the complaint that purport to support the claim).
> - `paragraphs` — every numbered paragraph. For each: `paragraph_number`, `text` (verbatim), `type`, and `supports_claims`. `type` is F (factual), C (conclusory), L (legal conclusion), D (date-bearing), or E (exhibit reference). If a paragraph is more than one, pick the primary type and note the secondary in a field called `secondary_type`.
> - `dates` — every date-bearing fact with `date`, `paragraph`, `significance` (alleged_wrongful_act / alleged_injury / alleged_discovery / contract_date / performance_date / filing_date / tolling_event / other), and `ties_to_claim`.
> - `relief_sought` — the prayer for relief as listed.
> - `exhibits` — for each: label, description, whether incorporated by reference, and which paragraphs cite it.
> - `notes` — any anomalies I should know about before Stage 2 (e.g., paragraph numbering gaps).
>
> Output strict JSON. Do not commentary.
>
> Here is the complaint: [paste]

---

## Prompt 2 — 12(b) basis identification

> Using the JSON from Prompt 1, identify which Rule 12(b) grounds are viable against this complaint. Run the decision tree in this order and, for each, state in one to three sentences whether it applies on the face of the complaint:
>
> 1. 12(b)(1) — subject-matter jurisdiction (diversity / federal question / amount-in-controversy / standing — injury, causation, redressability).
> 2. 12(b)(2) — personal jurisdiction over each defendant (general / specific contacts with the forum; service propriety; Hague if applicable). Waivable under 12(h)(1).
> 3. 12(b)(3) — venue. Waivable — raise now or lose it.
> 4. 12(b)(4) / 12(b)(5) — process and service of process. Waivable.
> 5. 12(b)(6) — failure to state a claim, applying Twombly/Iqbal in federal court; preview which claims are weakest.
> 6. 12(b)(7) — failure to join a Rule 19 party.
>
> Also flag:
>
> - Statute of limitations apparent on the face of the complaint (raised within a 12(b)(6) motion where the circuit permits).
> - Res judicata / collateral estoppel apparent on the face.
> - Rule 9(b) particularity for any claim sounding in fraud.
>
> Return a JSON array of grounds, each with: `ground` (one of "12(b)(1)", "12(b)(2)", …, "9(b)", "statute_of_limitations", "res_judicata", "collateral_estoppel"), `applies` (boolean), `strength` ("low" / "medium" / "high"), and `reason_one_sentence`.
>
> If no ground is viable, say so and stop.

---

## Prompt 3 — Element-by-element deficiency analysis

> Using the JSON from Prompts 1 and 2, produce, for each challenged claim, a deficiency table. A claim is "challenged" if 12(b)(6), 9(b), or statute-of-limitations applies.
>
> For each claim: restate the elements from the controlling forum (already in `claims[].elements_by_forum`). For each element, list:
>
> - the paragraph numbers that purport to allege it;
> - the allegation type(s) supporting it (F / C / L);
> - a verdict: **pleaded** (factually), **inadequately pleaded** (with reason — conclusory, missing scienter, missing causation, missing damages measure), or **not pleaded at all**.
>
> For each date-sensitive claim, also run the statute-of-limitations accrual analysis: state the limitations period for the claim in the forum, the earliest alleged act (from the `dates` array), the filing date, and whether the claim is timely on the face. If the complaint pleads a basis for tolling (delayed discovery, fraudulent concealment, equitable estoppel, infancy, continuing violation), note it; if it does not, flag SOL as a dismissal ground. Show the arithmetic.
>
> Output JSON: an array of claims, each with `claim_id`, `elements_analysis` (array), and `sol_analysis` (object with `period`, `earliest_act`, `filing_date`, `timely_on_face`, `tolling_pleaded`).

---

## Prompt 4 — Controlling-law research plan

> Based on Prompts 1–3, produce a research plan — a prioritized list of authorities to pull before drafting. Do not yet provide case citations for the draft; that is Prompt 5.
>
> The research plan has four priority tiers:
>
> - Tier 1: controlling authority (U.S. Supreme Court for federal claims; state's highest court for state-law claims).
> - Tier 2: controlling appellate authority in the forum circuit / state.
> - Tier 3: in-circuit / in-state trial-court authority, especially from the assigned judge if known.
> - Tier 4: out-of-circuit or secondary, used only if Tiers 1–3 do not answer the question.
>
> For each item in the plan, include: tier, the element or issue it addresses, a one-sentence statement of the proposition for which you will seek authority, and (if proposing specific authorities) a `[VERIFY]`-flagged placeholder with case name and year. Do not invent case citations you are not confident are real and on-point; if uncertain, state the proposition and mark "find authority" rather than fabricate a cite.
>
> Output JSON: an array where each item has `tier`, `element_or_issue`, `proposition`, and either `placeholder_cite` (with [VERIFY]) or `find_authority: true`.

---

## Prompt 5 — Citation-verified draft generator

> Using Prompts 1–4, draft the Motion to Dismiss. The draft must follow this structure:
>
> ```
> I. ARGUMENT
>    A. Standing (if 12(b)(1) applies — otherwise omit)
>    B. Plaintiff Fails to State a Claim for [First Claim Name]
>    C. Plaintiff Fails to State a Claim for [Second Claim Name]
>    D. Plaintiff Fails to State a Claim for [Third Claim Name]
>    E. Plaintiff's Claims Are Barred by the Applicable Statute of Limitations (if applicable)
> CONCLUSION
> ```
>
> Requirements:
>
> - Each §§ B–D is element-by-element, with a short numbered subsection for each element that is challenged. Use the deficiency table from Prompt 3; convert each row to prose.
> - Every factual assertion about the complaint cites "(Compl. ¶ __)" or "(Compl. Ex. __)".
> - Every case or statute citation is emitted with `[VERIFY]` immediately after it. No exceptions. Short forms and `id.` are permitted but also carry `[VERIFY]` until the citation verifier has run.
> - String cites are disfavored. Prefer one controlling citation per proposition.
> - The Conclusion states the relief requested with precision: which counts are dismissed with prejudice, which without. Reserve "with prejudice" for situations where amendment would be futile (e.g., SOL bar, standing defect that cannot be re-pleaded).
> - Produce the draft in one pass. Do not truncate.
>
> Also produce a `citation_manifest` JSON array. Each entry has: `citation_id` ("cite_001", …), a pointer to the sentence where the citation appears, `raw_citation` (as emitted), `citation_type` (case / statute / rule / regulation / constitution / treatise / secondary), `proposition` (one sentence — what the citation supports), `pin_cite`, `short_form_after` (boolean), and `verify_status: "unverified"`.
>
> Return both the draft (as markdown) and the manifest (as JSON).

---

## Prompt 6 — Opposing-argument war-gaming

> You are now representing the opposing party for a single round. Read the draft from Prompt 5 and identify the three to five strongest arguments the opposition brief will make. For each:
>
> - State the argument in one paragraph, as if you were writing it.
> - Rate its strength (low / medium / high).
> - Identify whether the draft already answers it, and if so, point to the specific subsection. If not, propose a pre-empting sentence or paragraph to add to the draft (not a separate section — a pre-emption belongs in the subsection that raises the element).
>
> Return a JSON array: for each opposing argument, include `id` ("wg_1", …), `argument`, `strength`, `counter_in_draft` (subsection reference or null), and `proposed_addition` (text to add, or null if already answered).
>
> Also produce a short list of any opposing arguments that the draft cannot plausibly pre-empt without weakening its main thrust — these should be flagged for the partner, not added to the draft.

---

## Prompt 7 — Partner-review checklist

> Apply the 15-item partner-review checklist to the draft, the manifest, and the war-game. For each item, return `status` (pass / fail / n/a), a short `note`, and if fail, a specific fix.
>
> The 15 items:
>
> 1. Caption matches the complaint verbatim.
> 2. 12(b) grounds match the notice of motion.
> 3. Every factual assertion about the complaint is paragraph-cited.
> 4. The complaint's strongest allegations are addressed, not ignored.
> 5. Elements for each challenged claim are stated from controlling law of the forum.
> 6. Element-by-element analysis is complete (no element silently skipped).
> 7. Twombly / Iqbal is applied to specific paragraphs, not invoked as a slogan.
> 8. SOL arithmetic is on the page (period, earliest act, filing date, math).
> 9. Tolling / delayed-discovery / equitable-estoppel defenses to SOL are anticipated.
> 10. Every case citation is flagged `[VERIFY]` or cleared by the citation-verification protocol.
> 11. No citation is present that the drafter has not (or will not) personally read.
> 12. String cites are minimized.
> 13. War-gamed oppositions are pre-empted in the draft; unanswered arguments are flagged in the partner-review note.
> 14. Relief requested is realistic (with-prejudice only where amendment would be futile).
> 15. Local rules and the judge's standing order have been checked (page limits, font, meet-and-confer, courtesy copies, proposed-order format, hyperlinking).
>
> Return a JSON array of 15 items with `item_number`, `description`, `status`, `note`, and `fix` (null if pass).
>
> If any item is `fail`, list them at the top as "BLOCKED — do not send to partner."

---

## Reference sample the prompt pack must reproduce

For a complaint alleging breach of fiduciary duty, negligence, and unjust enrichment, the final draft structure is:

```
I. ARGUMENT
   A. Standing                                      [if challenged]
   B. Plaintiff Fails to State a Claim for Breach of Fiduciary Duty
      1. No fiduciary relationship is plausibly pleaded
      2. Breach is conclusory except as to the single dated transfer
      3. Damages are not causally linked
   C. Plaintiff Fails to State a Claim for Negligence
      1. No duty independent of contract is pleaded (economic-loss rule)
      2. Breach is conclusory
      3. Causation is conclusory
      4. Damages are not pleaded with a measure
   D. Plaintiff Fails to State a Claim for Unjust Enrichment
      1. An express contract governs — equitable relief is unavailable
   E. Plaintiff's Claims Are Barred by the Applicable Statute of Limitations
      [with dates and arithmetic]
CONCLUSION
```

Every citation produced by the pack in any stage is flagged `[VERIFY]`.

## Closing note

This pack is intended for use by licensed attorneys. No citation that appears in a draft leaves the Firm without running through the citation-verification protocol and being personally read by a drafting attorney. The drafter's Rule 11 certification is not delegable to a language model.

MIT-licensed. Use at your discretion and at your risk.
