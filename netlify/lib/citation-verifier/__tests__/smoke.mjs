/**
 * Citation Verifier — Pass 1 manual smoke run.
 *
 * Not part of the automated test suite. Run this whenever you want to eyeball
 * the candidate output against the fixture brief. Useful when adding new
 * regex patterns or debugging reach-back behavior.
 *
 *     node netlify/lib/citation-verifier/__tests__/smoke.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { findCitationCandidates, dropContainedDuplicates } from '../citation-patterns.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sample = readFileSync(join(__dirname, 'fixtures/sample-brief.txt'), 'utf8');

const cands = dropContainedDuplicates(findCitationCandidates(sample));

console.log(`Detected ${cands.length} candidates in sample-brief.txt:\n`);
for (const c of cands) {
  const truncated = c.candidate_text.length > 80
    ? c.candidate_text.slice(0, 77) + '...'
    : c.candidate_text;
  console.log(
    `  [${c.provisional_type.padEnd(20)}] ` +
    `[${String(c.char_start).padStart(4)}-${String(c.char_end).padEnd(4)}] ` +
    `"${truncated}"`
  );
}
