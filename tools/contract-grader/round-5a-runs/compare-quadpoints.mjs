// compare-quadpoints.mjs
//
// Dump every StrikeOut/Highlight/Underline annotation's QuadPoints from any
// PDF, with derived metrics (quad height, midY, height-vs-fontsize ratio,
// midY-relative-to-bottom). Used to compare what Adobe's native Strikethrough
// tool writes vs what addStrikeOutAnnotation() writes for the same text, so
// we can match Adobe's geometry exactly.
//
// Usage:
//   node tools/contract-grader/round-5a-runs/compare-quadpoints.mjs <file.pdf>
//   node compare-quadpoints.mjs adobe-manual-strike.pdf > adobe.txt
//   node compare-quadpoints.mjs synthetic-delete-marked.pdf > ours.txt
//   diff adobe.txt ours.txt

import fs from 'node:fs';
import { PDFDocument, PDFName } from 'pdf-lib';

const path = process.argv[2];
if (!path) {
  console.error('Usage: node compare-quadpoints.mjs <file.pdf>');
  process.exit(1);
}

const buf = fs.readFileSync(path);
const pdfDoc = await PDFDocument.load(buf);

let totalAnnots = 0;
const interesting = ['/StrikeOut', '/Highlight', '/Underline', '/Squiggly'];

for (let pi = 0; pi < pdfDoc.getPageCount(); pi++) {
  const page = pdfDoc.getPage(pi);
  const annotsRef = page.node.get(PDFName.of('Annots'));
  if (!annotsRef) continue;
  const annots = page.node.context.lookup(annotsRef);
  if (!annots?.array) continue;
  for (const ref of annots.array) {
    const a = page.node.context.lookup(ref);
    if (!a || typeof a.get !== 'function') continue;
    const subtype = a.get(PDFName.of('Subtype')).toString();
    if (!interesting.includes(subtype)) continue;
    totalAnnots++;
    const qp = a.get(PDFName.of('QuadPoints'));
    const rect = a.get(PDFName.of('Rect'));
    const c = a.get(PDFName.of('C'));
    const t = a.get(PDFName.of('T'));
    const qpArr = qp.array.map((n) => Number(n.toString()));
    const rectArr = rect.array.map((n) => Number(n.toString()));
    const cArr = c?.array?.map((n) => Number(n.toString())) || null;

    console.log(`--- page ${pi + 1}, annotation #${totalAnnots} ---`);
    console.log(`Subtype: ${subtype}`);
    if (t) console.log(`T (author): ${t.toString()}`);
    console.log(`Rect [llx,lly,urx,ury]: [${rectArr.map((n) => n.toFixed(3)).join(', ')}]`);
    console.log(`Color (C): ${cArr ? '[' + cArr.map((n) => n.toFixed(3)).join(', ') + ']' : '(none)'}`);
    console.log(`QuadPoints (${qpArr.length} numbers, ${qpArr.length / 8} quadrilateral${qpArr.length !== 8 ? 's' : ''}):`);
    for (let q = 0; q < qpArr.length; q += 8) {
      const TLx = qpArr[q + 0], TLy = qpArr[q + 1];
      const TRx = qpArr[q + 2], TRy = qpArr[q + 3];
      const BLx = qpArr[q + 4], BLy = qpArr[q + 5];
      const BRx = qpArr[q + 6], BRy = qpArr[q + 7];
      const quadHeight = TLy - BLy;
      const quadWidth = TRx - TLx;
      const midY = (TLy + BLy) / 2;
      const midX = (TLx + TRx) / 2;
      console.log(`  Quad ${q / 8 + 1}: TL(${TLx.toFixed(2)}, ${TLy.toFixed(2)})  TR(${TRx.toFixed(2)}, ${TRy.toFixed(2)})  BL(${BLx.toFixed(2)}, ${BLy.toFixed(2)})  BR(${BRx.toFixed(2)}, ${BRy.toFixed(2)})`);
      console.log(`           width=${quadWidth.toFixed(2)}, height=${quadHeight.toFixed(2)}, midY=${midY.toFixed(2)} (=BL.y + ${(midY - BLy).toFixed(2)} = ${((midY - BLy) / quadHeight * 100).toFixed(0)}% from bottom)`);
    }
    console.log('');
  }
}

console.log(`=== Total ${interesting.join('/')} annotations: ${totalAnnots} ===`);
