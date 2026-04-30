---
name: "Citation Verification Protocol"
description: "Bluebook 22nd-edition citation form-check. Invokes whenever the user pastes a brief, motion, memorandum, opposition, reply, or draft filing; mentions cases, pin-cites, Bluebook, citation form, cite-check, Bluebooking, short form, id., supra, string cite, introductory signals, parentheticals, or parallel citations; asks to Bluebook a document, check citation format, apply the 22nd edition, or verify that citations conform to a particular style guide. Produces a structured extraction, a rule-by-rule mapping, and a tiered report of conforming, correctable, and non-conforming citations, anchored to specific Bluebook 22e rule and table numbers."
version: 1.1.0
license: MIT
---

# Citation Verification Protocol

## 1. Purpose

Verify that every citation in a draft filing conforms to the Twenty-Second Edition of *The Bluebook: A Uniform System of Citation* ("Bluebook 22e"). The authority for this protocol is the Bluebook itself, as published by The Columbia Law Review Association, The Harvard Law Review Association, the University of Pennsylvania Law Review, and The Yale Law Journal. The drafting attorney must have access to a copy of the Bluebook 22e. Every finding emitted by this protocol is anchored to a specific Bluebook rule, Bluepages rule, or table number (e.g., `BB R. 10.2.2`, `BB BP10.1.1`, `BB T6`) so the attorney can audit each call against the source text. This protocol does not reproduce Bluebook text.

## 2. Bluebook 22e — operating map

The protocol operates against the Bluebook 22e's rule and table structure. The attorney consults the Bluebook for the text of any rule; this protocol applies the rules by number. The structure:

**Bluepages (practitioner rules, governing court filings):** BP1 through BP23. These control the form of citations in briefs, motions, memoranda of law, oppositions, replies, and letters to a court.

**White-pages (main rules, governing scholarly writing):** R1 through R23.

- R1 — Structure and use of citations (citation sentences, citation clauses, signals, order of authorities, parentheticals, punctuation).
- R2 — Typeface conventions.
- R3 — Subdivisions (volumes, parts, pages, paragraphs, sections, footnotes, graphs, tables, appendices, internal cross-references).
- R4 — Short citation forms (*id.*, *supra*, "hereinafter").
- R5 — Quotations (block-quote threshold, alterations, omissions, mistakes in the original, citing quoted material).
- R6 — Abbreviations, numerals, and symbols.
- R7 — Italicization for style and in unique circumstances.
- R8 — Capitalization.
- R9 — Titles of judges, officials, and terms of court.
- R10 — Cases (full citation and related rules).
- R11 — Constitutions.
- R12 — Statutes.
- R13 — Legislative materials.
- R14 — Administrative and executive materials.
- R15 — Books, reports, and other nonperiodic materials.
- R16 — Periodical materials.
- R17 — Unpublished and forthcoming sources.
- R18 — The internet, electronic media, and other nonprint resources.
- R19 — Services.
- R20 — Foreign materials.
- R21 — International materials.
- R22 — (new in 22e; consult Bluebook for coverage).
- R23 — (new in 22e; consult Bluebook for coverage).

**Tables (consulted with the rules):**

- T1 — United States Jurisdictions. T1.1 federal; T1.2 federal taxation; T1.3 states and the District of Columbia; T1.4 other U.S. jurisdictions; T1.5 Tribal Nations.
- T2 — Foreign Jurisdictions.
- T3 — Intergovernmental Organizations.
- T4 — Treaty Sources.
- T5 — Arbitral Reporters.
- T6 — Case Names and Institutional Authors in Citations.
- T7 — Court Names.
- T8 — Explanatory Phrases for prior and subsequent history.
- T9 — Legislative Documents.
- T10 — Geographical Terms.
- T11 — Judges and Officials.
- T12 — Months.
- T13 — Institutional Names in Periodical Titles.
- T14 — Publishing Terms.
- T15 — Services.
- T16 — Subdivisions.
- BT1 and BT2 — Bluepages tables (BT2 includes local citation rules by jurisdiction).

Pin-cite format used in all deliverables:

- Bluepages rule: `BB BP10.1` (Bluepages rule only)
- White-pages rule: `BB R. 10.2.2`
- Table: `BB T6` or `BB T1.1`
- Combined: `BB R. 10.2.2; T6`

## 3. Style selection (stated at intake)

The Bluebook contains two rule sets. The skill must select one at intake and apply that set throughout:

- **Bluepages (practitioner).** Default for briefs, motions, memoranda, oppositions, replies, letters to a court. Citations appear as separate citation sentences or embedded citation clauses in the main text. Typeface conventions follow BP2 (large and small caps are not used in practitioner documents).
- **White-pages (scholarly).** Law-review articles, student notes, treatises. Citations appear in footnotes; typeface follows R2, including large and small caps for certain secondary-source authors and titles.

Jurisdiction-specific local rules override the Bluebook where the two conflict. Before Stage 3 starts, consult BT2 for the filing court's local citation rule and apply the local rule where it departs from Bluebook 22e. Record any such local-rule override on the face of the Stage 4 report.

If the style is not clear from the draft, ask the user. Do not assume.

## 4. Stage 1 — Citation extraction

Parse the draft and emit a numbered extraction table. Every instance of citable authority gets a row. Do not deduplicate; each pin-cite location is independently verified against form rules.

Columns:

1. Citation number (order of first appearance).
2. Citation text, verbatim, including introductory signal, parenthetical, pin-cite, and any embedded string-cite components.
3. Citation type: case (full), case (short form), *id.*, *supra*, statute, session law, regulation, constitutional provision, procedural rule, treatise, law-review article, restatement, uniform act, model code, dictionary, administrative decision, legislative history, internet source, court document, other.
4. Jurisdiction and deciding body (for cases: court and year; for statutes: code and title; for secondary: publisher and year).
5. Location in the draft: page; section; paragraph.
6. Whether the surrounding text includes a direct quotation of the source: yes / no. If yes, transcribe the quoted span.
7. Whether an introductory signal is present (no signal; *See*; *See also*; *Cf.*; *Contra*; *But see*; *But cf.*; *See, e.g.*; *Accord*; *Compare … with*; the new 22e *contrast* signal). Governing: `BB R. 1.2` and `BB BP1.2`.
8. Whether any parenthetical is attached: yes / no. If yes, transcribe and classify (explanatory / weight-of-authority / quoting / citing-back / prior-history / subsequent-history). Governing: `BB R. 1.5` and `BB R. 10.6` (case parentheticals).

At the end of Stage 1, confirm the total count to the user before proceeding.

## 5. Stage 2 — Rule mapping

For each row emitted at Stage 1, identify the governing rule path. The mapping is the work product; it also serves as the audit trail for Stage 3.

Produce, for each citation, a three-column entry:

- Citation number.
- Citation type.
- Governing rule(s) and table(s), with pin-cites (e.g., `BB R. 10.3.1; T1.1; T7` for a federal-reporter case citation; `BB R. 12.3.1; T1.1` for a federal statute).

Standard mappings (non-exhaustive, Bluepages style shown; substitute the parallel R-number for white-pages):

| Citation type | Primary rule(s) | Relevant tables |
|---------------|-----------------|------------------|
| Full case citation | BP10; R. 10 (10.1 components; 10.2 case names; 10.3 reporter; 10.4 court; 10.5 date; 10.6 parentheticals; 10.7 history) | T1; T6; T7; T8 |
| Short-form case citation; *id.* | BP10.2; R. 10.9; R. 4 | — |
| *Supra* | R. 4.2 | — |
| Federal statute (U.S. Code) | BP12; R. 12 (12.2 choice of source; 12.3 components; 12.9 short forms) | T1.1 |
| State statute | BP12; R. 12 | T1.3 |
| Session laws | R. 12.4 | T1 |
| Constitution | BP11; R. 11 | T1 |
| Federal regulation | BP14; R. 14 | T1.1 |
| Legislative materials | BP13; R. 13 | T9 |
| Administrative materials | BP14; R. 14 | T1 |
| Court and litigation documents | BP7; R. 3 (subdivisions); BT1 | — |
| Book / treatise / nonperiodic | BP15; R. 15 | T6 (institutional authors) |
| Law-review article / periodical | BP16; R. 16 | T13; T14 |
| Restatement, model code, uniform act | R. 12.9.5 | — |
| Internet / electronic | BP18; R. 18 | — |
| Prior or subsequent history of a case | R. 10.7 | T8 |
| Parallel citation | BP10.1.3; R. 10.3.1 | T1 |
| Explanatory parenthetical (present-participle form) | R. 1.5; R. 10.6.1 | — |
| Introductory signals | BP1.2; R. 1.2 | — |
| Order of authorities within a signal | R. 1.4 | — |
| Quotations (block-quote threshold, alterations, omissions) | BP5; R. 5 | — |
| Abbreviations, numerals, symbols | R. 6 | — |
| Typeface | BP2; R. 2 | — |
| Italicization | R. 7 | — |
| Capitalization in the text | BP8; R. 8 | — |
| Titles of judges and officials | R. 9 | T11 |
| Subdivisions (page, paragraph, section, footnote) | R. 3 | T16 |
| Local citation rules for the filing court | BT2 | — |

## 6. Stage 3 — Form verification

For each citation, apply the rules identified at Stage 2. Record findings rule-by-rule so the Stage 4 report reads as an audit trail rather than a conclusion.

### 6.1 Verification tests (apply only the tests relevant to the citation type)

1. **Required components.** Every component called for by the governing rule is present. For a full case citation under R. 10.1: case name; reporter volume; reporter abbreviation; first page; court designation; year. For a statute under R. 12.3: title; code; section; year or edition of the code. For a treatise under R. 15: author; title; pin-cite; edition (if not the first); year. A missing required component is a Stage 3 finding.
2. **Abbreviations.** Case names per R. 10.2 and T6. Courts per R. 10.4 and T7. Geographical terms per T10. Months per T12. Institutional names in periodical titles per T13. Subdivisions per T16. Publishing terms per T14.
3. **Reporter series and pagination.** Correct reporter series, volume, and page per T1.1 (federal) or T1.3 (states). Reporter series must match the decision date (e.g., F.4th for Federal Reporter decisions issued after the 2021 transition from the Third Series to the Fourth). Public-domain format supplied where a jurisdiction requires it per T1.3.
4. **Court and year.** Court parenthetical matches T1/T7. Year is the decision year for reported cases; for unreported dispositions, the exact date per R. 10.5.
5. **Pin-cite form.** Pin-cite appears immediately after the first page, separated by a comma and a space per R. 3.2. Multi-page pins apply the drop-digits rule of R. 3.2(a). Paragraph, section, or footnote pins use the markers identified in R. 3 and T16.
6. **Short form and *id.***   *Id.* only where the immediately preceding citation is to the same authority and is the only authority in that citation sentence or footnote, per R. 4.1 and R. 10.9. Otherwise a proper short form per R. 10.9. *Supra* restrictions per R. 4.2 (and not available for most primary authority).
7. **Signal.** Introductory signal chosen for the proposition per R. 1.2. (No signal for direct support and quotation; *See* for implicit support; *See also* for additional support; *Cf.* for analogous support; *Contra* and *But see* for contradictory; *But cf.* for analogous contradictory; *See, e.g.,* for representative support; *Accord* for prior authority in agreement; *Compare … with* for comparison; the 22e *contrast* signal per the 22e update to R. 1.2 / BP1.2.) Signal order and grouping within a citation sentence per R. 1.3 and R. 1.4.
8. **Parenthetical.** Explanatory parentheticals follow R. 1.5 (present-participle form where the parenthetical paraphrases the source). Weight-of-authority parentheticals precede explanatory parentheticals per R. 10.6. Prior- and subsequent-history parentheticals placed per R. 10.7. Quoting and citing-back parentheticals placed per R. 10.6.2. The 22e "(citation modified)" parenthetical is permitted per R. 5.3 / BP5.3 for cleaned-up quotations.
9. **Quotations.** Block-quote threshold of 50 or more words per R. 5.1(a). Alterations bracketed per R. 5.2. Omissions shown with ellipses per R. 5.3. Attribution present and correctly formatted. Substantive fidelity of the quotation to the source is not a form rule; the skill flags each quotation for attorney source review and does not treat a substantive mismatch as a form failure.
10. **Prior and subsequent history.** Subsequent history included where R. 10.7 requires it; explanatory phrase drawn from T8; history parenthetical placement per R. 10.7.
11. **Parallel citation.** Where the local rule of the filing jurisdiction or the jurisdiction of the cited decision requires a parallel citation (see T1.3 for states; BT2 for local rules), both citations are present and correctly ordered per R. 10.3.1.
12. **Capitalization.** Capitalization of "Court," "Circuit," "Act," party designations, and federal/state actors in the text per R. 8 and BP8.

### 6.2 Verdict tiers

Apply the tier matching the most severe finding across the applicable tests.

- **✓ CONFORMING** — every applicable test passes. The citation is ready for filing as written.
- **▲ NEEDS CORRECTION** — one or more applicable tests fail in a way that is correctable by a drafting edit without recourse to a new source. Examples: case-name abbreviation missing a word per T6; reporter given as "F.3d" where "F.4th" is required by T1.1 for the decision's date; pin-cite separated by the wrong punctuation; signal italicized where the selected style calls for roman, or vice versa; an explanatory parenthetical that begins with an infinitive rather than a present participle where R. 1.5 calls for a participle. Record the specific rule, the current text, and the corrected text.
- **✗ NON-CONFORMING** — a finding that cannot be resolved by a formatting edit. Examples: required components missing and not available in the draft (e.g., a case cited without reporter, volume, or court); a treatise cited without author or publisher; a quotation attributed but no source text in the record to compare; a string citation so disordered that a full rewrite is needed rather than a re-edit. Record the finding with the controlling rule and the action the attorney must take (re-research, re-source, or rewrite).

### 6.3 Pin-cite format for findings

Every Stage 3 finding carries a pin-cite to the controlling Bluebook rule or table by number. Use these forms:

- `BB R. 10.2.2` — white-pages rule.
- `BB BP10.1.1` — Bluepages rule.
- `BB T6` or `BB T1.1` — table.
- Combined: `BB BP10; R. 10.2.2; T6`.

The attorney consults the Bluebook for the text of the cited rule; the protocol does not reproduce Bluebook text.

## 7. Stage 4 — Verification report

Render the report per `report-template.md`. Produce it as a Microsoft Word `.docx` using the `docx` skill conventions. Mandatory contents:

- Matter and draft identification: caption, docket, court, filing deadline, file name, version, date.
- Style declaration: Bluepages (practitioner) or white-pages (scholarly), as selected at intake.
- Local-rule override: any BT2 local rule applied, identified by jurisdiction and rule number.
- Summary counts and percentages at each tier.
- Non-conforming (✗) citations table: one row per item with citation text, draft location, rule violated, rule pin-cite, and required action.
- Needs-correction (▲) citations table: one row per item with citation text, draft location, rule, pin-cite, current text, and corrected text.
- Conforming (✓) citations appended as Appendix A.
- Aggregate form findings, by category: abbreviations (R. 10.2 / T6; R. 10.4 / T7; T10; T12; T13; T16); reporter, court, and date (R. 10.3, R. 10.4, R. 10.5; T1.1; T1.3); short forms and *id.* (R. 4; R. 10.9); introductory signals and ordering (R. 1.2; R. 1.3; R. 1.4); parentheticals (R. 1.5; R. 10.6); quotation form (R. 5); prior and subsequent history (R. 10.7; T8); parallel citation (R. 10.3.1); capitalization (R. 8; BP8).
- Quotations flagged for attorney source review.
- Corrective-action checklist.

File name: `Citation_Verification_Report_<Matter_Short_Name>_<YYYY-MM-DD>.docx`. Save to the user's working folder. In the chat response, return: (a) the file link, (b) the tier counts, (c) a list of every ✗ item with the rule violated and the required action, (d) a short list of the three highest-frequency ▲ categories (e.g., "T6 abbreviations: 8 items; *id.* overreach: 3 items; signal roman/italics: 2 items") so the drafting attorney can address them as a batch.

## 8. Stage 5 — Drafting sign-off

Produce the one-page sign-off from `checklist-template.md`, completed with the matter-specific detail and the final citation count. This sign-off is retained in the matter file as the contemporaneous record that the Bluebook form-check was performed. It is not filed with the court.

Sign-off is executed only after every ✗ has been resolved (citation removed, re-sourced, or rewritten to conform) and every ▲ has been corrected in the draft and the corrected citation re-run through Stages 1-3.

## 9. Confidentiality handling

The draft is attorney work product. Treat accordingly: do not echo privileged content beyond what verification requires; keep the Stage 1 extraction table stripped of internal strategy commentary; the verification report and sign-off stay in the matter file. If the draft is under seal, confirm before ingestion that the applicable protective order permits transmission to the model's hosting environment.

## 10. Reference example — standard the output must meet

Input: 18-page practitioner-style brief containing 47 citations. Style at intake: Bluepages.

- Stage 1: 47 rows emitted.
- Stage 2: 47 rule-mapping entries emitted, each cross-referenced to governing rules and tables by number.
- Stage 3 findings:
  - ✓ CONFORMING: 44.
  - ▲ NEEDS CORRECTION: 2.
    - §II.B, citation #18: Case name "International Business Machines Corp. v. United States" not abbreviated per R. 10.2.2 and T6. Corrected: "Int'l Bus. Machs. Corp. v. United States." Rule pin-cite: `BB R. 10.2.2; T6`.
    - §IV.A, citation #34: Federal Reporter series given as "F.3d" for a 2023 Second Circuit decision. T1.1 requires "F.4th" for decisions issued after the 2021 transition from the Third Series to the Fourth. Corrected: "F.4th" with the same volume and page. Rule pin-cite: `BB R. 10.3.1; T1.1`.
  - ✗ NON-CONFORMING: 1.
    - §III.C, citation #31: "See Jones v. Smith, at 215." Required components missing: no reporter volume, no reporter abbreviation, no first page, no court, no year. The citation cannot be brought into conformance by a drafting edit; the attorney must re-source the case, extract the required components, and replace the citation under R. 10.1. Rule pin-cite: `BB R. 10.1`.
- Stage 4: report records the three non-clean findings with corrective actions and rule pin-cites.
- Stage 5: after the ▲ items are corrected and the ✗ item is re-sourced and replaced, the drafting sign-off is completed and filed in the matter file.

If the output materially under-delivers against this standard for a comparable draft, the protocol has not been run to completion.

## 11. Maintenance

This protocol is reviewed when a new edition of the Bluebook is issued or at least once per calendar year. At each review the maintainer updates: (a) the edition reference in the YAML frontmatter if a new edition has been released; (b) the rule and table cross-references in Sections 2, 5, and 6 if numbering has changed; (c) the reference example in Section 10 to track any rule changes that affect the worked items; (d) the BT2 references if local citation rules in frequently-encountered jurisdictions have changed.

Prior versions of this protocol are retained; the active version is the one matching the frontmatter.

---

*Licensed under the MIT License. Not legal advice. Use by licensed attorneys and law students. This protocol checks citation form against the 22nd edition of the Bluebook; it does not reproduce Bluebook text, and the attorney must consult the Bluebook directly for rule language. The protocol does not verify the substance of cited authority. Substantive verification — that the cited case exists, remains good law, and says what the draft claims it says — remains the responsibility of the drafting attorney.*
