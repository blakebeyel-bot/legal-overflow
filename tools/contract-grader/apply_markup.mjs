// Take a findings JSON (from the harness) + the original contract file
// and produce the marked-up output exactly as fanout-background.js does.
// Usage:
//   node apply_markup.mjs <findings.json> <contract.docx|contract.pdf> <output.{docx,pdf}>
import fs from 'node:fs';
import path from 'node:path';

for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'stub';

import { applyDocxMarkup } from '../../netlify/lib/markup-docx.js';
import { applyPdfMarkup } from '../../netlify/lib/markup-pdf.js';

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

let result;
if (ext === '.docx') {
  result = await applyDocxMarkup(contractBuf, findings);
} else if (ext === '.pdf') {
  result = await applyPdfMarkup(contractBuf, findings);
} else {
  throw new Error(`Unsupported format: ${ext}`);
}

fs.writeFileSync(outputPath, result.buffer);
const unanchored = result.unanchored || [];
console.log(`[apply_markup] unanchored: ${unanchored.length}`);
if (unanchored.length) {
  for (const u of unanchored) console.log(`  - ${u.id || '(no id)'}: ${u.markup_type} | ${(u.source_text || '').slice(0, 80)}`);
}

// Also write an unanchored manifest
fs.writeFileSync(outputPath + '.unanchored.json', JSON.stringify(unanchored, null, 2));
console.log(`[apply_markup] wrote ${outputPath} and ${outputPath}.unanchored.json`);
