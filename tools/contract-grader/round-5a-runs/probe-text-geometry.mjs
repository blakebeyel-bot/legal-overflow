// Diagnostic probe — print the coordinate system for one matched phrase
// in the test PDF, to verify what yTop / item.height mean in pdf-space.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';

const buf = fs.readFileSync('tools/contract-grader/test_contracts/msa_reasoning_test.pdf');
const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf), disableFontFace: true }).promise;

const targetSubstr = process.argv[2] || 'percent';

for (let p = 1; p <= pdf.numPages; p++) {
  const page = await pdf.getPage(p);
  const tc = await page.getTextContent();
  const viewport = page.getViewport({ scale: 1 });
  const pageHeight = viewport.viewBox[3];
  for (const item of tc.items) {
    if (!item.str?.includes(targetSubstr)) continue;
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const yTop = pageHeight - tx[5];
    const baseline = item.transform[5]; // raw pdf-space baseline (bottom-up)
    console.log('=== match on page', p, '===');
    console.log('pageHeight:', pageHeight);
    console.log('item.str:', JSON.stringify(item.str));
    console.log('item.width × height:', item.width, '×', item.height);
    console.log('item.transform:', item.transform);
    console.log('  raw baseline (pdf-space, bottom-up) =', baseline);
    console.log('  font scale (transform[3])         =', item.transform[3]);
    console.log('viewport tx[4,5] (top-down):', tx[4], tx[5]);
    console.log('');
    console.log('Current addStrikeOutAnnotation call site computes:');
    console.log('  yTop = pageHeight - tx[5] =', yTop, '   (this is in pdf-lib bottom-up coords)');
    console.log('  passes y = yTop - height =', yTop - item.height);
    console.log('  → quad bottom edge:', yTop - item.height);
    console.log('  → quad top    edge:', yTop);
    console.log('  → strike midpoint:', yTop - item.height/2);
    console.log('');
    console.log('What we WANT (strike through middle of text):');
    console.log('  text baseline (raw) =', baseline);
    console.log('  text glyph top   ≈ baseline + height =', baseline + item.height);
    console.log('  → quad bottom (baseline)   =', baseline);
    console.log('  → quad top    (glyph top)  =', baseline + item.height);
    console.log('  → strike midpoint          =', baseline + item.height/2);
    console.log('');
    console.log('Compare: yTop vs raw baseline   →  yTop=' + yTop + ', baseline=' + baseline + '  (equal? ' + (Math.abs(yTop - baseline) < 0.01) + ')');
    process.exit(0);
  }
}
console.log('phrase not found');
