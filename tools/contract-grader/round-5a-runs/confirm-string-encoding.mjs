// Round 5a fix-verification — confirm Contents/T fields on every annotation
// in the marked PDF are proper PDF text strings, not Names.
//
// Acrobat throws "Expected a string object." when these fields are encoded
// as PDFName. The two valid encodings per PDF 1.7 §7.9.2 are:
//   • PDFString  — literal `(text)` form, ASCII or PDFDocEncoding
//   • PDFHexString — `<FEFF...>` UTF-16BE with BOM
// Anything else (PDFName, PDFNumber, etc.) is non-spec.
//
// Usage: node tools/contract-grader/round-5a-runs/confirm-string-encoding.mjs <marked.pdf>
import fs from 'node:fs';
import { PDFDocument, PDFName, PDFString, PDFHexString } from 'pdf-lib';

const path = process.argv[2] || 'tools/contract-grader/round-5a-runs/synthetic-delete-marked.pdf';
const buf = fs.readFileSync(path);
const pdfDoc = await PDFDocument.load(buf);

let total = 0, passed = 0;
const failures = [];

for (const page of pdfDoc.getPages()) {
  const annotsRef = page.node.get(PDFName.of('Annots'));
  if (!annotsRef) continue;
  const annots = page.node.context.lookup(annotsRef);
  for (const ref of annots.array) {
    const a = page.node.context.lookup(ref);
    if (!a || !a.get) continue;
    const subtype = a.get(PDFName.of('Subtype')).toString();
    for (const fieldName of ['Contents', 'T']) {
      const field = a.get(PDFName.of(fieldName));
      if (!field) continue;
      total += 1;
      const isString = field instanceof PDFString || field instanceof PDFHexString;
      if (isString) {
        passed += 1;
      } else {
        failures.push({ subtype, field: fieldName, gotClass: field.constructor.name });
      }
    }
  }
}

console.log(`Checked ${total} string fields across all annotations.`);
console.log(`Passed (PDFString or PDFHexString): ${passed}`);
console.log(`Failed: ${failures.length}`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.subtype} /${f.field}: got ${f.gotClass}`);
  process.exit(1);
}
console.log('OK — every Contents/T field is a proper PDF text-string object.');
