// Empirical: extract the same contract from .docx and .pdf via the
// production extractDocumentText() and report on textual equivalence.
import fs from 'node:fs';
import path from 'node:path';
import { extractDocumentText } from '../../netlify/lib/extract.js';

const DOCX = path.resolve('tools/contract-grader/test_contracts/msa_reasoning_test.docx');
const PDF  = path.resolve('tools/contract-grader/test_contracts/msa_reasoning_test.pdf');

const docxBuf = fs.readFileSync(DOCX);
const pdfBuf  = fs.readFileSync(PDF);

const docxRes = await extractDocumentText(docxBuf, 'msa_reasoning_test.docx');
const pdfRes  = await extractDocumentText(pdfBuf,  'msa_reasoning_test.pdf');

const wc = (s) => s.split(/\s+/).filter(Boolean).length;
const lines = (s) => s.split(/\n/).length;
const blanks = (s) => (s.match(/\n\s*\n/g) || []).length;

console.log('=== Extracted text — .docx vs .pdf ===');
console.log(`docx: ${wc(docxRes.text)} words · ${docxRes.text.length} chars · ${lines(docxRes.text)} lines · ${blanks(docxRes.text)} blank-line breaks`);
console.log(`pdf : ${wc(pdfRes.text)} words · ${pdfRes.text.length} chars · ${lines(pdfRes.text)} lines · ${blanks(pdfRes.text)} blank-line breaks · ${pdfRes.pages} pages`);

console.log('\n=== docx — first 600 chars ===');
console.log(JSON.stringify(docxRes.text.slice(0, 600)));

console.log('\n=== pdf — first 600 chars ===');
console.log(JSON.stringify(pdfRes.text.slice(0, 600)));

// Word-level diff: compare a normalized-whitespace version
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const docxN = norm(docxRes.text);
const pdfN = norm(pdfRes.text);
console.log('\n=== Whitespace-normalized comparison ===');
console.log(`docx norm length: ${docxN.length}`);
console.log(`pdf  norm length: ${pdfN.length}`);
console.log(`identical when normalized: ${docxN === pdfN}`);

if (docxN !== pdfN) {
  // Find first divergence
  let i = 0;
  while (i < Math.min(docxN.length, pdfN.length) && docxN[i] === pdfN[i]) i++;
  console.log(`First divergence at char ${i}:`);
  console.log(`  docx context: ${JSON.stringify(docxN.slice(Math.max(0, i - 40), i + 80))}`);
  console.log(`  pdf  context: ${JSON.stringify(pdfN.slice(Math.max(0, i - 40), i + 80))}`);
}

// Count paragraph-style breaks (a key reasoning signal — does the
// specialist see paragraph structure?)
function paragraphSpans(s) {
  // A "paragraph" here = a run of text bounded by blank line(s).
  return s.split(/\n\s*\n+/).filter((p) => p.trim().length > 0).length;
}
console.log('\n=== Paragraph-break count (specialist perception of structure) ===');
console.log(`docx paragraphs: ${paragraphSpans(docxRes.text)}`);
console.log(`pdf  paragraphs: ${paragraphSpans(pdfRes.text)}`);

// Sample: find the section §3.2 ("net 60 days") in each and show how it
// reads to a specialist.
function find(s, needle) {
  const i = s.indexOf(needle);
  if (i < 0) return '<not found>';
  return s.slice(Math.max(0, i - 30), i + 200);
}
console.log('\n=== "net sixty (60) days" context ===');
console.log('docx:', JSON.stringify(find(docxRes.text, 'net sixty (60) days')));
console.log('pdf :', JSON.stringify(find(pdfRes.text, 'net sixty (60) days')));
