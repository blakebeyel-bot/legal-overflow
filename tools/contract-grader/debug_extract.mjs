import fs from 'node:fs';
import { extractDocumentText } from '../../netlify/lib/extract.js';

const buf = fs.readFileSync('tools/contract-grader/test_contracts/msa_reasoning_test.pdf');
const r = await extractDocumentText(buf, 'msa_reasoning_test.pdf');

// Count paragraphs
const paras = r.text.split(/\n\s*\n+/).filter((p) => p.trim().length > 0);
console.log('Total paragraphs:', paras.length);
console.log('Total chars:', r.text.length);
console.log('Total \\n\\n:', (r.text.match(/\n\n/g) || []).length);
console.log('---first 8 paragraphs---');
for (let i = 0; i < 8; i++) {
  console.log(`\n[${i}] ${paras[i]?.slice(0, 200)}`);
}
console.log('\n---paragraph length stats---');
const lens = paras.map((p) => p.length).sort((a, b) => a - b);
const mid = Math.floor(lens.length / 2);
console.log('min:', lens[0], 'p25:', lens[Math.floor(lens.length * 0.25)], 'median:', lens[mid], 'p75:', lens[Math.floor(lens.length * 0.75)], 'max:', lens[lens.length-1]);
console.log('paragraphs <100 chars:', lens.filter(l => l < 100).length);
console.log('paragraphs >500 chars:', lens.filter(l => l > 500).length);
