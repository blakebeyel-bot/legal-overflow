// Build a born-digital PDF version of the test contract by re-rendering
// the same source text used to create the .docx — produces the most
// representative born-digital PDF (text layer faithful, no OCR artifacts).
// pdf-lib is already a dependency.
import fs from 'node:fs';
import path from 'node:path';
import mammoth from 'mammoth';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const DOCX = path.resolve('tools/contract-grader/test_contracts/msa_reasoning_test.docx');
const OUT = path.resolve('tools/contract-grader/test_contracts/msa_reasoning_test.pdf');

// Extract text from the .docx via mammoth so PDF body matches DOCX body.
const { value: rawText } = await mammoth.extractRawText({ path: DOCX });

const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);

const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.TimesRoman);
const fontBold = await pdf.embedFont(StandardFonts.TimesRomanBold);

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 72;
const LINE_HEIGHT = 14;
const FONT_SIZE = 11;
const MAX_W = PAGE_W - 2 * MARGIN;

let page = pdf.addPage([PAGE_W, PAGE_H]);
let y = PAGE_H - MARGIN;

function newPage() {
  page = pdf.addPage([PAGE_W, PAGE_H]);
  y = PAGE_H - MARGIN;
}

function wrap(text, f, size) {
  const words = text.split(/\s+/);
  const out = [];
  let cur = '';
  for (const w of words) {
    const trial = cur ? cur + ' ' + w : w;
    const width = f.widthOfTextAtSize(trial, size);
    if (width > MAX_W && cur) {
      out.push(cur);
      cur = w;
    } else {
      cur = trial;
    }
  }
  if (cur) out.push(cur);
  return out;
}

for (const line of lines) {
  // Heading detection: short uppercase-ish line containing a section number,
  // or the title.
  const isTitle = line === 'MASTER SUBSCRIPTION AGREEMENT';
  const isCompany = line === 'Lattice Telemetry, Inc.';
  const isHeading = /^\d{1,2}\.\s+[A-Z]/.test(line) && line.length < 90;

  const f = (isTitle || isHeading) ? fontBold : font;
  const size = isTitle ? 14 : FONT_SIZE;
  const wrapped = wrap(line, f, size);

  for (const w of wrapped) {
    if (y < MARGIN + LINE_HEIGHT) newPage();
    page.drawText(w, { x: MARGIN, y, size, font: f, color: rgb(0, 0, 0) });
    y -= LINE_HEIGHT;
  }
  y -= LINE_HEIGHT * 0.4;
  if (isCompany) y -= LINE_HEIGHT;
}

const bytes = await pdf.save();
fs.writeFileSync(OUT, bytes);
console.log(`Wrote ${OUT}`);
console.log(`Pages: ${pdf.getPageCount()}`);
console.log(`Size: ${bytes.length} bytes`);
