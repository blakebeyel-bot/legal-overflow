// Inspect PDF annotations on the marked PDF.
import fs from 'node:fs';
import { PDFDocument, PDFName } from 'pdf-lib';

const [, , markedPdf, findingsPath, unanchoredPath] = process.argv;
if (!markedPdf || !findingsPath) {
  console.error('Usage: node inspect_pdf_markup.mjs <marked.pdf> <findings.json> [unanchored.json]');
  process.exit(1);
}

const buf = fs.readFileSync(markedPdf);
const pdfDoc = await PDFDocument.load(buf);

let totalAnnots = 0;
const annotsByType = {};
const allAnnots = [];
for (const page of pdfDoc.getPages()) {
  const node = page.node;
  const annotsRef = node.get(PDFName.of('Annots'));
  if (!annotsRef) continue;
  const annots = node.context.lookup(annotsRef);
  if (!annots || !annots.array) continue;
  for (const ref of annots.array) {
    const a = node.context.lookup(ref);
    if (!a) continue;
    totalAnnots++;
    const subtypeObj = a.get(PDFName.of('Subtype'));
    const subtype = subtypeObj ? subtypeObj.toString().replace('/', '') : '?';
    annotsByType[subtype] = (annotsByType[subtype] || 0) + 1;
    let contents = '';
    const cObj = a.get(PDFName.of('Contents'));
    if (cObj && typeof cObj.value === 'function') contents = cObj.value();
    else if (cObj) contents = cObj.toString();
    allAnnots.push({ subtype, contents: String(contents).slice(0, 100) });
  }
}

console.log('=== PDF annotations ===');
console.log(`File: ${markedPdf}`);
console.log(`Total annotations: ${totalAnnots}`);
console.log(`By subtype:`, annotsByType);

const run = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
const findings = run.accepted_findings || run.findings || [];
const unanchored = unanchoredPath && fs.existsSync(unanchoredPath)
  ? JSON.parse(fs.readFileSync(unanchoredPath, 'utf8')) : [];

const types = {};
for (const f of findings) types[f.markup_type || '?'] = (types[f.markup_type || '?'] || 0) + 1;

console.log('\n=== Findings ===');
console.log(`Total: ${findings.length}`);
console.log(`Markup types:`, types);
console.log(`Unanchored: ${unanchored.length}`);

// Heuristic: comparison
const out = {
  file: markedPdf,
  total_findings: findings.length,
  markup_types: types,
  total_annotations: totalAnnots,
  annotations_by_subtype: annotsByType,
  unanchored_count: unanchored.length,
  unanchored: unanchored.map((u) => ({ id: u.id, markup_type: u.markup_type, source_text_preview: (u.source_text || '').slice(0, 100) })),
  sample_annotations: allAnnots.slice(0, 20),
};
const outPath = markedPdf.replace(/\.pdf$/, '.inspection.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`Wrote ${outPath}`);
