// Reproduce my algorithm with logging to see where it goes wrong.
import fs from 'node:fs';

const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
const buf = fs.readFileSync('tools/contract-grader/test_contracts/msa_reasoning_test.pdf');
const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf), disableFontFace: true }).promise;

const page = await pdf.getPage(1);
const content = await page.getTextContent();

// Step 1: group items into lines
const lines = [];
let cur = null;
for (const it of content.items) {
  const str = it.str || '';
  const hasEol = !!it.hasEOL;
  if (!str && !hasEol) continue;
  const y = (it.transform && it.transform[5]) || 0;
  const h = it.height || 0;
  const tol = Math.max(2, ((cur && cur.h) || h || 12) * 0.4);
  if (cur && Math.abs(cur.y - y) <= tol) {
    cur.parts.push(str);
    if (hasEol) cur.eol = true;
  } else {
    if (cur) lines.push(cur);
    cur = { y, h: h || (cur ? cur.h : 12), parts: [str], eol: hasEol };
  }
}
if (cur) lines.push(cur);

console.log(`Page 1: ${lines.length} lines from ${content.items.length} items`);
for (let i = 0; i < lines.length; i++) {
  const ln = lines[i];
  const gap = i > 0 ? lines[i-1].y - ln.y : 0;
  console.log(`  [${i}] y=${ln.y.toFixed(1)} h=${ln.h} eol=${ln.eol} gap=${gap.toFixed(1)} | ${ln.parts.join(' ').slice(0, 60)}`);
}

// Compute median
const gaps = [];
for (let i = 1; i < lines.length; i++) {
  const g = lines[i - 1].y - lines[i].y;
  if (g > 0) gaps.push(g);
}
gaps.sort((a, b) => a - b);
const medianGap = gaps[Math.floor(gaps.length / 2)] || 14;
const paraThreshold = Math.max(medianGap * 1.3, medianGap + 4);
console.log(`\nMedian gap: ${medianGap}, threshold: ${paraThreshold}`);
