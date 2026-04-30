/**
 * Side-by-side extractor + validator comparison across the two test briefs.
 *
 * Usage:
 *   node scripts/compare-briefs.mjs
 *
 * Prints, for each brief:
 *   - Every Pass 1 candidate (provisional type + text)
 *   - Every Pass 3 flag (rule cite + severity + message)
 *   - Total counts
 *
 * The user's Round-11 spec called this out as the diagnostic step:
 *   "instrument the citation extractor to log every citation it
 *    identifies in both briefs. Compare the Acme log to the Titan log."
 *
 * If a citation that exists in Acme isn't in this Pass 1 list, the
 * extractor is missing it. If it IS in Pass 1 but no flag fires, the
 * validator isn't recognizing it. Either way, the gap is visible.
 */

import { readFileSync } from 'node:fs';
import { findCitationCandidates, dropContainedDuplicates } from '../netlify/lib/citation-verifier/citation-patterns.js';
import { runAllValidators } from '../netlify/lib/citation-verifier/validators.js';
import { applyStaticFixes } from '../netlify/lib/citation-verifier/compose-fixes.js';
import { validateSuggestedFix } from '../netlify/lib/citation-verifier/fix-self-check.js';

const BRIEFS = [
  { name: 'ACME',  path: 'tmp/test-corpus/brief_1.txt' },
  { name: 'TITAN', path: 'tmp/test-corpus/brief_2.txt' },
];

function syntheticClassify(c) {
  // Mirror of scripts/regression-run.mjs's synthetic classifier.
  const t = c.candidate_text;
  const provisional = c.provisional_type;
  const caseMatch = t.match(/^(.*?),\s*(\d{1,4})\s+([A-Z][A-Za-z\.\d\s]*?)\s+(\d{1,5})(?:[,\s]+\d+)?(?:\s*\((.*?)(\d{4})\))?/);
  if (provisional === 'case' && caseMatch) {
    const [, caseName, vol, rep, pg, paren, year] = caseMatch;
    return {
      ...c,
      citation_type: 'case',
      candidate_text_hash: 'stub',
      components: {
        case_name: caseName.replace(/^\s*(?:See\s+|See also\s+|Cf\.\s+|Even\s+|See, e\.g\.,\s+)?/i, '').trim(),
        volume: parseInt(vol, 10),
        reporter: (rep || '').trim(),
        first_page: parseInt(pg, 10),
        year: year ? parseInt(year, 10) : null,
        court_parenthetical: paren ? `${paren}${year || ''}`.trim() : null,
      },
      flags: [],
      existence: { status: 'not_applicable' },
    };
  }
  return { ...c, citation_type: provisional, candidate_text_hash: 'stub', components: {}, flags: [], existence: { status: 'not_applicable' } };
}

for (const brief of BRIEFS) {
  console.log(`\n${'='.repeat(70)}\n${brief.name} — ${brief.path}\n${'='.repeat(70)}`);
  const text = readFileSync(brief.path, 'utf8');
  const cands = dropContainedDuplicates(findCitationCandidates(text));
  console.log(`\nPass 1 — ${cands.length} candidates extracted:`);
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    const tx = c.candidate_text.replace(/\s+/g, ' ').slice(0, 90);
    console.log(`  #${String(i).padStart(2, ' ')}  [${c.provisional_type.padEnd(15)}]  "${tx}"`);
  }
  const classified = cands.map(syntheticClassify);
  let flagCount = 0;
  console.log(`\nPass 3 — flags emitted:`);
  for (let i = 0; i < classified.length; i++) {
    const c = classified[i];
    const flags = runAllValidators(c).map((f) => {
      const composed = f.suggested_fix ? applyStaticFixes(f.suggested_fix) : null;
      return { ...f, suggested_fix: composed ? validateSuggestedFix(c, composed) : null };
    });
    if (flags.length === 0) continue;
    const tx = c.candidate_text.replace(/\s+/g, ' ').slice(0, 70);
    console.log(`  #${String(i).padStart(2, ' ')}  "${tx}"`);
    for (const f of flags) {
      flagCount++;
      console.log(`        [${f.severity.padEnd(15)}]  ${f.rule_cite || '(no-rule)'}  ${f.message.slice(0, 80)}`);
    }
  }
  console.log(`\nTOTAL: ${cands.length} candidates, ${flagCount} flags`);
}

console.log('\n' + '='.repeat(70) + '\nDone.\n');
