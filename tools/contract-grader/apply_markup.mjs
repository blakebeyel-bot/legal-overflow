// Apply a findings JSON to the source DOCX/PDF using the in-tree markup
// helpers. Mirrors what fanout-background.js does in stage 6, but locally
// against a saved findings file from harness.mjs.
//
// Usage:
//   node apply_markup.mjs <findings.json> <contract.docx|pdf> <output>
import fs from 'node:fs';
import path from 'node:path';

// Bootstrap env so the markup helpers (which lazy-load anthropic etc.) work
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'stub';

import { applyDocxMarkup } from '../../netlify/lib/markup-docx.js';
// PDF goes through the Modal/PyMuPDF wrapper. Imported dynamically AFTER
// the .env bootstrap so MODAL_PDF_MARKUP_URL / MARKUP_SHARED_TOKEN are
// visible at module-load time (markup-pdf-modal.js reads them at import).
const { applyPdfMarkup } = await import('../../netlify/lib/markup-pdf-modal.js');

const [, , findingsPath, contractPath, outputPath] = process.argv;
if (!findingsPath || !contractPath || !outputPath) {
  console.error('Usage: node apply_markup.mjs <findings.json> <contract> <output>');
  process.exit(1);
}

const run = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
const contractBuf = fs.readFileSync(contractPath);
const ext = path.extname(contractPath).toLowerCase();

const findings = run.accepted_findings || run.findings || [];
console.log(`[apply_markup] ${findings.length} findings → ${outputPath}`);

// Pull the reviewer name out of the run's profile snapshot if present —
// matches fanout-background.js's resolution chain.
const reviewerName =
  run.profile?.output?.reviewer_author ||
  run.profile_used?.output?.reviewer_author ||
  'Legal Overflow';

let result;
if (ext === '.docx') {
  result = await applyDocxMarkup(contractBuf, findings, { author: reviewerName });
} else if (ext === '.pdf') {
  result = await applyPdfMarkup(contractBuf, findings, { author: reviewerName });
} else {
  throw new Error(`Unsupported format: ${ext}`);
}

fs.writeFileSync(outputPath, result.buffer);
const unanchored = result.unanchored || [];
console.log(`[apply_markup] applied: ${result.applied}, unanchored: ${unanchored.length}`);
if (unanchored.length) {
  for (const u of unanchored) console.log(`  - ${u.id || '(no id)'}: ${u.markup_type} | ${(u.source_text || '').slice(0, 80)}`);
}
fs.writeFileSync(outputPath + '.unanchored.json', JSON.stringify(unanchored, null, 2));
console.log(`[apply_markup] wrote ${outputPath}`);
