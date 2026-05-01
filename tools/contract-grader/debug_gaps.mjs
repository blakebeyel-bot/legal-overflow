// Inspect the actual y-gaps in the test PDF.
import fs from 'node:fs';
import path from 'node:path';

const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
const buf = fs.readFileSync('tools/contract-grader/test_contracts/msa_reasoning_test.pdf');
const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf), disableFontFace: true }).promise;

const page = await pdf.getPage(1);
const content = await page.getTextContent();
console.log(`Page 1: ${content.items.length} items`);
// Show first 30 items with their y/height
for (let i = 0; i < Math.min(30, content.items.length); i++) {
  const it = content.items[i];
  const y = it.transform?.[5];
  console.log(`  [${i}] y=${y} h=${it.height} hasEOL=${it.hasEOL ?? 'undef'} str=${JSON.stringify(it.str?.slice(0, 60))}`);
}
console.log('...');

// Compute gaps between consecutive items
const gapHist = {};
for (let i = 1; i < content.items.length; i++) {
  const a = content.items[i - 1].transform?.[5];
  const b = content.items[i].transform?.[5];
  if (a == null || b == null) continue;
  const gap = Math.round(a - b);
  gapHist[gap] = (gapHist[gap] || 0) + 1;
}
console.log('Gap histogram (items consecutive):');
for (const k of Object.keys(gapHist).map(Number).sort((a,b)=>a-b)) {
  console.log(`  ${k}: ${gapHist[k]}`);
}
