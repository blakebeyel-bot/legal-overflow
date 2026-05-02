// probe-fonts.mjs
//
// Diagnose font-dictionary content in a PDF — used to investigate the
// "Font Capture: Windows - Application Error" popup the user saw on the
// marked PDF. Theory: it's caused by something in the source PDF's fonts
// (unembedded, encoded oddly, etc.), not by anything the annotation
// pipeline does. To confirm, run this on the source PDF and the marked
// PDF; if their font sections are identical we know annotations don't
// touch fonts.
//
// Usage: node tools/contract-grader/round-5a-runs/probe-fonts.mjs <file.pdf>

import fs from 'node:fs';
import { PDFDocument, PDFName } from 'pdf-lib';

const path = process.argv[2];
if (!path) {
  console.error('Usage: node probe-fonts.mjs <file.pdf>');
  process.exit(1);
}

const buf = fs.readFileSync(path);
const pdfDoc = await PDFDocument.load(buf);

const fontsByPage = [];
const allFonts = new Map(); // ref-id → font dict

for (let pi = 0; pi < pdfDoc.getPageCount(); pi++) {
  const page = pdfDoc.getPage(pi);
  const resources = page.node.Resources();
  if (!resources) {
    fontsByPage.push({ page: pi + 1, fonts: [] });
    continue;
  }
  const fontsDict = resources.get(PDFName.of('Font'));
  if (!fontsDict) {
    fontsByPage.push({ page: pi + 1, fonts: [] });
    continue;
  }
  const resolved = page.node.context.lookup(fontsDict);
  const pageFonts = [];
  for (const [name, ref] of resolved.entries()) {
    const fontKey = name.toString(); // e.g. /F1
    const font = page.node.context.lookup(ref);
    if (!font) continue;
    const refId = ref.toString();
    pageFonts.push({ key: fontKey, refId });
    allFonts.set(refId, font);
  }
  fontsByPage.push({ page: pi + 1, fonts: pageFonts });
}

console.log(`File: ${path}`);
console.log(`Pages: ${pdfDoc.getPageCount()}`);
console.log(`Unique font dicts referenced: ${allFonts.size}`);
console.log('');

// Per-page font assignment
console.log('--- Per-page font references ---');
for (const p of fontsByPage) {
  console.log(`Page ${p.page}: ${p.fonts.map((f) => `${f.key}=${f.refId}`).join(', ') || '(none)'}`);
}
console.log('');

// For each unique font, dump the dictionary
console.log('--- Font dictionaries ---');
for (const [refId, font] of allFonts) {
  console.log(`Font ${refId}:`);
  if (typeof font.entries !== 'function') {
    console.log(`  (not a dict — ${font.constructor.name})`);
    continue;
  }
  for (const [key, val] of font.entries()) {
    const k = key.toString();
    let v;
    try {
      v = val.toString();
      if (v.length > 120) v = v.slice(0, 120) + '…';
    } catch {
      v = `<${val.constructor.name}>`;
    }
    console.log(`  ${k}: ${v}`);
  }

  // Specifically check: is the font embedded?
  const subtype = font.get(PDFName.of('Subtype'))?.toString();
  const baseFont = font.get(PDFName.of('BaseFont'))?.toString();
  const fontDescriptor = font.get(PDFName.of('FontDescriptor'));
  const encoding = font.get(PDFName.of('Encoding'));
  console.log(`  → Subtype: ${subtype}, BaseFont: ${baseFont}`);
  if (fontDescriptor) {
    const fd = font.context.lookup(fontDescriptor);
    if (fd && typeof fd.entries === 'function') {
      const ff = fd.get(PDFName.of('FontFile'));
      const ff2 = fd.get(PDFName.of('FontFile2'));
      const ff3 = fd.get(PDFName.of('FontFile3'));
      const fontFile = ff || ff2 || ff3;
      console.log(`  → FontDescriptor present. Embedded font stream: ${fontFile ? 'YES' : 'NO (referenced but not embedded)'}`);
      const flags = fd.get(PDFName.of('Flags'));
      if (flags) console.log(`  → Flags: ${flags.toString()}`);
    }
  } else {
    console.log(`  → No FontDescriptor — font likely a Standard 14 (Helvetica/Times/Courier) and not embedded`);
  }
  console.log('');
}
