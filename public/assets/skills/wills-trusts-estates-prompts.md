# Prompt Pack — Wills, Trusts & Estates (Generic)

Paste-ready prompts for use in any general-purpose LLM when a skill-execution host is not available. These prompts mirror the skill's three-phase workflow. Run them in order.

**Important.** These prompts are for licensed attorneys only. Every output must be reviewed, edited, and adopted by attorney counsel of record. The prompts do not create attorney-client relationships, do not provide legal advice, and do not substitute for attorney judgment.

---

## Prompt 0 — Ethics gate

Run this first. Do not proceed to Prompt 1 unless each answer is affirmative.

```
I am using an AI tool to assist with drafting an estate planning package. Before I proceed, I need to confirm five gate questions. Please list the five questions from Section 0 of the wills-trusts-estates intake below (ABA Formal Opinion 512 AI-consent, conflicts, gifts-to-drafter, drafter-as-fiduciary, paper-execution scope), and ask me to answer each one explicitly before we continue. If any answer is no or uncertain, pause and tell me what to resolve before we start drafting.

The five gates:
1. Is the attorney using this tool acting as counsel of record for the client?
2. Has the client been advised in writing that the attorney uses generative AI tools in the representation, and has the client provided informed written consent (per ABA Formal Opinion 512 (July 29, 2024) and any state-bar analog)?
3. Any actual or potential conflict of interest disclosed and consented to?
4. Is the drafting attorney (or firm member, or a person related within the degrees of ABA Model Rule 1.8(c)) named as beneficiary or compensated fiduciary? If yes, has the governing jurisdiction's disclosure/acknowledgment requirement been or will be satisfied?
5. Is this package for in-person, paper execution? (Electronic wills and remote online notarization are out of scope.)
```

---

## Prompt 1 — Intake

```
I am drafting a complete estate planning package. Please interview me using the structured intake below. Ask one section at a time. Do not move to the next section until I have answered every Required field in the current section. Where my answer is uncertain, record it as "[TO BE CONFIRMED: short description]" and move on.

Intake sections:

Section 1 — Client identity and jurisdiction.
  Required: client's full legal name; spouse's name if applicable; dates of birth; mailing address; state of domicile; citizenship.
  Optional: prior states of domicile with instruments on file.

Section 2 — Family.
  Required: marital status, date and state of marriage if applicable; prior marriages and their dissolution dates; children (names, DOB, special needs, parent, biological/adopted).
  Optional: grandchildren; stepchildren or similar non-biological dependents; persons to disinherit.

Section 3 — Assets and liabilities.
  Required: approximate total net worth bracket; real property addresses and titling (flag any homestead); brokerage accounts; retirement accounts (type, institution, beneficiaries); life insurance.
  Optional: business interests; significant tangible personal property; digital assets; liabilities.

Section 4 — Fiduciary nominees. (Primary plus at least one alternate per role.)
  Required: trustee of the revocable trust; personal representative of the pour-over will; DPOA agent; health care agent.
  Required if minor children: guardian of the person and guardian of the property.
  Optional: preneed/standby guardian (jurisdiction-dependent).

Section 5 — Dispositive plan.
  Required: residuary disposition at death (to spouse outright, to marital trust, to descendants per stirpes, to continuing trusts, etc.); any trusts for descendants and their terms; any trustee removal powers; any disinheritance contingencies.
  Optional: specific devises; charitable dispositions; tangible-property memorandum.

Section 6 — Tax planning.
  Required if net worth over $2M: federal estate-tax planning status; portability election; any lifetime gifting reducing unified credit.
  Optional: state estate/inheritance tax; GST; charitable-deduction strategy; post-SECURE Act retirement-account beneficiary analysis; basis planning (community property / CP-trust for married couples in recognizing states).

Section 7 — Contingencies.
  Required: common disaster rule; anti-lapse default acceptance/override; spendthrift confirmation.
  Optional: contest/in-terrorem clause; special-needs sub-trust; pet-care trust.

Section 8 — Administrative.
  Required: where original documents will be held; signing location; urgency factors.
  Optional: prior wills/trusts to be revoked and any coordination needed.

Section 9 — Closing.
  Required: attorney's affirmation of capacity-at-intake; attorney's affirmation of no red flags of undue influence.
  Optional: free text.

When all required fields are answered, return a one-paragraph intake summary and wait for me to proceed to Prompt 2.
```

---

## Prompt 2 — Jurisdictional checklist

```
Before drafting, I need to load the jurisdictional checklist for the governing state identified at intake. I will paste the filled-in checklist below. If any section is blank, stop and tell me before drafting.

[PASTE YOUR FILLED-IN jurisdictional-checklist-<STATE>.md CONTENT HERE]

Once loaded, confirm the following key state-specific items are populated:
- Wills: execution formalities, self-proving affidavit form.
- Wills: elective share rule and percentage.
- Wills: homestead restrictions (if any).
- Wills: pretermitted spouse and pretermitted child rules.
- Wills: slayer and abuser-forfeiture statutes.
- Wills: divorce-revocation rule.
- Wills: custodian's duty to deposit original.
- Wills: drafter-as-PR and drafter-as-trustee acknowledgment forms (if any).
- DPOA: statutory warning text (verbatim).
- DPOA: UPOAA adoption status; springing DPOA availability.
- DPOA: specific-grant authorities (gifts, survivorship, beneficiary changes, trust creation/amendment).
- Advance directive: statutory form name and text.
- Advance directive: witness and notary requirements; agent disqualifications.
- Living will: pregnancy limitation (if any); statutory form.
- Guardian declaration: availability, scope, court-confirmation rule.

Report back which items are populated and which are missing. Do not draft against missing items.
```

---

## Prompt 3 — Drafting

```
Now draft the six-document package using the structural outlines below. Insert intake facts where applicable. Insert "[TO BE CONFIRMED: description]" placeholders wherever intake left a field open. Do not improvise state-specific substance — pull every state-specific provision from the jurisdictional checklist. Do not copy verbatim from any prior work product.

For each document, use the article or section order given in document-structures.md. At the end of each document, produce a short execution-formalities memo specific to that document in the governing state.

Produce in order:
1. Revocable Living Trust.
2. Pour-Over Last Will and Testament.
3. Durable Power of Attorney.
4. Advance Directive for Health Care.
5. Living Will / Declaration of Life-Prolonging Procedures.
6. Standby / Preneed Guardian Declaration (only if the checklist authorizes a standalone declaration for this state).

Use consistent defined terms (Grantor, Testator, Principal, Declarant; Trustee, Personal Representative, Agent, Health Care Agent, Guardian) throughout each document. Do not alternate or combine.

For a married couple, produce mirror-image packages — one for each spouse — and coordinate fiduciary nominees, dispositive provisions, and cross-references.

When done, produce (a) a list of all bracketed placeholders still outstanding and (b) a jurisdictional-compliance checklist for the entire package showing the status of each item from the state checklist.
```

---

## Prompt 4 — Sanity pass

Run this after Prompt 3 to catch the most common drafting defects. It does not replace attorney review.

```
Review the drafts produced in the last response against the following checklist. Report any issues, citing document and article/section number.

Defined terms:
- Is the client referred to consistently (Grantor/Testator/Principal/Declarant) within each document?
- Is each fiduciary role identifier consistent within each document?

Cross-document coordination:
- Is each fiduciary named with identical full legal name and address across every document?
- Is the primary/alternate ordering consistent for nominees who hold the same role in multiple documents?
- Do the pour-over will's references to the revocable trust resolve correctly (article and section numbers)?

State-specific:
- Does the DPOA's statutory warning text match the verbatim text from the jurisdictional checklist?
- Does the advance directive use the state-preferred term for the document and the agent?
- Are state-required execution formalities reflected accurately in each execution memo?
- Are forfeiture-hook recitals present in every document that references descendants or beneficiaries?

Placeholders:
- Is every bracketed placeholder still plausibly resolvable by the attorney before signing? Any that looks unresolvable should be flagged.

If there are no issues, return CLEAN. Otherwise, return a bulleted list of issues with document and section references.
```

---

## Usage notes

- **Paste intake responses, not a file.** These prompts expect you to answer in the chat. If you have a completed intake document, paste it under "[PASTE YOUR INTAKE]" and say "parse this against the required-field checklist."
- **State checklist is not optional.** The skill's design depends on the adopter populating a state-specific checklist before drafting. A prompt-only run without a filled-in checklist will produce drafts that look complete but will miss jurisdictional substance. Do not take drafts produced without a state checklist to signing.
- **Long conversations.** Drafting all six documents in one response exceeds many models' context budgets. If the model truncates, continue by document: "Continue with the pour-over will." The structural outlines are self-contained per document.
- **Firm boilerplate.** This prompt pack does not supply a firm boilerplate library. If you have one, paste the relevant clauses into Prompt 3 with the instruction "Use these boilerplate clauses exactly as written in [list articles]."

---

## License

MIT. See `README.md`.
