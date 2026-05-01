// Free-form prose playbook — same positions as profile_buyer_positions.json
// but rendered as the kind of policy document a buyer would upload.
import fs from 'node:fs';
import path from 'node:path';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx';

const OUT = path.resolve('tools/contract-grader/test_profiles/playbook_buyer_positions.docx');

const heading = (text, level = HeadingLevel.HEADING_1) =>
  new Paragraph({ heading: level, children: [new TextRun({ text, bold: true })] });
const sub = (text) =>
  new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text, bold: true })] });
const body = (text) =>
  new Paragraph({ children: [new TextRun(text)], spacing: { after: 200 } });
const bullet = (text) =>
  new Paragraph({ bullet: { level: 0 }, children: [new TextRun(text)], spacing: { after: 100 } });

const children = [];

children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  children: [new TextRun({ text: 'CONTRACT REVIEW PLAYBOOK', bold: true, size: 32 })],
  spacing: { after: 200 },
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  children: [new TextRun({ text: 'Apex Buyer Co. — Software/SaaS Procurement', italics: true })],
  spacing: { after: 400 },
}));

children.push(heading('Purpose & Scope'));
children.push(body(
  "This playbook codifies our standard positions for software-as-a-service and software-license agreements where Apex Buyer Co. is the customer. It is intended for use by reviewers (internal and external) when evaluating vendor-paper agreements presented to us, or when negotiating from a draft we have submitted. It is not a script. We negotiate, and we pick our battles. The positions below identify where we push hard, where we are flexible, and where we will walk."
));

children.push(heading('Negotiation Posture'));
children.push(body(
  "We are a mid-market buyer. We have reasonable but not unlimited leverage. We push hard on liability cap, indemnity symmetry, and data-security floors. We are flexible on payment timing, renewal mechanics, and minor commercial points if the deal is otherwise strong. When reviewing a vendor-paper draft, focus on material deviations — do not litigate every comma. When reviewing our own paper, focus on whether we have left risk on the table or papered over an ambiguity that will surface in operation."
));

children.push(heading('Commercial Terms'));

children.push(sub('Payment Terms'));
children.push(body(
  "Our default position is Net-30 from receipt of invoice. This aligns with our AP cycle and is standard buyer-side practice in our industry. Net-60 strains working capital and is unusual for SaaS subscriptions in our deal-size range; we will push back on Net-60 in any vendor draft. If the vendor refuses, Net-45 is acceptable when the vendor offers a meaningful discount or when the subscription is operationally critical-path."
));

children.push(sub('Late Fees'));
children.push(body(
  "We prefer that no late fee be specified at all. If a vendor insists on one, our ceiling is 1% per month. 1.5% per month is above market for buyer-side terms and we will negotiate it down. Late fees should never accelerate during a good-faith dispute over an invoice."
));

children.push(sub('Fee Increases at Renewal'));
children.push(body(
  "Renewal fee increases should be capped — typically at CPI or 5% per year, whichever is lower — and the vendor should be required to provide notice at least 90 days before the renewal so we can plan budget. Uncapped vendor-discretion fee increases at renewal are a red flag."
));

children.push(heading('Liability'));
children.push(body(
  "Our standard cap is 1x fees paid in the 12 months preceding the claim, mutual. Caps tied to 'fees paid' (rather than 'fees payable') reduce vendor exposure beyond what we view as proportionate; we accept 'fees paid' for budgeting clarity but read it carefully. Caps materially below 1x are a deal-breaker. Caps significantly above 1x (e.g., 2x or 3x) are acceptable to us; we will not push to bring the cap down."
));
children.push(body("The cap must include carve-outs for the following — these are non-negotiable:"));
children.push(bullet("Confidentiality breach (uncapped, or a meaningful supercap)"));
children.push(bullet("IP indemnity from either party (uncapped)"));
children.push(bullet("Data breach involving personal data (supercap of at least 3x annual fees, or insurance limits — whichever is higher)"));
children.push(bullet("Gross negligence and willful misconduct (uncapped)"));
children.push(body(
  "If the vendor draft caps liability at 12 months of fees with appropriate carve-outs, we generally will not push to bring it down to 1x — the carve-outs are doing the work and the cap is reasonable for the deal size. We do push to ensure carve-outs are present and well-drafted."
));

children.push(heading('Indemnification'));
children.push(body(
  "We expect mutual indemnity for IP infringement and confidentiality breach. Vendor IP indemnity (covering vendor-platform infringement claims) should be matched by customer IP indemnity (covering claims arising from customer data and any customizations we provide). Asymmetric indemnity — vendor protects us but we don't protect them — is acceptable in some narrow circumstances (e.g., where vendor controls the entire stack and we contribute nothing). Asymmetric indemnity in vendor's favor — i.e., we owe them broad indemnity but they owe us nothing — is a deal-breaker."
));

children.push(heading('Term and Termination'));

children.push(sub('Auto-Renewal'));
children.push(body(
  "Our preference is no auto-renewal. We prefer to make affirmative renewal decisions. If the vendor insists on auto-renewal, our ceiling on the cancellation-notice window is 30 days. Anything longer creates calendar risk for us — our procurement cycle catches 30-day windows reliably, but 60+ days requires a forward-dated reminder system that introduces failure modes. Auto-renewal with a notice period of more than 90 days is a deal-breaker."
));

children.push(sub('Termination for Material Breach'));
children.push(body(
  "Cure periods should be symmetric. We will not accept asymmetric cure periods that favor the vendor (e.g., vendor 30-day cure / customer 60-day cure). Either 30/30 or 60/60 is acceptable. Asymmetric cure is a credibility issue — it telegraphs that the vendor expects to use its remedy more often than we will."
));

children.push(sub('Termination for Convenience'));
children.push(body(
  "We prefer the right to terminate for convenience after some minimum commitment (e.g., 12 months) with reasonable notice. If the vendor refuses, we accept termination only for cause, but only with a reasonable cure period and a clear set of triggering events."
));

children.push(heading('Subcontracting'));
children.push(body(
  "Vendor must give us notice when engaging or replacing a subcontractor that processes our data or that performs more than 25% of the services. For subcontractors processing personal data, we require approval rights — not just notice — because the subcontractor change affects our compliance posture and our DPIA. Vendor must flow down the substantive obligations of this Agreement to its subcontractors."
));

children.push(heading('Data Security and Privacy'));
children.push(body(
  "Vendors handling our operational data must maintain SOC 2 Type II certification. Breach notification within 24 to 72 hours is our floor — 72 hours matches GDPR's regulatory requirement; we prefer 24 hours where the vendor can credibly commit to it. Annual penetration test reports must be made available to us under a confidentiality wrapper. We require customer audit rights for material incidents (we do not require general unilateral audit rights — those are an overreach we would push back on if the vendor offered them in the wrong direction)."
));

children.push(heading('Insurance'));
children.push(body(
  "Coverage minimums are: cyber liability and errors & omissions of $5M per occurrence and aggregate; commercial general liability of $2M per occurrence and aggregate. Vendor must provide a certificate of insurance on request. For E&O / cyber, we should be named as additional insured. Vendor sole audit rights against us — without parallel customer rights — is a deal-breaker."
));

children.push(heading('Intellectual Property'));
children.push(body(
  "Vendor's retention of platform IP is acceptable and standard. Our retention of Customer Data is non-negotiable. The treatment of customer outputs and derived analytics — i.e., reports, models, or analytics generated from our data specifically for us — is often glossed over in vendor paper. We want this clear: customer-specific outputs and analytics generated for us should be Customer-owned, or at minimum jointly owned with a perpetual customer license. Vague language on output ownership is a finding worth raising."
));

children.push(heading('Confidentiality'));
children.push(body(
  "Mutual confidentiality is required. The duration of confidentiality obligations after termination must be at least 5 years for non-trade-secret confidential information (trade secrets are protected for the duration they remain trade secrets, per applicable law). 3-year tails are short relative to the lifecycle of the kind of competitive information typically exchanged in a SaaS engagement; we push for 5 years."
));

children.push(heading('Dispute Resolution'));
children.push(body(
  "Arbitration in a neutral forum or in the customer's home state is acceptable. Vendor-home-state arbitration imposes travel cost and forum-selection disadvantages on us that we will not accept by default. We push for AAA or JAMS in a neutral location, or arbitration in our home state."
));

children.push(heading('Deal-Breakers Summary'));
children.push(body("The following are deal-breakers — if the vendor will not move, we walk:"));
children.push(bullet("Vendor unilateral audit rights against customer with no reciprocal rights"));
children.push(bullet("Broad customer indemnity covering any third-party claim arising from customer's use of the service"));
children.push(bullet("Auto-renewal with cancellation-notice window greater than 90 days"));
children.push(bullet("Liability cap below 1x fees paid in the prior 12 months"));
children.push(bullet("No data-breach notification timeline, or timeline longer than 72 hours"));

const doc = new Document({
  creator: 'Apex Buyer Co.',
  title: 'Contract Review Playbook',
  description: 'Apex Buyer Co. — software/SaaS procurement playbook',
  sections: [{ properties: {}, children }],
});
const buf = await Packer.toBuffer(doc);
fs.writeFileSync(OUT, buf);
console.log(`Wrote ${OUT}`);
console.log(`Size: ${buf.length} bytes`);
