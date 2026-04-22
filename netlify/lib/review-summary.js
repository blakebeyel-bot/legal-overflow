/**
 * Review summary generator — produces the internal "Review_Summary.docx"
 * that goes alongside the customer-facing annotated file.
 *
 * This is an INTERNAL-ONLY document (CLAUDE.md §4.3). It MAY reference
 * profile clauses and severity tiers — those are the things the customer-
 * facing annotations are forbidden from containing.
 *
 * Input: the compiled findings array + review metadata.
 * Output: a .docx Buffer.
 */
import {
  Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell,
  WidthType, AlignmentType,
} from 'docx';

/**
 * @param {object} opts
 * @param {string} opts.filename       — original contract filename
 * @param {string} opts.contractType   — from classifier
 * @param {string} opts.pipelineMode   — express | standard | comprehensive
 * @param {Array<Finding>} opts.findings
 * @param {Array<Finding>} opts.unanchored — findings that could not be placed
 * @param {object} opts.severityCounts
 * @param {Date}   opts.reviewedAt
 * @returns {Promise<Buffer>}
 */
export async function buildReviewSummaryDocx({
  filename,
  contractType,
  pipelineMode,
  findings,
  priorityThree = [],
  unanchored = [],
  severityCounts,
  reviewedAt,
}) {
  const date = (reviewedAt || new Date()).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  const children = [];

  // Title
  children.push(new Paragraph({
    heading: HeadingLevel.TITLE,
    children: [new TextRun({ text: 'Contract Review Summary', bold: true })],
  }));

  // Matter header
  children.push(new Paragraph({
    children: [new TextRun({ text: `Document: ${filename}`, bold: true })],
  }));
  children.push(new Paragraph({ children: [new TextRun(`Contract type: ${contractType || 'unclassified'}`)] }));
  children.push(new Paragraph({ children: [new TextRun(`Pipeline mode: ${pipelineMode || 'standard'}`)] }));
  children.push(new Paragraph({ children: [new TextRun(`Reviewed: ${date}`)] }));
  children.push(new Paragraph({ children: [new TextRun('')] }));

  // Severity summary
  children.push(new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children: [new TextRun('Severity summary')],
  }));

  children.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      tableRow(['Severity', 'Count'], true),
      tableRow(['Blocker',  String(severityCounts?.blocker  || 0)]),
      tableRow(['Major',    String(severityCounts?.major    || 0)]),
      tableRow(['Moderate', String(severityCounts?.moderate || 0)]),
      tableRow(['Minor',    String(severityCounts?.minor    || 0)]),
    ],
  }));
  children.push(new Paragraph({ children: [new TextRun('')] }));

  // Top 3 to Raise — phone-call-level summary (FIRST section per partner request)
  if (priorityThree && priorityThree.length > 0) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun('Top 3 to raise')],
    }));
    children.push(new Paragraph({
      children: [new TextRun({
        text: 'Partner-level summary. Raise these on a call with the counterparty before sending the full redline.',
        italics: true,
      })],
    }));
    priorityThree.slice(0, 3).forEach((f, i) => {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: `${i + 1}. [${f.severity || '—'}] ${f.category || '—'} · ${f.location || 'Unlocated'}` })],
      }));
      if (f.materiality_rationale) {
        children.push(new Paragraph({
          children: [new TextRun({ text: 'Why: ', bold: true }), new TextRun(f.materiality_rationale)],
        }));
      }
      if (f.position) {
        children.push(new Paragraph({
          children: [new TextRun({ text: 'Position (opening ask): ', bold: true }), new TextRun(f.position)],
        }));
      }
      if (f.fallback) {
        children.push(new Paragraph({
          children: [new TextRun({ text: 'Fallback: ', bold: true }), new TextRun(f.fallback)],
        }));
      }
      if (f.walkaway) {
        children.push(new Paragraph({
          children: [new TextRun({ text: 'Walkaway: ', bold: true }), new TextRun(f.walkaway)],
        }));
      }
      children.push(new Paragraph({ children: [new TextRun('')] }));
    });
  }

  // Senior-review callouts first (per CLAUDE.md §7)
  const seniorFindings = findings.filter(f => f.requires_senior_review);
  if (seniorFindings.length > 0) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun('Requires senior review')],
    }));
    for (const f of seniorFindings) {
      children.push(...renderFinding(f));
    }
    children.push(new Paragraph({ children: [new TextRun('')] }));
  }

  // Full findings list
  children.push(new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children: [new TextRun('All findings')],
  }));

  // Sort: Blocker > Major > Moderate > Minor; within severity, keep original order
  const sevOrder = { Blocker: 0, Major: 1, Moderate: 2, Minor: 3 };
  const sorted = [...findings].sort((a, b) => (sevOrder[a.severity] ?? 99) - (sevOrder[b.severity] ?? 99));
  for (const f of sorted) {
    children.push(...renderFinding(f));
  }

  // Unanchored findings (CLAUDE.md §4.8 — never silently dropped)
  if (unanchored.length > 0) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun('Unanchored findings — manual placement required')],
    }));
    children.push(new Paragraph({
      children: [new TextRun({
        text: 'The following findings could not be anchored to text in the source document. Please review and place manually before sending.',
        italics: true,
      })],
    }));
    for (const f of unanchored) {
      children.push(...renderFinding(f, { unanchored: true }));
    }
  }

  const doc = new Document({
    creator: 'Legal Overflow',
    title: 'Contract Review Summary',
    sections: [{ properties: {}, children }],
  });

  return await Packer.toBuffer(doc);
}

function tableRow(cells, header = false) {
  return new TableRow({
    children: cells.map(c => new TableCell({
      children: [new Paragraph({
        children: [new TextRun({ text: c, bold: header })],
      })],
    })),
  });
}

function renderFinding(f, opts = {}) {
  const out = [];
  const title = `[${f.severity || '—'}] ${f.category || '—'} · ${f.location || 'Unlocated'}`;
  out.push(new Paragraph({
    heading: HeadingLevel.HEADING_2,
    children: [new TextRun({ text: title })],
  }));

  if (f.materiality_rationale) {
    out.push(new Paragraph({
      children: [new TextRun({ text: 'Materiality: ', bold: true }), new TextRun(f.materiality_rationale)],
    }));
  }
  if (f.internal_note) {
    out.push(new Paragraph({
      children: [new TextRun({ text: 'Why it matters: ', bold: true }), new TextRun(f.internal_note)],
    }));
  }
  if (f.position) {
    out.push(new Paragraph({
      children: [new TextRun({ text: 'Position (opening ask): ', bold: true }), new TextRun(f.position)],
    }));
  }
  if (f.fallback) {
    out.push(new Paragraph({
      children: [new TextRun({ text: 'Fallback: ', bold: true }), new TextRun(f.fallback)],
    }));
  }
  if (f.walkaway) {
    out.push(new Paragraph({
      children: [new TextRun({ text: 'Walkaway: ', bold: true }), new TextRun(f.walkaway)],
    }));
  }
  if (f.source_text) {
    out.push(new Paragraph({
      children: [new TextRun({ text: 'Source text: ', bold: true })],
    }));
    out.push(new Paragraph({
      children: [new TextRun({ text: `"${f.source_text}"`, italics: true })],
    }));
  }
  if (f.suggested_text) {
    out.push(new Paragraph({
      children: [new TextRun({ text: 'Proposed language: ', bold: true })],
    }));
    out.push(new Paragraph({
      children: [new TextRun({ text: `"${f.suggested_text}"`, italics: true })],
    }));
  }
  if (f.external_comment) {
    out.push(new Paragraph({
      children: [new TextRun({ text: 'Margin comment (customer-facing): ', bold: true })],
    }));
    out.push(new Paragraph({ children: [new TextRun(f.external_comment)] }));
  }
  if (f.profile_refs && f.profile_refs.length) {
    out.push(new Paragraph({
      children: [
        new TextRun({ text: 'Profile basis: ', bold: true }),
        new TextRun(f.profile_refs.join(', ')),
      ],
    }));
  }
  if (opts.unanchored) {
    out.push(new Paragraph({
      children: [new TextRun({ text: '⚠ Not placed in the document — manual review needed.', bold: true, italics: true })],
    }));
  }
  out.push(new Paragraph({ children: [new TextRun('')] }));
  return out;
}
