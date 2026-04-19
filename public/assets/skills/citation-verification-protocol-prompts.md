<!--
PROMPT PACK — CITATION VERIFICATION PROTOCOL (BLUEBOOK 22e FORM-CHECK)
Five chained prompts for running the protocol against any chat model.
Paste each prompt in turn. Each prompt assumes the previous prompt's output
is still in context. The attorney consults the Bluebook 22e directly for
the text of any rule; the model identifies rules by number.

Licensed MIT. Reviewed annually or upon issuance of a new Bluebook edition.
-->

# PROMPT PACK — CITATION VERIFICATION PROTOCOL

**Protocol:** Citation Verification Protocol v1.1.0
**Edition covered:** Bluebook 22nd Edition
**Authority:** *The Bluebook: A Uniform System of Citation* (22nd ed. 2025)
**License:** MIT
**Use:** Paste the prompts in order. Attach the draft at Prompt 1. The attorney must have independent access to the Bluebook 22e to audit any finding against the source text; the model identifies rules by number and does not reproduce Bluebook text.

---

## Session setup (before Prompt 1)

Paste:

```
You are a Bluebook 22e citation form-checker. You will follow a five-stage
protocol: (1) extract, (2) rule-map, (3) form-verify, (4) report, (5) sign-off.
Your authority is the Twenty-Second Edition of The Bluebook: A Uniform
System of Citation (2025). Do not reproduce Bluebook text. Identify each
rule by number using these pin-cite forms:
    - White-pages rule:  BB R. 10.2.2
    - Bluepages rule:    BB BP10.1.1
    - Table:             BB T6  or  BB T1.1
    - Combined:          BB BP10; R. 10.2.2; T6
The attorney consults the Bluebook for rule text. You are checking Bluebook
form only — not whether cited authorities exist, remain good law, or
support the propositions cited. Wait for the draft before starting Stage 1.
```

---

## Prompt 1 — Extraction

```
STAGE 1 — EXTRACTION

I am attaching a legal filing draft. Before doing anything else, confirm:

    Style to apply:
        [ ] Bluepages (practitioner filing — BP rules govern)
        [ ] White-pages (scholarly writing — Rules 1-23 govern)

    Local court rule override (if any):
        Filing court: _______
        Local citation rule: _______  (consult BB BT2)

Then extract every instance of citable authority. Include:
- cases (including short forms, id., and supra)
- constitutions, statutes, regulations, rules of procedure, rules of evidence
- administrative materials
- secondary sources (treatises, law review articles, Restatements, ALR, etc.)
- court documents and record materials
- legislative materials

Do NOT deduplicate. Each pin-cite location is its own row, even if the
authority has already been cited earlier in the draft.

Return a numbered table with these columns:

    # | Citation text as it appears | Page / section of draft |
    Citation type | Pin-cite | Signal (if any) | Parenthetical (if any) |
    Short form / id. / supra (yes/no) | Notes

After the table, confirm:
- Total citation count: ___
- Style selected: ___
- Local-rule override (if any): ___
- Any authority you were unable to classify as a citation type: ___

Do not apply any form rules yet. This stage is extraction only.
```

---

## Prompt 2 — Rule mapping

```
STAGE 2 — RULE MAPPING

For each numbered citation in the Stage 1 table, identify:

1. The governing Bluebook rule(s) — Bluepages (BP) rule for practitioner
   filings; white-pages rule (R.) for scholarly writing; cite both where
   the Bluepages rule refers out to the white-pages rule.
2. The tables that apply — any of T1, T6, T7, T8, T10, T12, T13, T14,
   T16, or BT2.
3. Any local court rule override that displaces Bluebook 22e for this
   citation type.

Return a table:

    # | Citation | Citation type | Governing rule(s) | Relevant tables |
    Pin-cite

Pin-cite format:
    BB R. 10.2.2           (white-pages)
    BB BP10.1.1            (Bluepages)
    BB T6  or  BB T1.1     (table)
    BB BP10; R. 10.2.2; T6 (combined)

Standard mappings, as a starting reference (non-exhaustive; apply the
citation type's governing rule even if omitted here):

    Full case citation             BP10; R. 10     T1; T6; T7; T8
    Short-form case / id.          BP10.2; R. 4; R. 10.9
    Supra                          R. 4.2
    Federal statute                BP12; R. 12     T1.1
    State statute                  BP12; R. 12     T1.3
    Session laws                   R. 12.4         T1
    Constitution                   BP11; R. 11     T1
    Federal regulation             BP14; R. 14     T1.1
    Legislative materials          BP13; R. 13     T9
    Admin materials                BP14; R. 14     T1
    Court & litigation documents   BP7; R. 3; BT1
    Book / treatise                BP15; R. 15     T6
    Law-review article             BP16; R. 16     T13; T14
    Restatement / uniform act      R. 12.9.5
    Internet / electronic          BP18; R. 18
    Prior / subsequent history     R. 10.7         T8
    Parallel citation              BP10.1.3; R. 10.3.1   T1; BT2
    Signals                        BP1.2; R. 1.2
    Order within signal            R. 1.3; R. 1.4
    Parentheticals                 R. 1.5; R. 10.6
    Quotations                     BP5; R. 5
    Subdivisions                   R. 3            T16
    Capitalization                 BP8; R. 8

After the table, list any citations whose type you cannot confidently map
to a governing rule, and explain the ambiguity.

Do not apply the tests yet. This stage is mapping only.
```

---

## Prompt 3 — Form verification

```
STAGE 3 — FORM VERIFICATION

For each citation, apply the applicable Stage 3 tests. Some tests do not
apply to every citation type; mark those N/A.

The twelve tests:

  1. Required components  — every component called for by the governing
     rule is present. For cases: R. 10.1 (case name; reporter volume;
     reporter abbreviation; first page; court; year). For statutes:
     R. 12.3 (title; code; section; year or edition). For books: R. 15
     (author; title; pin-cite; edition; year). For periodicals: R. 16.
  2. Abbreviations  — party names, institutional authors, reporters,
     courts, geographical terms, months, institutional names in
     periodicals, publishing terms, and subdivisions follow R. 10.2 / T6;
     R. 10.4 / T7; T10; T12; T13; T14; T16.
  3. Reporter series and pagination  — reporter series is correct for the
     deciding court and date (including the F.3d → F.4th transition for
     post-2021 Federal Reporter decisions); pagination in proper form
     (R. 10.3; T1.1; T1.3).
  4. Court and year  — court parenthetical and year placement follow
     R. 10.4 and R. 10.5 (decision year for reported cases; exact date
     for unreported dispositions).
  5. Pin-cite  — pin-cite in proper form for the source type (R. 3; R. 3.2
     for spans and drop-digits; T16 for subdivisions; R. 15 for book
     pin-cites; R. 16 for article pin-cites; R. 3.3 for footnotes).
  6. Short form and id.  — short-form and id. usage follows R. 4 and
     R. 10.9; supra restrictions per R. 4.2.
  7. Introductory signal  — any signal is one authorized by R. 1.2 and
     BP1.2 (no signal; See; See also; Cf.; Contra; But see; But cf.;
     See, e.g.; Accord; Compare … with; the 22e contrast signal), used
     for its correct purpose, ordered within its strength group per
     R. 1.3, and grouped with the correct punctuation per R. 1.4.
  8. Parenthetical  — explanatory parentheticals follow R. 1.5 (present-
     participle form where the parenthetical paraphrases the source);
     weight-of-authority and case-history parentheticals per R. 10.6 and
     R. 10.7; the 22e "(citation modified)" parenthetical per R. 5.3 /
     BP5.3 for cleaned-up quotations.
  9. Quotation form  — block-quote threshold of 50 or more words per
     R. 5.1(a); alterations bracketed per R. 5.2; omissions shown with
     ellipses per R. 5.3; attribution present and correctly formatted.
     (Substantive fidelity of the quotation to the source is flagged
     separately for attorney review and is not treated as a form failure.)
 10. Prior and subsequent history  — any prior or subsequent history
     parenthetical is present where required, and uses the explanatory
     phrases of T8 (R. 10.7).
 11. Parallel citation  — parallel citation supplied where the governing
     jurisdiction or the filing court's local rule requires it
     (R. 10.3.1; T1.3; BT2).
 12. Capitalization in the text  — "Court," "Act," "Circuit," party
     designations, and federal/state actors capitalized per R. 8 and BP8.

Assign a tier to each citation:

    ✓ CONFORMING — all applicable tests pass
    ▲ NEEDS CORRECTION — the citation is traceable to a verifiable
      authority but one or more tests fail; correction is achievable by a
      drafting edit
    ✗ NON-CONFORMING — the citation fails a required-components test or
      otherwise cannot be cured by a drafting edit (re-source, rewrite,
      or remove)

Return a table with columns:

    # | Citation | Type | Tier | Components | Abbrev | Reporter | Court/Yr |
    Pin | Short/id. | Signal | Parenth. | Quote | History | Parallel | Caps |
    Finding | Required action | Pin-cite (BB R./BP/T)

For every test marked ▲ or ✗, write the finding in plain language and
provide the rule pin-cite. For quotation form (test 9), flag any quotation
for which substantive fidelity to the source should be reviewed by the
drafting attorney; that flag is recorded separately and is not itself a
form failure.

After the table, provide tier counts:

    ✓ ___   ▲ ___   ✗ ___   Total ___
```

---

## Prompt 4 — Report

```
STAGE 4 — REPORT

Generate a form-check report in the following structure. Fill every field
from the prior stages. If a section has no entries, say so explicitly.

  1. Summary (tier counts)
  2. Non-conforming citations (✗) — one row each: citation, location,
     rule(s) violated, pin-cite, failure finding, required action
  3. Citations needing correction (▲) — one row each: citation, location,
     rule(s) implicated, pin-cite, finding, corrected form
  4. Conforming citations (✓) — count only; full table in Appendix A
  5. Aggregate form findings, by category:
       5.1 Abbreviations (R. 10.2 / T6; R. 10.4 / T7; T10; T12; T13;
           T14; T16)
       5.2 Reporter, court, and date (R. 10.3; R. 10.4; R. 10.5;
           T1.1; T1.3)
       5.3 Short forms and id. (R. 4; R. 10.9)
       5.4 Introductory signals and ordering (R. 1.2; R. 1.3; R. 1.4;
           BP1.2)
       5.5 Parentheticals (R. 1.5; R. 10.6)
       5.6 Quotations (R. 5)
       5.7 Prior and subsequent history (R. 10.7; T8)
       5.8 Capitalization in the text (R. 8; BP8)
  6. Quotations flagged for attorney source review
  7. Corrective-action checklist
  8. Items requiring senior-counsel attention
  9. Drafting sign-off (signature block only; language lives on the back
     of checklist-template.md)
  Appendix A — Per-citation verification table (all ✓ / ▲ / ✗ with every
     applicable test marked)
  Appendix B — Rule-map log (pin-cites to BB R./BP/T)

Use the format in report-template.md. Return the complete report as
Markdown ready for rendering to .docx.
```

---

## Prompt 5 — Drafting sign-off

```
STAGE 5 — DRAFTING SIGN-OFF

Output the printable one-page Bluebook form-check checklist (front) and
drafting sign-off (back). This is executed after every ✗ is resolved and
every ▲ is corrected and re-verified.

The sign-off confirms that the form of the citations in the document has
been verified against the Twenty-Second Edition of The Bluebook, and
specifically that:

  1. Every citation in the document was extracted and identified.
  2. Each citation was mapped to the governing Bluepages or white-pages
     rule and any applicable tables.
  3. Each citation was evaluated against the Stage 3 tests that apply to
     its type: required components (R. 10.1 for cases; R. 12.3 for
     statutes; R. 15 for books; R. 16 for periodicals); abbreviations
     (R. 10.2 / T6, R. 10.4 / T7, T10, T12, T13, T14, T16); reporter
     series and pagination (R. 10.3; T1.1; T1.3); court and year
     (R. 10.4, R. 10.5); pin-cite form (R. 3; R. 3.2); short-form and
     id. (R. 4; R. 10.9); introductory signals and ordering (R. 1.2,
     R. 1.3, R. 1.4); parentheticals (R. 1.5; R. 10.6); quotations
     (R. 5); prior and subsequent history (R. 10.7; T8); parallel
     citation (R. 10.3.1; BT2); capitalization (R. 8; BP8).
  4. Local citation rules of the filing court were consulted (BT2) and
     applied where they depart from Bluebook 22e.
  5. Every ▲ has been corrected and re-verified.
  6. Every ✗ has been re-sourced, rewritten, or removed, and any
     replacement re-run through Stages 1-3.
  7. Quotations have been compared against source text, or flagged for
     attorney source review and reconciled before signature.
  8. Any AI tool-assistance log has been completed and retained in the
     matter file.

Include:
- Matter, caption, docket, court, document being filed, filing date
- Style applied (Bluepages / white-pages)
- Local-rule override (if any)
- Tier results at close: ✓ ___   ▲ 0   ✗ 0
- Drafting / supervising attorney signature block
- Verifying attorney signature block (if different)
- The advisory line: "Retain in the matter file. This sign-off records
  form-checking only; it does not attest to the substantive accuracy of
  any authority cited in the filing."
```

---

## Printable one-page checklist (inline)

*Reproduced here so the pack is usable standalone. Print duplex. Complete in ink. File in the matter file with the final draft.*

### CITATION FORM-CHECK CHECKLIST — Bluebook 22nd Edition

**Protocol:** Citation Verification Protocol v1.1.0 · MIT-licensed · Reviewed annually
**Authority:** *The Bluebook: A Uniform System of Citation* (22nd ed. 2025)
**Style selected:** ☐ Bluepages (practitioner) ☐ White-pages (scholarly)
**Local rule override (if any):** ______________________________ *(BT2 / local court rule)*

**Matter:** _________________________________________________
**Caption / docket:** ______________________________________
**Court & filing deadline:** ______________________________
**Draft file name + version:** ____________________________
**Drafting attorney:** ____________________________________
**Verifying attorney:** ___________________________________
**Date form-check commenced:** ____________________________

---

**FRONT — Stage-by-stage checklist**

*Stage 1 — Extraction*

- [ ] Every instance of citable authority extracted (cases, statutes, regs, rules, secondary, court documents, legislative history)
- [ ] No deduplication — each pin-cite location has its own row
- [ ] Extraction table total count confirmed: **___**
- [ ] Style determination confirmed at intake
- [ ] Local court rule (BT2) consulted; any override recorded
- [ ] Sealed / PO-designated material confirmed permissible for model processing

*Stage 2 — Rule mapping*

- [ ] Governing Bluebook rule identified for every citation (BP or R.)
- [ ] Relevant tables noted (T1, T6, T7, T8, T10, T12, T13, T14, T16, BT2)
- [ ] Local-rule override applied where applicable

*Stage 3 — Form verification (applicable tests per citation type)*

For each citation, verifying attorney initials each test that passes.

| # | Components | Abbrev. | Reporter | Court/Yr | Pin | Short/*id.* | Signal | Parenth. | Quote | History | Parallel | Caps |
|---|------------|---------|----------|----------|-----|-------------|--------|----------|-------|---------|----------|------|
| 1 |            |         |          |          |     |             |        |          |       |         |          |      |
| 2 |            |         |          |          |     |             |        |          |       |         |          |      |
| 3 |            |         |          |          |     |             |        |          |       |         |          |      |

- [ ] Every citation tiered ✓ / ▲ / ✗
- [ ] Every ▲ corrected in the draft and re-verified
- [ ] Every ✗ re-sourced, rewritten, or removed, and the replacement run through Stages 1-3
- [ ] Quotations flagged for attorney source review reconciled

*Stage 4 — Report*

- [ ] Verification report (`.docx`) generated and filed in the matter file
- [ ] Initial tier counts: ✓ **___**   ▲ **___**   ✗ **___**
- [ ] Post-correction tier counts: ✓ **___**   ▲ 0   ✗ 0

*Stage 5 — Sign-off*

- [ ] Back-side sign-off completed
- [ ] Filed in matter file
- [ ] Bluebook edition and skill run log retained

---

**BACK — Drafting sign-off**

Matter: ___________________________________________________

Caption: _________________________________________________

Docket number: ___________________________________________

Court: ___________________________________________________

Document being filed: ____________________________________

Filing date: _____________________________________________

The undersigned confirms that the form of the citations in the above-identified document has been verified against the Twenty-Second Edition of *The Bluebook: A Uniform System of Citation*, and specifically:

1. Every citation in the document was extracted and identified.
2. Each citation was mapped to the governing Bluepages or white-pages rule and any applicable tables.
3. Each citation was evaluated against the applicable Stage 3 tests.
4. Local citation rules of the filing court were consulted (BT2) and applied where they depart from Bluebook 22e.
5. Every ▲ has been corrected and re-verified.
6. Every ✗ has been re-sourced, rewritten, or removed, and any replacement re-run through Stages 1-3.
7. Quotations have been compared against source text, or flagged for attorney source review and reconciled before signature.
8. The tool-assistance log (if any AI tool was used in drafting) has been completed and retained in the matter file.

**Style applied:** ☐ Bluepages (practitioner) ☐ White-pages (scholarly)

**Tier results at close:**   ✓ _____   ▲ 0   ✗ 0

Drafting / supervising attorney:

Name (print): ____________________________________________

Bar number / jurisdiction: ________________________________

Signature: _______________________________________________

Date: ____________________________________________________

Verifying attorney (if different):

Name (print): ____________________________________________

Signature: _______________________________________________

Date: ____________________________________________________

---

*Retain in the matter file. This sign-off records form-checking only; it does not attest to the substantive accuracy of any authority cited in the filing.*

---

## Reference example (for calibration)

A draft with 47 citations, in which the verifier plants three known-faulty items, should surface:

- **✓ 44 conforming.**
- **▲ 2 needing correction.** Example items:
    1. "*International Business Machines Corp. v. Papermaster*, 2008 WL 4974508 (S.D.N.Y. 2008)" — party abbreviation incorrect under `BB R. 10.2.2; T6`; corrected form is "*Int'l Bus. Machs. Corp. v. Papermaster*, 2008 WL 4974508 (S.D.N.Y. 2008)."
    2. Case decided in 2023 cited as "*Smith v. Jones*, 45 F.3d 212 (2d Cir. 2023)" — reporter series incorrect for date under `BB R. 10.3.1; T1.1`; corrected form is "45 F.4th 212."
- **✗ 1 non-conforming.** Example item: "*See Jones v. Smith*, at 215." — missing required components (volume, reporter, court, year) under `BB R. 10.1`; cannot be cured by a drafting edit; re-source, rewrite, or remove.

A run that does not detect each planted deviation has failed; rerun the protocol.

---

*Protocol version 1.1.0 · MIT-licensed · Reviewed annually or upon issuance of a new Bluebook edition. The attorney consults the Bluebook directly for rule text; this pack does not reproduce Bluebook language.*
