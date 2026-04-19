# AI-Use Disclosure Rider — Prompt Pack

This prompt pack lets any chat model — with or without the Claude Skills infrastructure — produce the same outputs as the AI-Use Disclosure Rider skill: a regional rider (US, UK, or EU), a 150-word plain-English client summary, and a redline-ready side-by-side if an engagement letter is supplied.

Run the prompts in order. Each prompt's output is the next prompt's input. The three regional templates are reproduced inline at the foot of this file so a single pass through the pack can produce a complete deliverable in one session with no file attachments.

MIT-licensed. Reviewed April 2026.

---

## Prompt 1 — Intake

> You are assisting a law firm with the preparation of an AI-use disclosure rider to its engagement letter. Collect the following nine intake fields from me in a single numbered list. For each field, tell me what the field is for, what a typical value looks like, and what happens if I do not know the answer. Do not default-fill any field.
>
> 1. `firm_name` — the legal name of the firm.
> 2. `jurisdiction` — one of `US`, `UK`, or `EU`. If more than one applies (e.g., a US firm with an EU client under GDPR), note that and produce a separate rider for each.
> 3. `state_or_member_state` — for `US`, the state whose ethics rules govern; for `EU`, the Member State of engagement; for `UK`, "England and Wales" unless otherwise specified.
> 4. `ai_vendors` — each vendor name and product tier (e.g., "OpenAI ChatGPT Enterprise," "Anthropic Claude for Work," "Microsoft 365 Copilot").
> 5. `retention_period` — how long prompts and outputs are retained before deletion (calendar days or months).
> 6. `training_data` — whether client data is used to train third-party models. If the firm has not confirmed this against its vendor contracts, STOP. Do not guess.
> 7. `opt_out_mechanism` — typically a signed writing to the responsible attorney.
> 8. `fee_treatment` — one of: `no_charge`; `efficiency_discount`; `cost_passthrough`; `hybrid`. Produce a short prose paragraph describing the chosen treatment.
> 9. `effective_date`, `responsible_attorney`, `responsible_attorney_title`, `responsible_attorney_email`, `responsible_attorney_phone`, `client_name`, `engagement_letter_date`.
>
> Confirm each field back to me before proceeding. Do not move on until every field is either answered or explicitly marked "NOT KNOWN — STOP."

## Prompt 2 — Generation

> Using the intake fields confirmed in Prompt 1, draft the AI-use disclosure rider for the selected `jurisdiction`. Use the regional template reproduced at the foot of this prompt pack — `rider-us-template.md` for `US`, `rider-uk-template.md` for `UK`, or `rider-eu-template.md` for `EU`. Substitute every `{placeholder}` with the corresponding intake value. Do not leave any placeholder un-substituted. Do not modify the four anchor sentences in Article 1. In the UK template, the word "attorney" in the anchor sentences is replaced with "solicitor or other authorised lawyer"; in the EU template, with "lawyer."
>
> If any placeholder lacks a value, stop and ask. Do not guess. In particular, do not default-fill the training_data paragraph in §5 — the firm must have confirmed the training position against its vendor contracts before the rider goes to the client.
>
> Deliver the rider as Markdown. Preserve the heading hierarchy and the signature block at the foot.

## Prompt 3 — Summary and side-by-side

> Using the rider produced in Prompt 2 and the intake fields from Prompt 1, produce two additional artifacts:
>
> 1. The 150-word plain-English client summary, using the `client-summary-template.md` reproduced at the foot of this prompt pack. Word count is approximate; the four anchor sentences in the "What this means for you" paragraph are verbatim.
> 2. A redline-ready side-by-side of the engagement letter and the rider, if I supply the engagement letter text. If I do not supply it, deliver the rider and the summary standalone and note that the side-by-side is not produced.
>
> Deliver all artifacts as Markdown, in this order: the rider, the client summary, the side-by-side (if produced). At the end, flag any intake field that was answered as "NOT KNOWN — STOP" so the drafting attorney can resolve it before the rider is sent.

---

## Reference template — `rider-us-template.md`

```markdown
# RIDER TO ENGAGEMENT LETTER — USE OF GENERATIVE ARTIFICIAL INTELLIGENCE

**Firm:** {firm_name}
**Client:** {client_name}
**Engagement letter dated:** {engagement_letter_date}
**Rider effective date:** {effective_date}
**Governing jurisdiction:** {state_or_member_state}

This Rider forms part of the engagement letter between {firm_name} and {client_name} dated {engagement_letter_date}.

## 1. Scope of disclosure

In representing you, {firm_name} may use generative AI tools to assist with research, drafting, and document review. A qualified attorney reviews and is responsible for all work product before it leaves this office.

- No client data is used to train third-party models.
- Prompts and outputs are retained per §5 below.
- You may opt out at any time in writing.

This disclosure is made consistently with ABA Model Rules 1.1 (and Comment [8]), 1.3, 1.4, 1.5, 1.6, and 5.3, and with ABA Formal Opinion 512 (July 29, 2024).

## 2. AI tools used by the Firm

{ai_vendors_list}

## 3. Categories of use

Legal research (with attorney verification of each authority cited); drafting support (first drafts reviewed, revised, and adopted by a responsible attorney); document review and summarization; administrative work product. The Firm does not use generative AI to make final strategic decisions, to execute filings, or to transmit client-facing communications without attorney review.

## 4. Human oversight and responsibility

A qualified attorney reviews and is responsible for all work product before it leaves the Firm. The attorney verifies every authority cited and every factual assertion. The use of a generative AI tool does not reduce the attorney's responsibility under Model Rules 1.1, 1.3, and 5.3.

## 5. Confidentiality and data handling

Client-confidential information is transmitted only to tools procured under enterprise-grade contracts that (i) do not train on client data, (ii) provide encryption in transit and at rest, and (iii) segregate the Firm's tenant. No client data is used to train third-party models. Prompts and outputs are retained for {retention_period} and then deleted, subject to any applicable litigation hold. This is consistent with Model Rule 1.6.

## 6. Fees

{fee_treatment_paragraph}

## 7. Client opt-out

The Client may instruct the Firm, at any time and without penalty, to cease using generative AI tools. Opt-out takes effect upon receipt by the responsible attorney and is confirmed in writing within three business days.

## 8. Updates

Material changes (new tool, new data-handling practice, new retention period) are communicated to the Client before they take effect.

## 9. Questions and contact

{responsible_attorney}, {responsible_attorney_title}, {firm_name}. {responsible_attorney_email}. {responsible_attorney_phone}.

## 10. Acknowledgment

[signature block for Firm and Client; effective {effective_date}]
```

## Reference template — `rider-uk-template.md`

```markdown
# CLIENT CARE LETTER SUPPLEMENT — USE OF GENERATIVE ARTIFICIAL INTELLIGENCE

**Firm:** {firm_name}
**Client:** {client_name}
**Client care letter dated:** {engagement_letter_date}
**Supplement effective date:** {effective_date}

This supplement forms part of the client care letter between {firm_name} and {client_name} dated {engagement_letter_date}.

## 1. Scope of disclosure

In representing you, {firm_name} may use generative AI tools to assist with research, drafting, and document review. A qualified solicitor or other authorised lawyer reviews and is responsible for all work product before it leaves this office.

- No client data is used to train third-party models.
- Prompts and outputs are retained per §5 below.
- You may opt out at any time in writing.

This disclosure is made consistently with SRA Principles 2, 5, and 7; the SRA Code of Conduct for Solicitors, RELs and RFLs (Paragraphs 3.2-3.3, 6.3, 7.1); the SRA Risk Outlook guidance on AI; the Data Protection Act 2018; and the UK GDPR.

## 2. AI tools used by the Firm

{ai_vendors_list}

## 3. Categories of use

Legal research (with solicitor verification of each authority cited); drafting support (first drafts reviewed, revised, and adopted); document review and summarisation; administrative work product. The Firm does not use generative AI for final strategic decisions, filings, or client-facing communications without solicitor review.

## 4. Competence and supervision

A qualified solicitor reviews and is responsible for all work product. The Firm maintains training and supervision consistent with Paragraphs 3.2-3.3 and 3.5 of the SRA Code of Conduct.

## 5. Confidentiality and data protection

Client-confidential information is transmitted only to enterprise-grade tools that do not train on client data, that encrypt in transit and at rest, and that segregate the Firm's tenant. No client data is used to train third-party models. Prompts and outputs are retained for {retention_period} and then deleted, subject to any applicable professional or regulatory hold. Where the use amounts to processing of personal data, the Firm acts as controller, and has completed or updated a DPIA before deployment on client matters. This is consistent with the Data Protection Act 2018 and the UK GDPR.

## 6. Fees

{fee_treatment_paragraph}

## 7. Client opt-out

The Client may instruct the Firm, at any time and without penalty, to cease using generative AI tools. Opt-out takes effect upon receipt by the responsible solicitor and is confirmed in writing within three working days.

## 8. Updates

Material changes are communicated in writing before they take effect.

## 9. Questions and complaints

{responsible_attorney}, {responsible_attorney_title}, {firm_name}. {responsible_attorney_email}. {responsible_attorney_phone}. The Firm's complaints procedure remains available, as does the Legal Ombudsman and the Solicitors Regulation Authority.

## 10. Acknowledgment

[signature block for Firm and Client; effective {effective_date}]
```

## Reference template — `rider-eu-template.md`

```markdown
# ANNEX TO ENGAGEMENT LETTER — USE OF GENERATIVE ARTIFICIAL INTELLIGENCE

**Firm:** {firm_name}
**Client:** {client_name}
**Engagement letter dated:** {engagement_letter_date}
**Annex effective date:** {effective_date}
**Member State of engagement:** {state_or_member_state}

This Annex forms part of the engagement letter between {firm_name} and {client_name} dated {engagement_letter_date}.

## 1. Scope of disclosure

In representing you, {firm_name} may use generative AI tools to assist with research, drafting, and document review. A qualified lawyer reviews and is responsible for all work product before it leaves this office.

- No client data is used to train third-party models.
- Prompts and outputs are retained per §5 below.
- You may opt out at any time in writing.

This disclosure is made consistently with Regulation (EU) 2024/1689 (the EU AI Act), in particular Articles 4 and 50; Regulation (EU) 2016/679 (GDPR), in particular Articles 6, 9, 13-15, and 22; the CCBE guidance on the use of AI by European lawyers; and the professional-conduct rules of the bar of {state_or_member_state}.

## 2. AI tools used by the Firm

{ai_vendors_list}

## 3. Categories of use

Legal research (with lawyer verification); drafting support (reviewed and adopted by a responsible lawyer); document review and summarisation; administrative work product. The Firm does not deploy on Client matters AI systems classified as high-risk under the EU AI Act.

## 4. Human oversight and AI literacy

A qualified lawyer reviews and is responsible for all work product. Personnel have AI literacy consistent with their role under Article 4 of the EU AI Act.

## 5. Confidentiality and data protection (GDPR)

Client-confidential information is transmitted only to enterprise-grade tools procured under a GDPR-compliant DPA that do not train on client data, that encrypt in transit and at rest, and that segregate the Firm's tenant. No client data is used to train third-party models. Prompts and outputs are retained for {retention_period} and then deleted, consistent with Article 5(1)(e) GDPR. The lawful basis for processing is Article 6(1)(b) and/or (f) GDPR; where Article 9 data are processed, a further Article 9(2) basis is documented. Rights under Articles 15-22 GDPR remain available.

## 6. Transparency under Article 50 of the EU AI Act

Where a deliverable is generated or materially altered by a generative AI tool, the deliverable is identified as such. Where the Client interacts directly with an AI system deployed by the Firm, the Client is informed that the interaction is with an AI system.

## 7. Fees

{fee_treatment_paragraph}

## 8. Client opt-out

The Client may instruct the Firm, at any time and without penalty, to cease using generative AI tools. Opt-out takes effect upon receipt by the responsible lawyer and is confirmed in writing within three working days.

## 9. Updates

Material changes are communicated in writing before they take effect.

## 10. Questions and contact

{responsible_attorney}, {responsible_attorney_title}, {firm_name}. {responsible_attorney_email}. {responsible_attorney_phone}.

## 11. Acknowledgment

[signature block for Firm and Client; effective {effective_date}]
```

## Reference template — `client-summary-template.md`

```markdown
# A QUICK NOTE ABOUT OUR USE OF AI

**From:** {firm_name}
**To:** {client_name}
**Date:** {effective_date}

Thank you for choosing {firm_name}. Attached to your engagement letter is a short Rider explaining our use of generative artificial intelligence (AI) on your matter. Here is what it says, in plain English:

**What this means for you.** In representing you, {firm_name} may use generative AI tools to assist with research, drafting, and document review. A qualified attorney reviews and is responsible for all work product before it leaves this office. No client data is used to train third-party models. Prompts and outputs are retained per §5 of the Rider. You may opt out at any time in writing.

**What we use AI for.** First drafts, research support, and document review — always under lawyer supervision.

**What we do not use AI for.** Final decisions, filings, or client communications without lawyer review.

**Opt-out.** Email {responsible_attorney_email} and we will stop immediately.

Questions? Reply to this email or call {responsible_attorney_phone}.

— {responsible_attorney}
{responsible_attorney_title}, {firm_name}
```
