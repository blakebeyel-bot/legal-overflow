/**
 * Pre-built template seed content.
 *
 * Each entry produces a real .docx template + schema that gets
 * uploaded as a system-owned vault item (user_id = NULL) and shown
 * in every user's template picker.
 *
 * The .docx is built programmatically with the `docx` library at
 * seed time — no external file dependencies. After seeding, the
 * file lives in supabase storage and is downloaded by the merge
 * endpoint at render time, exactly like a user-uploaded template.
 *
 * Each placeholder uses [BRACKETED_CAPS] form so the merge
 * normalizer can find them via case-insensitive matching even if
 * the wording around them shifts.
 */

import { Document, Paragraph, TextRun, HeadingLevel, AlignmentType, Packer, PageOrientation } from 'docx';

const COMMON_HEADER = (title) => new Paragraph({
  alignment: AlignmentType.CENTER,
  children: [
    new TextRun({ text: title.toUpperCase(), bold: true, size: 28 }),
  ],
  spacing: { after: 400 },
});

const SIGNATURE_BLOCK = () => [
  new Paragraph({
    children: [new TextRun({ text: 'AGREED AND ACCEPTED:', bold: true })],
    spacing: { before: 600, after: 200 },
  }),
  new Paragraph({
    children: [new TextRun({ text: '________________________________' })],
    spacing: { after: 60 },
  }),
  new Paragraph({
    children: [new TextRun({ text: '[CLIENT_NAME]', italics: true })],
    spacing: { after: 60 },
  }),
  new Paragraph({
    children: [new TextRun({ text: 'Date: [EFFECTIVE_DATE]', italics: true })],
    spacing: { after: 400 },
  }),
  new Paragraph({
    children: [new TextRun({ text: '________________________________' })],
    spacing: { after: 60 },
  }),
  new Paragraph({
    children: [new TextRun({ text: '[FIRM_NAME]', italics: true })],
    spacing: { after: 60 },
  }),
  new Paragraph({
    children: [new TextRun({ text: 'By: [ATTORNEY_NAME]', italics: true })],
    spacing: { after: 60 },
  }),
];

function buildNdaMutual() {
  return new Document({
    sections: [{
      properties: {},
      children: [
        COMMON_HEADER('Mutual Non-Disclosure Agreement'),
        new Paragraph({
          children: [
            new TextRun({ text: 'This Mutual Non-Disclosure Agreement (the "Agreement") is entered into as of ' }),
            new TextRun({ text: '[EFFECTIVE_DATE]', bold: true }),
            new TextRun({ text: ' by and between ' }),
            new TextRun({ text: '[PARTY_A_NAME]', bold: true }),
            new TextRun({ text: ' ("Party A") and ' }),
            new TextRun({ text: '[PARTY_B_NAME]', bold: true }),
            new TextRun({ text: ' ("Party B"). The parties wish to explore a business relationship in connection with ' }),
            new TextRun({ text: '[PURPOSE_OF_DISCLOSURE]', bold: true }),
            new TextRun({ text: ' (the "Purpose").' }),
          ],
          spacing: { after: 240 },
        }),
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: '1. Confidential Information.' })],
        }),
        new Paragraph({
          children: [new TextRun({ text: '"Confidential Information" means any non-public information disclosed by one party to the other, in any form, related to the Purpose. Confidential Information does not include information that is publicly available, lawfully obtained from a third party without restriction, or independently developed without use of the other party\'s Confidential Information.' })],
          spacing: { after: 240 },
        }),
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: '2. Obligations.' })],
        }),
        new Paragraph({
          children: [
            new TextRun({ text: 'Each party agrees to (a) hold the other\'s Confidential Information in strict confidence, (b) not disclose it to any third party, and (c) use it solely for the Purpose. The obligations in this Agreement survive for a period of ' }),
            new TextRun({ text: '[CONFIDENTIALITY_TERM_YEARS]', bold: true }),
            new TextRun({ text: ' years from the date of disclosure.' }),
          ],
          spacing: { after: 240 },
        }),
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: '3. Governing Law.' })],
        }),
        new Paragraph({
          children: [
            new TextRun({ text: 'This Agreement shall be governed by the laws of the State of ' }),
            new TextRun({ text: '[GOVERNING_STATE]', bold: true }),
            new TextRun({ text: ', without regard to its conflict of laws principles.' }),
          ],
          spacing: { after: 400 },
        }),
        ...SIGNATURE_BLOCK(),
      ],
    }],
  });
}

function buildEngagementLetter() {
  return new Document({
    sections: [{
      properties: {},
      children: [
        new Paragraph({ children: [new TextRun({ text: '[FIRM_NAME]', bold: true, size: 32 })], alignment: AlignmentType.RIGHT }),
        new Paragraph({ children: [new TextRun({ text: '[FIRM_ADDRESS]' })], alignment: AlignmentType.RIGHT, spacing: { after: 600 } }),
        new Paragraph({ children: [new TextRun({ text: '[EFFECTIVE_DATE]' })], spacing: { after: 240 } }),
        new Paragraph({ children: [new TextRun({ text: '[CLIENT_NAME]' })] }),
        new Paragraph({ children: [new TextRun({ text: '[CLIENT_ADDRESS]' })], spacing: { after: 240 } }),
        new Paragraph({ children: [new TextRun({ text: 'Re: Engagement for Legal Services', bold: true })], spacing: { after: 240 } }),
        new Paragraph({ children: [new TextRun({ text: 'Dear [CLIENT_NAME]:' })], spacing: { after: 240 } }),
        new Paragraph({
          children: [
            new TextRun({ text: 'Thank you for retaining ' }),
            new TextRun({ text: '[FIRM_NAME]', bold: true }),
            new TextRun({ text: ' to represent you in connection with ' }),
            new TextRun({ text: '[MATTER_DESCRIPTION]', bold: true }),
            new TextRun({ text: ' (the "Matter"). This letter sets out the terms of our engagement.' }),
          ],
          spacing: { after: 240 },
        }),
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: 'Scope of Representation.' })],
        }),
        new Paragraph({
          children: [
            new TextRun({ text: 'Our representation is limited to: ' }),
            new TextRun({ text: '[SCOPE_OF_WORK]', bold: true }),
            new TextRun({ text: '.' }),
          ],
          spacing: { after: 240 },
        }),
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: 'Fees and Billing.' })],
        }),
        new Paragraph({
          children: [
            new TextRun({ text: 'Our hourly rate for this Matter is ' }),
            new TextRun({ text: '$[HOURLY_RATE]', bold: true }),
            new TextRun({ text: '. We require a retainer of ' }),
            new TextRun({ text: '$[RETAINER_AMOUNT]', bold: true }),
            new TextRun({ text: ' to begin work, which will be held in our trust account and applied against our final invoice.' }),
          ],
          spacing: { after: 240 },
        }),
        new Paragraph({
          children: [new TextRun({ text: 'If these terms are acceptable, please sign and return this letter along with the retainer.' })],
          spacing: { after: 240 },
        }),
        new Paragraph({ children: [new TextRun({ text: 'Sincerely,' })], spacing: { after: 400 } }),
        new Paragraph({ children: [new TextRun({ text: '[ATTORNEY_NAME]', bold: true })] }),
        new Paragraph({ children: [new TextRun({ text: '[FIRM_NAME]' })], spacing: { after: 400 } }),
        ...SIGNATURE_BLOCK(),
      ],
    }],
  });
}

function buildDemandLetter() {
  return new Document({
    sections: [{
      properties: {},
      children: [
        new Paragraph({ children: [new TextRun({ text: '[FIRM_NAME]', bold: true, size: 32 })], alignment: AlignmentType.RIGHT }),
        new Paragraph({ children: [new TextRun({ text: '[FIRM_ADDRESS]' })], alignment: AlignmentType.RIGHT, spacing: { after: 600 } }),
        new Paragraph({ children: [new TextRun({ text: '[EFFECTIVE_DATE]' })], spacing: { after: 240 } }),
        new Paragraph({ children: [new TextRun({ text: 'VIA CERTIFIED MAIL', bold: true })], spacing: { after: 120 } }),
        new Paragraph({ children: [new TextRun({ text: '[OPPOSING_PARTY_NAME]' })] }),
        new Paragraph({ children: [new TextRun({ text: '[OPPOSING_PARTY_ADDRESS]' })], spacing: { after: 240 } }),
        new Paragraph({
          children: [
            new TextRun({ text: 'Re: ', bold: true }),
            new TextRun({ text: '[MATTER_DESCRIPTION]', bold: true }),
          ],
          spacing: { after: 240 },
        }),
        new Paragraph({ children: [new TextRun({ text: 'Dear [OPPOSING_PARTY_NAME]:' })], spacing: { after: 240 } }),
        new Paragraph({
          children: [
            new TextRun({ text: 'This firm represents ' }),
            new TextRun({ text: '[CLIENT_NAME]', bold: true }),
            new TextRun({ text: ' in connection with the above-referenced matter. We write to demand resolution of the following:' }),
          ],
          spacing: { after: 240 },
        }),
        new Paragraph({
          children: [
            new TextRun({ text: '[FACTUAL_BACKGROUND]' }),
          ],
          spacing: { after: 240 },
        }),
        new Paragraph({
          children: [
            new TextRun({ text: 'Based on these facts, our client demands ' }),
            new TextRun({ text: '[DEMAND]', bold: true }),
            new TextRun({ text: ' within ' }),
            new TextRun({ text: '[RESPONSE_DEADLINE_DAYS]', bold: true }),
            new TextRun({ text: ' days of the date of this letter. Failure to do so will result in our client pursuing all available legal remedies.' }),
          ],
          spacing: { after: 240 },
        }),
        new Paragraph({ children: [new TextRun({ text: 'Govern yourself accordingly.' })], spacing: { after: 400 } }),
        new Paragraph({ children: [new TextRun({ text: 'Sincerely,' })], spacing: { after: 400 } }),
        new Paragraph({ children: [new TextRun({ text: '[ATTORNEY_NAME]', bold: true })] }),
        new Paragraph({ children: [new TextRun({ text: '[FIRM_NAME]' })] }),
      ],
    }],
  });
}

function buildClientIntakeMemo() {
  return new Document({
    sections: [{
      properties: {},
      children: [
        new Paragraph({ children: [new TextRun({ text: '[FIRM_NAME]', bold: true, size: 32 })], alignment: AlignmentType.CENTER, spacing: { after: 600 } }),
        new Paragraph({ children: [new TextRun({ text: 'CLIENT INTAKE MEMORANDUM', bold: true, size: 24 })], alignment: AlignmentType.CENTER, spacing: { after: 400 } }),
        new Paragraph({ children: [new TextRun({ text: 'Intake Date: [EFFECTIVE_DATE]' })] }),
        new Paragraph({ children: [new TextRun({ text: 'Intake Attorney: [ATTORNEY_NAME]' })], spacing: { after: 240 } }),
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: '1. Client Information' })],
        }),
        new Paragraph({ children: [new TextRun({ text: 'Name: [CLIENT_NAME]' })] }),
        new Paragraph({ children: [new TextRun({ text: 'Address: [CLIENT_ADDRESS]' })] }),
        new Paragraph({ children: [new TextRun({ text: 'Phone: [CLIENT_PHONE]' })] }),
        new Paragraph({ children: [new TextRun({ text: 'Email: [CLIENT_EMAIL]' })], spacing: { after: 240 } }),
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: '2. Matter Summary' })],
        }),
        new Paragraph({ children: [new TextRun({ text: '[MATTER_DESCRIPTION]' })], spacing: { after: 240 } }),
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: '3. Conflicts Check' })],
        }),
        new Paragraph({ children: [new TextRun({ text: 'Adverse parties: [OPPOSING_PARTY_NAME]' })] }),
        new Paragraph({ children: [new TextRun({ text: 'Conflicts result: [CONFLICTS_RESULT]' })], spacing: { after: 240 } }),
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: '4. Engagement Recommendation' })],
        }),
        new Paragraph({ children: [new TextRun({ text: '[ENGAGEMENT_RECOMMENDATION]' })], spacing: { after: 240 } }),
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: '5. Estimated Fees' })],
        }),
        new Paragraph({ children: [new TextRun({ text: 'Rate: $[HOURLY_RATE]/hour' })] }),
        new Paragraph({ children: [new TextRun({ text: 'Estimated total: [FEE_ESTIMATE]' })] }),
      ],
    }],
  });
}

function buildSimpleContract() {
  return new Document({
    sections: [{
      properties: {},
      children: [
        COMMON_HEADER('Services Agreement'),
        new Paragraph({
          children: [
            new TextRun({ text: 'This Services Agreement (the "Agreement") is made and entered into as of ' }),
            new TextRun({ text: '[EFFECTIVE_DATE]', bold: true }),
            new TextRun({ text: ' (the "Effective Date") by and between ' }),
            new TextRun({ text: '[PARTY_A_NAME]', bold: true }),
            new TextRun({ text: ', a ' }),
            new TextRun({ text: '[PARTY_A_TYPE]', bold: true }),
            new TextRun({ text: ' ("Service Provider"), and ' }),
            new TextRun({ text: '[PARTY_B_NAME]', bold: true }),
            new TextRun({ text: ' ("Client").' }),
          ],
          spacing: { after: 240 },
        }),
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: '1. Services.' })],
        }),
        new Paragraph({
          children: [
            new TextRun({ text: 'Service Provider shall provide the following services: ' }),
            new TextRun({ text: '[SCOPE_OF_WORK]', bold: true }),
            new TextRun({ text: '.' }),
          ],
          spacing: { after: 240 },
        }),
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: '2. Compensation.' })],
        }),
        new Paragraph({
          children: [
            new TextRun({ text: 'Client shall pay Service Provider ' }),
            new TextRun({ text: '$[CONTRACT_AMOUNT]', bold: true }),
            new TextRun({ text: ' for the Services. Payment shall be made within ' }),
            new TextRun({ text: '[PAYMENT_TERMS_DAYS]', bold: true }),
            new TextRun({ text: ' days of invoice.' }),
          ],
          spacing: { after: 240 },
        }),
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: '3. Term.' })],
        }),
        new Paragraph({
          children: [
            new TextRun({ text: 'This Agreement shall remain in effect from the Effective Date until ' }),
            new TextRun({ text: '[TERMINATION_DATE]', bold: true }),
            new TextRun({ text: ', unless terminated earlier per the terms herein.' }),
          ],
          spacing: { after: 240 },
        }),
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: '4. Governing Law.' })],
        }),
        new Paragraph({
          children: [
            new TextRun({ text: 'This Agreement shall be governed by the laws of ' }),
            new TextRun({ text: '[GOVERNING_STATE]', bold: true }),
            new TextRun({ text: '.' }),
          ],
          spacing: { after: 400 },
        }),
        ...SIGNATURE_BLOCK(),
      ],
    }],
  });
}

function buildSettlementOffer() {
  return new Document({
    sections: [{
      properties: {},
      children: [
        new Paragraph({ children: [new TextRun({ text: '[FIRM_NAME]', bold: true, size: 32 })], alignment: AlignmentType.RIGHT }),
        new Paragraph({ children: [new TextRun({ text: '[FIRM_ADDRESS]' })], alignment: AlignmentType.RIGHT, spacing: { after: 600 } }),
        new Paragraph({ children: [new TextRun({ text: '[EFFECTIVE_DATE]' })], spacing: { after: 240 } }),
        new Paragraph({ children: [new TextRun({ text: 'CONFIDENTIAL — SETTLEMENT COMMUNICATION', bold: true })], spacing: { after: 240 } }),
        new Paragraph({ children: [new TextRun({ text: '[OPPOSING_COUNSEL_NAME]' })] }),
        new Paragraph({ children: [new TextRun({ text: '[OPPOSING_COUNSEL_FIRM]' })], spacing: { after: 240 } }),
        new Paragraph({
          children: [
            new TextRun({ text: 'Re: ', bold: true }),
            new TextRun({ text: '[CASE_CAPTION]', bold: true }),
          ],
          spacing: { after: 240 },
        }),
        new Paragraph({ children: [new TextRun({ text: 'Dear [OPPOSING_COUNSEL_NAME]:' })], spacing: { after: 240 } }),
        new Paragraph({
          children: [
            new TextRun({ text: 'On behalf of our client, ' }),
            new TextRun({ text: '[CLIENT_NAME]', bold: true }),
            new TextRun({ text: ', and in an effort to resolve the above matter without further litigation, we hereby make the following settlement offer:' }),
          ],
          spacing: { after: 240 },
        }),
        new Paragraph({
          children: [
            new TextRun({ text: '[SETTLEMENT_TERMS]' }),
          ],
          spacing: { after: 240 },
        }),
        new Paragraph({
          children: [
            new TextRun({ text: 'This offer is made pursuant to ' }),
            new TextRun({ text: '[RULE_OR_STATUTE]', bold: true }),
            new TextRun({ text: ' and shall remain open until ' }),
            new TextRun({ text: '[OFFER_EXPIRATION_DATE]', bold: true }),
            new TextRun({ text: '.' }),
          ],
          spacing: { after: 400 },
        }),
        new Paragraph({ children: [new TextRun({ text: 'Sincerely,' })], spacing: { after: 400 } }),
        new Paragraph({ children: [new TextRun({ text: '[ATTORNEY_NAME]', bold: true })] }),
        new Paragraph({ children: [new TextRun({ text: '[FIRM_NAME]' })] }),
      ],
    }],
  });
}

/**
 * Public catalog of pre-built templates. Each entry has the document
 * builder, title, summary, and full schema.
 */
export const SYSTEM_TEMPLATES = [
  {
    slug: 'nda-mutual',
    title: 'Mutual Non-Disclosure Agreement',
    summary: 'Standard two-way confidentiality agreement for exploring a business relationship.',
    build: buildNdaMutual,
    schema: {
      vars: [
        { key: 'effective_date', label: 'Effective date', type: 'date', placeholder_text: '[EFFECTIVE_DATE]', hint: 'The date the agreement starts', occurrences: 1 },
        { key: 'party_a_name', label: 'Party A name', type: 'text', placeholder_text: '[PARTY_A_NAME]', hint: 'The first disclosing party', occurrences: 1 },
        { key: 'party_b_name', label: 'Party B name', type: 'text', placeholder_text: '[PARTY_B_NAME]', hint: 'The second disclosing party', occurrences: 1 },
        { key: 'purpose_of_disclosure', label: 'Purpose of disclosure', type: 'longtext', placeholder_text: '[PURPOSE_OF_DISCLOSURE]', hint: 'What the parties are exploring', occurrences: 1 },
        { key: 'confidentiality_term_years', label: 'Confidentiality term (years)', type: 'text', placeholder_text: '[CONFIDENTIALITY_TERM_YEARS]', hint: 'Survival period for the NDA', occurrences: 1 },
        { key: 'governing_state', label: 'Governing state', type: 'state', placeholder_text: '[GOVERNING_STATE]', hint: 'US state whose law controls', occurrences: 1 },
        { key: 'client_name', label: 'Client name', type: 'text', placeholder_text: '[CLIENT_NAME]', hint: 'Your client (in the signature block)', occurrences: 1 },
        { key: 'firm_name', label: 'Firm name', type: 'text', placeholder_text: '[FIRM_NAME]', hint: 'Your firm name', occurrences: 1 },
        { key: 'attorney_name', label: 'Attorney name', type: 'text', placeholder_text: '[ATTORNEY_NAME]', hint: 'Signing attorney', occurrences: 1 },
      ],
    },
  },
  {
    slug: 'engagement-letter-hourly',
    title: 'Engagement Letter — Hourly',
    summary: 'Standard hourly-rate engagement letter with retainer.',
    build: buildEngagementLetter,
    schema: {
      vars: [
        { key: 'effective_date', label: 'Date', type: 'date', placeholder_text: '[EFFECTIVE_DATE]', hint: 'Letter date', occurrences: 1 },
        { key: 'client_name', label: 'Client name', type: 'text', placeholder_text: '[CLIENT_NAME]', hint: 'The client being engaged', occurrences: 1 },
        { key: 'client_address', label: 'Client address', type: 'longtext', placeholder_text: '[CLIENT_ADDRESS]', hint: 'Client mailing address', occurrences: 1 },
        { key: 'matter_description', label: 'Matter description', type: 'longtext', placeholder_text: '[MATTER_DESCRIPTION]', hint: 'What the firm is being hired for', occurrences: 1 },
        { key: 'scope_of_work', label: 'Scope of work', type: 'longtext', placeholder_text: '[SCOPE_OF_WORK]', hint: 'Specific services covered', occurrences: 1 },
        { key: 'hourly_rate', label: 'Hourly rate', type: 'currency', placeholder_text: '[HOURLY_RATE]', hint: 'Dollar rate per hour', occurrences: 1 },
        { key: 'retainer_amount', label: 'Retainer amount', type: 'currency', placeholder_text: '[RETAINER_AMOUNT]', hint: 'Upfront retainer dollar amount', occurrences: 1 },
        { key: 'firm_name', label: 'Firm name', type: 'text', placeholder_text: '[FIRM_NAME]', hint: 'Your firm name', occurrences: 1 },
        { key: 'firm_address', label: 'Firm address', type: 'longtext', placeholder_text: '[FIRM_ADDRESS]', hint: 'Firm letterhead address', occurrences: 1 },
        { key: 'attorney_name', label: 'Attorney name', type: 'text', placeholder_text: '[ATTORNEY_NAME]', hint: 'Signing attorney', occurrences: 1 },
      ],
    },
  },
  {
    slug: 'demand-letter',
    title: 'Demand Letter — Pre-Litigation',
    summary: 'Pre-litigation demand letter with factual recitation and deadline.',
    build: buildDemandLetter,
    schema: {
      vars: [
        { key: 'effective_date', label: 'Date', type: 'date', placeholder_text: '[EFFECTIVE_DATE]', hint: 'Letter date', occurrences: 1 },
        { key: 'opposing_party_name', label: 'Opposing party name', type: 'text', placeholder_text: '[OPPOSING_PARTY_NAME]', hint: 'Recipient of the demand', occurrences: 1 },
        { key: 'opposing_party_address', label: 'Opposing party address', type: 'longtext', placeholder_text: '[OPPOSING_PARTY_ADDRESS]', hint: 'Mailing address', occurrences: 1 },
        { key: 'matter_description', label: 'Matter description', type: 'text', placeholder_text: '[MATTER_DESCRIPTION]', hint: 'Subject line description', occurrences: 1 },
        { key: 'client_name', label: 'Client name', type: 'text', placeholder_text: '[CLIENT_NAME]', hint: 'Your client', occurrences: 1 },
        { key: 'factual_background', label: 'Factual background', type: 'longtext', placeholder_text: '[FACTUAL_BACKGROUND]', hint: 'Statement of facts', occurrences: 1 },
        { key: 'demand', label: 'Demand', type: 'longtext', placeholder_text: '[DEMAND]', hint: 'What you are demanding', occurrences: 1 },
        { key: 'response_deadline_days', label: 'Response deadline (days)', type: 'text', placeholder_text: '[RESPONSE_DEADLINE_DAYS]', hint: 'How many days to respond', occurrences: 1 },
        { key: 'firm_name', label: 'Firm name', type: 'text', placeholder_text: '[FIRM_NAME]', hint: 'Your firm name', occurrences: 1 },
        { key: 'firm_address', label: 'Firm address', type: 'longtext', placeholder_text: '[FIRM_ADDRESS]', hint: 'Firm letterhead address', occurrences: 1 },
        { key: 'attorney_name', label: 'Attorney name', type: 'text', placeholder_text: '[ATTORNEY_NAME]', hint: 'Signing attorney', occurrences: 1 },
      ],
    },
  },
  {
    slug: 'client-intake-memo',
    title: 'Client Intake Memo',
    summary: 'Internal memo documenting a new client intake and conflicts check.',
    build: buildClientIntakeMemo,
    schema: {
      vars: [
        { key: 'effective_date', label: 'Intake date', type: 'date', placeholder_text: '[EFFECTIVE_DATE]', hint: '', occurrences: 1 },
        { key: 'attorney_name', label: 'Intake attorney', type: 'text', placeholder_text: '[ATTORNEY_NAME]', hint: '', occurrences: 1 },
        { key: 'firm_name', label: 'Firm name', type: 'text', placeholder_text: '[FIRM_NAME]', hint: '', occurrences: 1 },
        { key: 'client_name', label: 'Client name', type: 'text', placeholder_text: '[CLIENT_NAME]', hint: '', occurrences: 1 },
        { key: 'client_address', label: 'Client address', type: 'longtext', placeholder_text: '[CLIENT_ADDRESS]', hint: '', occurrences: 1 },
        { key: 'client_phone', label: 'Client phone', type: 'text', placeholder_text: '[CLIENT_PHONE]', hint: '', occurrences: 1 },
        { key: 'client_email', label: 'Client email', type: 'text', placeholder_text: '[CLIENT_EMAIL]', hint: '', occurrences: 1 },
        { key: 'matter_description', label: 'Matter description', type: 'longtext', placeholder_text: '[MATTER_DESCRIPTION]', hint: '', occurrences: 1 },
        { key: 'opposing_party_name', label: 'Opposing party', type: 'text', placeholder_text: '[OPPOSING_PARTY_NAME]', hint: 'Adverse party (or "none")', occurrences: 1 },
        { key: 'conflicts_result', label: 'Conflicts result', type: 'text', placeholder_text: '[CONFLICTS_RESULT]', hint: 'Cleared / hit / waived', occurrences: 1 },
        { key: 'engagement_recommendation', label: 'Engagement recommendation', type: 'longtext', placeholder_text: '[ENGAGEMENT_RECOMMENDATION]', hint: '', occurrences: 1 },
        { key: 'hourly_rate', label: 'Hourly rate', type: 'currency', placeholder_text: '[HOURLY_RATE]', hint: '', occurrences: 1 },
        { key: 'fee_estimate', label: 'Fee estimate', type: 'text', placeholder_text: '[FEE_ESTIMATE]', hint: 'Total estimate range', occurrences: 1 },
      ],
    },
  },
  {
    slug: 'services-agreement',
    title: 'Services Agreement — Fixed Fee',
    summary: 'Plain-vanilla services agreement with fixed-fee payment terms.',
    build: buildSimpleContract,
    schema: {
      vars: [
        { key: 'effective_date', label: 'Effective date', type: 'date', placeholder_text: '[EFFECTIVE_DATE]', hint: '', occurrences: 1 },
        { key: 'party_a_name', label: 'Service Provider name', type: 'text', placeholder_text: '[PARTY_A_NAME]', hint: '', occurrences: 1 },
        { key: 'party_a_type', label: 'Service Provider entity type', type: 'text', placeholder_text: '[PARTY_A_TYPE]', hint: 'LLC, corporation, etc.', occurrences: 1 },
        { key: 'party_b_name', label: 'Client name', type: 'text', placeholder_text: '[PARTY_B_NAME]', hint: '', occurrences: 1 },
        { key: 'scope_of_work', label: 'Scope of work', type: 'longtext', placeholder_text: '[SCOPE_OF_WORK]', hint: '', occurrences: 1 },
        { key: 'contract_amount', label: 'Contract amount', type: 'currency', placeholder_text: '[CONTRACT_AMOUNT]', hint: '', occurrences: 1 },
        { key: 'payment_terms_days', label: 'Payment terms (days)', type: 'text', placeholder_text: '[PAYMENT_TERMS_DAYS]', hint: '', occurrences: 1 },
        { key: 'termination_date', label: 'Termination date', type: 'date', placeholder_text: '[TERMINATION_DATE]', hint: '', occurrences: 1 },
        { key: 'governing_state', label: 'Governing state', type: 'state', placeholder_text: '[GOVERNING_STATE]', hint: '', occurrences: 1 },
        { key: 'client_name', label: 'Signer name', type: 'text', placeholder_text: '[CLIENT_NAME]', hint: 'For signature block', occurrences: 1 },
        { key: 'firm_name', label: 'Firm name', type: 'text', placeholder_text: '[FIRM_NAME]', hint: '', occurrences: 1 },
        { key: 'attorney_name', label: 'Attorney name', type: 'text', placeholder_text: '[ATTORNEY_NAME]', hint: '', occurrences: 1 },
      ],
    },
  },
  {
    slug: 'settlement-offer',
    title: 'Settlement Offer Letter',
    summary: 'Confidential settlement communication with offer terms and deadline.',
    build: buildSettlementOffer,
    schema: {
      vars: [
        { key: 'effective_date', label: 'Date', type: 'date', placeholder_text: '[EFFECTIVE_DATE]', hint: '', occurrences: 1 },
        { key: 'opposing_counsel_name', label: 'Opposing counsel name', type: 'text', placeholder_text: '[OPPOSING_COUNSEL_NAME]', hint: '', occurrences: 1 },
        { key: 'opposing_counsel_firm', label: 'Opposing counsel firm', type: 'text', placeholder_text: '[OPPOSING_COUNSEL_FIRM]', hint: '', occurrences: 1 },
        { key: 'case_caption', label: 'Case caption', type: 'text', placeholder_text: '[CASE_CAPTION]', hint: 'Smith v. Jones, etc.', occurrences: 1 },
        { key: 'client_name', label: 'Client name', type: 'text', placeholder_text: '[CLIENT_NAME]', hint: '', occurrences: 1 },
        { key: 'settlement_terms', label: 'Settlement terms', type: 'longtext', placeholder_text: '[SETTLEMENT_TERMS]', hint: 'Specific offer terms', occurrences: 1 },
        { key: 'rule_or_statute', label: 'Rule / statute', type: 'text', placeholder_text: '[RULE_OR_STATUTE]', hint: 'FRE 408, state equivalent, etc.', occurrences: 1 },
        { key: 'offer_expiration_date', label: 'Offer expiration date', type: 'date', placeholder_text: '[OFFER_EXPIRATION_DATE]', hint: '', occurrences: 1 },
        { key: 'firm_name', label: 'Firm name', type: 'text', placeholder_text: '[FIRM_NAME]', hint: '', occurrences: 1 },
        { key: 'firm_address', label: 'Firm address', type: 'longtext', placeholder_text: '[FIRM_ADDRESS]', hint: '', occurrences: 1 },
        { key: 'attorney_name', label: 'Attorney name', type: 'text', placeholder_text: '[ATTORNEY_NAME]', hint: '', occurrences: 1 },
      ],
    },
  },
];

/**
 * Generate the .docx bytes for one entry by slug. Used by the seed
 * function to produce upload payloads.
 */
export async function buildTemplateDocx(slug) {
  const entry = SYSTEM_TEMPLATES.find((t) => t.slug === slug);
  if (!entry) throw new Error(`Unknown template slug: ${slug}`);
  const doc = entry.build();
  const buffer = await Packer.toBuffer(doc);
  return { buffer, entry };
}
