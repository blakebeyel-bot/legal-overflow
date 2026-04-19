# Contract Redline Review — Tier 1 (prompt pack for any chat model)

Nine chained prompts for GPT, Gemini, Claude web, or any other chat model. Run them in order. Each prompt stands alone — copy, paste, attach or paste the contract text where indicated, and run. At the end of each prompt there is a **confidence gate** and a **handoff** telling you what to feed into the next prompt.

Licensed MIT. Written for someone who reviews contracts for a living. No fluff.

---

## How to use this pack

1. Have the full contract text in front of you (plain text or PDF-extracted).
2. Open a fresh chat. Run Prompt 1. Keep the conversation going.
3. Between prompts, check the "confidence gate." If the model says confidence is below 4/5, do not proceed — fix the ambiguity first.
4. At the end, Prompt 9 assembles the final redline memo.

If you are mid-run and the model's context is getting long, start a new chat at Prompt 8 and paste in the cumulative findings.

---

## Prompt 1 — Intake and agreement classification

```
You are acting as a skeptical in-house contracts attorney doing a first-pass redline review. You are not a rubber stamp. Assume the draft below was sent by the counterparty and is tilted in their favor until proven otherwise.

Step 1 of 9. Do only this step.

Read the contract below. Tell me:
1. Agreement type (NDA, mutual NDA, MSA, SaaS subscription, software license, DPA, other — pick one).
2. Parties and their roles (who is the customer, who is the vendor/provider, any third-party beneficiaries).
3. Governing law, venue, and dispute resolution mechanism (one sentence each).
4. Total contract value or pricing structure, if stated.
5. Effective date and term length.

Then rate your confidence in this intake on a 1–5 scale.

CONFIDENCE GATE: If confidence is below 4/5, list exactly what is missing or ambiguous and stop. Do not proceed. If 4 or 5, end with: "INTAKE COMPLETE — proceed to Prompt 2."

HANDOFF: Your output will be referenced in subsequent prompts as "the Intake."

CONTRACT:
<<<paste contract text here>>>
```

---

## Prompt 2 — Clause segmentation and preliminary tagging

```
Step 2 of 9.

Segment the contract into labeled clauses using this taxonomy, in this order:

1. Parties / recitals
2. Definitions
3. Scope / license grant / subject matter
4. Fees, payment, taxes
5. Term and termination
6. Change of control / assignment
7. Confidentiality
8. Data protection / privacy / security
9. Intellectual property
10. Representations and warranties
11. Indemnification
12. Limitation of liability
13. Insurance
14. Governing law, venue, dispute resolution
15. Boilerplate

For each, output a row: clause name | section citation (e.g., §7.2) | one-line plain-English summary | preliminary flag (GREEN / YELLOW / RED). Do not explain flags yet. If a clause category is absent, write "NOT PRESENT" — do not invent.

CONFIDENCE GATE: rate 1–5. If below 4, say which sections you couldn't cleanly map and stop.

HANDOFF: This table is "the Segmentation."

"INTAKE COMPLETE" summary from Prompt 1:
<<<paste Intake output here, or keep chat context>>>
```

---

## Prompt 3 — Risk triage

```
Step 3 of 9.

Using the Segmentation, rank every YELLOW and RED clause by business impact. Use this scale:

- CRITICAL: uncapped or disproportionate liability, loss of IP, regulatory violation, inability to exit. Must be fixed before signature.
- HIGH: materially one-sided or commercially painful. Should be fixed; fallback acceptable.
- MEDIUM: suboptimal but livable.
- LOW: drafting nit or preference.

Output a table: # | severity | section | one-line issue | one-line proposed fix.

No analysis yet — triage only. We will deep-read next.

CONFIDENCE GATE: rate 1–5. End with "TRIAGE COMPLETE — proceed to Prompt 4" if ≥4.

HANDOFF: This table is "the Triage."
```

---

## Prompt 4 — Jurisdiction sanity check

```
Step 4 of 9.

Read the governing law, venue, and dispute resolution clauses together. Flag any of:

- Governing law of a jurisdiction where the counterparty sits and the customer does not
- Exclusive venue in a foreign or inconvenient forum
- Mandatory arbitration with class-action waiver where customer is consumer-facing
- Inconsistent choice-of-law and venue (e.g., Delaware law, California courts)
- Jury-trial waiver without reciprocity

For each flag: quote the problematic language, state the concern in 1–2 sentences, propose a fallback (typically: law and venue of the customer's home state; carve-out for injunctive relief anywhere).

If nothing is wrong, say so explicitly — "Jurisdiction clauses are market and acceptable" — and move on.

CONFIDENCE GATE: rate 1–5. End with "JURISDICTION CHECK COMPLETE — proceed to Prompt 5" if ≥4.
```

---

## Prompt 5 — Limitation of liability deep-read

```
Step 5 of 9. This is the single highest-leverage clause. Read it twice.

Produce a structured analysis:

a. Who is capped — one-sided vs. mutual
b. What the cap is — fixed dollar, fees paid, multiple of fees; aggregate vs. per-claim
c. Lookback window — 12 months standard; shorter is worse for customer
d. Carve-outs from the cap — look specifically for: indemnification, confidentiality breach, data protection breach, gross negligence, willful misconduct, fraud, IP infringement, payment obligations. List each one: PRESENT or MISSING.
e. Consequential damages waiver — mutual? carve-outs?

Then:

1. Quote the current §[section] verbatim.
2. Write a paste-ready replacement with: mutual cap, carve-outs for IP indemnity, confidentiality, data breach, gross negligence, willful misconduct, fraud.
3. State a fallback position (what you'll accept if they push back).

Reference example for format (do not copy the facts — use the actual contract):

Input: "§7.2 LIMITATION OF LIABILITY. In no event shall Vendor's aggregate liability exceed the fees paid by Customer in the twelve (12) months preceding the claim."

Expected treatment: flag one-sided cap; flag no carve-outs for IP indemnity, confidentiality breach, data breach, gross negligence, willful misconduct, fraud; propose mutual cap with explicit exclusions section and paste-ready replacement language.

CONFIDENCE GATE: rate 1–5. Below 4, state why (ambiguous drafting, defined terms not located, cross-references). If ≥4, end with "LOL ANALYSIS COMPLETE — proceed to Prompt 6."
```

---

## Prompt 6 — Indemnification analysis

```
Step 6 of 9.

For each indemnity obligation in the contract, identify:

- Indemnifying party and indemnified party
- Triggering events (third-party claims only, or also direct claims?)
- Scope (losses, damages, fees, costs, reasonable attorneys' fees)
- Procedure (notice, control of defense, consent-to-settle)
- Exclusions

Flag:
- One-way indemnities in a deal that should be mutual
- Indemnities covering first-party claims (indemnitor becomes an insurer)
- Sole-control defense clauses that let the indemnitor settle without consent
- Indemnities that are NOT carved out of the liability cap (this is the #1 silent killer)

For each issue: quote the language, explain, propose paste-ready redline, and state fallback.

CONFIDENCE GATE: rate 1–5. End with "INDEMNITY ANALYSIS COMPLETE — proceed to Prompt 7."
```

---

## Prompt 7 — IP, data, confidentiality, termination, change-of-control

```
Step 7 of 9. Combined audit of four load-bearing areas. Be concise but complete.

IP:
- Who owns pre-existing IP? Who owns work product? Is there a license back?
- Is the license scope (field, term, territory, exclusivity, sublicensability) clear?

Data:
- Is there a DPA or equivalent?
- Data categories defined?
- Cross-border transfer mechanism (SCCs, adequacy)?
- Security standards referenced (SOC 2, ISO 27001, etc.)?
- Breach notification timeline in hours/days?

Confidentiality:
- Mutual or one-way?
- Definition of Confidential Information — marked-only, or marked-or-should-be-known?
- Exclusions (public, independent development, rightfully received)?
- Term — perpetual for trade secrets, 3–5 years otherwise is standard
- Residuals clause present?
- Return/destruction on termination?

Termination and change-of-control:
- Termination for convenience — available to whom, on what notice?
- Cure period for material breach — 30 days is standard
- Effect of termination (refund, data return, transition assistance)
- Surviving sections list complete?
- Assignment to affiliates / successor in M&A without consent?
- Termination right on change of control to a competitor? Is "competitor" defined?

For each issue: quote, explain, propose redline, state fallback.

CONFIDENCE GATE: rate 1–5. End with "AUDIT COMPLETE — proceed to Prompt 8."
```

---

## Prompt 8 — Senior-partner pushback pass

```
Step 8 of 9.

Reread everything you have produced so far as if you are a senior partner with 25 years of experience reviewing this junior associate's work. Ask yourself:

1. Did I miss a clause that a sophisticated counterparty would exploit?
2. Did I take any clause at face value using a defined term I didn't actually check? Go find the definition and verify.
3. Are my proposed redlines realistic, or are they unrealistic asks that will burn credibility in negotiation?
4. Is there a clause I marked GREEN that only looks standard because it's common, but is actually bad for my client?
5. Did I confuse "market" with "acceptable"? Market terms can still be terrible terms.
6. Is there a clause that is dangerous in combination with another clause, even if each is fine alone? (E.g., broad indemnity + narrow cap carve-outs.)

Produce a section titled "Pushback Pass — Issues I Almost Missed." If this pass surfaces nothing, say so explicitly. Do not pad.

CONFIDENCE GATE: rate 1–5. End with "PUSHBACK COMPLETE — proceed to Prompt 9."
```

---

## Prompt 9 — Compile the final redline memo

```
Step 9 of 9. Assemble the final redline memo.

Format — use this structure exactly:

# Redline Memo — [Agreement Type]
**Counterparty:** [name]
**Agreement:** [title, date]
**Reviewer:** [your name]
**Review date:** [YYYY-MM-DD]
**Overall recommendation:** [APPROVE AS-IS | APPROVE WITH CHANGES | DO NOT SIGN]

## 1. Executive Summary
3–5 plain-English bullets a non-lawyer can act on.

## 2. Critical Issues
Table: # | severity | section | issue | proposed fix.

## 3. Clause-by-Clause Findings
For each issue:
- Section citation
- Current language (quoted verbatim)
- Why it's a problem (2–4 sentences)
- Proposed redline (paste-ready — actual language, not "something like X")
- Fallback position

## 4. Medium / Low Items
Bullet list.

## 5. Open Questions for the Business Team
Numbered list.

## 6. Confidence Statement
Overall confidence X/5, plus areas of lower confidence and why.

## 7. Pushback Pass — Issues I Almost Missed
From Prompt 8.

Rules:
- Quoted language must be verbatim, in quotation marks, with section numbers.
- Proposed redlines must be paste-ready. No "something like" or "language to this effect."
- No preamble. No meta-commentary. No apologies. Just the memo.

CONFIDENCE GATE: final confidence 1–5. Deliver the memo.
```

---

## Reference example both versions must reproduce

**Input clause:**

> §7.2 LIMITATION OF LIABILITY. In no event shall Vendor's aggregate liability exceed the fees paid by Customer in the twelve (12) months preceding the claim.

**Expected output (summary of what a correct Tier 1 review produces):**

- Flag: one-sided cap — applies only to Vendor; Customer's liability is uncapped by implication. Ask for a mutual cap.
- Flag: no carve-outs for IP indemnity, confidentiality breach, data breach, gross negligence, willful misconduct, or fraud. Add them.
- Flag: 12-month lookback is market; confirm cap is aggregate across all claims, not per-claim.
- Proposed redline (paste-ready):

  > §7.2 LIMITATION OF LIABILITY. Except as set forth in §7.3, in no event shall either party's aggregate liability under this Agreement exceed the fees paid or payable by Customer to Vendor in the twelve (12) months preceding the event giving rise to the claim.
  >
  > §7.3 Exclusions from Cap. The limitations in §7.2 shall not apply to: (a) a party's indemnification obligations under §[indemnity section]; (b) breach of §[confidentiality section] (Confidentiality); (c) breach of §[data protection section] (Data Protection); (d) gross negligence, willful misconduct, or fraud; or (e) a party's payment obligations.

- Confidence: 5/5 on the structural issues. Reconfirm cross-references once final indemnity and confidentiality section numbers are locked.

---

*MIT-licensed. Not legal advice. First-pass Tier 1 only — not a substitute for a full negotiation cycle or outside-counsel review on novel or high-dollar terms.*
