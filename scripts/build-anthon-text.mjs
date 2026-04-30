/**
 * Build anthon-text.js — extract text from "The Bluebook Uncovered" PDF
 * and inline as a JS module so esbuild bundles it into the function
 * output. Same pattern as scripts/build-skill-text.mjs.
 *
 * Usage:
 *   node scripts/build-anthon-text.mjs <path-to-pdf>
 *
 * Defaults to looking in C:/Users/blake.beyel/Downloads/ if no arg given.
 *
 * The Anthon guide is © 2025 Dionne E. Anthon. The PDF is bundled with
 * the citation-verifier function so Sonnet has the reference text in
 * context for every classification + judgment call. Cached via
 * Anthropic prompt caching (90% discount on every call after the first
 * within a 5-min window).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const pdfPath = args[0] || 'C:/Users/blake.beyel/Downloads/Anthon Bluebook Uncovered (22nd Edition of Bluebook) 2025.08.06 (1).pdf';

console.log(`Reading PDF: ${pdfPath}`);
const buf = readFileSync(pdfPath);

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf), disableFontFace: true }).promise;

console.log(`Pages: ${pdf.numPages}`);
const pageTexts = [];
for (let i = 1; i <= pdf.numPages; i++) {
  const page = await pdf.getPage(i);
  const content = await page.getTextContent();
  pageTexts.push(content.items.map((it) => it.str || '').join(' '));
  if (i % 50 === 0) console.log(`  ...page ${i}/${pdf.numPages}`);
}
const fullText = pageTexts.join('\n\n=== PAGE BREAK ===\n\n');

const out =
  '/**\n' +
  ' * AUTO-GENERATED from "The Bluebook Uncovered" by Dionne E. Anthon\n' +
  ' * (Twenty-Second Edition of The Bluebook), © 2025 Dionne E. Anthon.\n' +
  ' *\n' +
  ' * Used as a cached reference for the Citation Verifier\'s Sonnet calls.\n' +
  ' * The text is the author\'s copyrighted work product (a practical guide\n' +
  ' * to applying the Bluebook), NOT the Bluebook 22e itself. Bundled here\n' +
  ' * so esbuild includes it in the function output.\n' +
  ' *\n' +
  ' * Regenerate with: node scripts/build-anthon-text.mjs\n' +
  ' */\n' +
  'export default ' + JSON.stringify(fullText) + ';\n';

const outPath = join('netlify', 'lib', 'citation-verifier', 'anthon-text.js');
writeFileSync(outPath, out, 'utf8');
console.log(`Wrote ${outPath} (${(out.length / 1024).toFixed(1)} KB)`);
console.log(`Estimated tokens: ${Math.round(fullText.length / 4).toLocaleString()}`);
