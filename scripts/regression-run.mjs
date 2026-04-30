/**
 * Regression harness — runs Pass 1 + Pass 3 deterministic checks
 * against a brief and reports every flag emitted.
 *
 * Usage:
 *   node scripts/regression-run.mjs tmp/test-corpus/brief_1.txt
 *   node scripts/regression-run.mjs tmp/test-corpus/brief_2.txt
 *
 * Pass 2 (Sonnet) is stubbed via a regex-based classifier so we can
 * test deterministic parts without API access. Pass 2.5 (CourtListener)
 * is skipped — existence flags come back as not_applicable.
 */

import { readFileSync } from 'node:fs';
import { findCitationCandidates, dropContainedDuplicates } from '../netlify/lib/citation-verifier/citation-patterns.js';
import { runAllValidators } from '../netlify/lib/citation-verifier/validators.js';
import { applyStaticFixes } from '../netlify/lib/citation-verifier/compose-fixes.js';
import { validateSuggestedFix } from '../netlify/lib/citation-verifier/fix-self-check.js';

const briefPath = process.argv[2];
if (!briefPath) {
  console.error('Usage: node scripts/regression-run.mjs <path-to-brief.txt>');
  process.exit(1);
}

const text = readFileSync(briefPath, 'utf8');

// Pass 1
const candidates = dropContainedDuplicates(findCitationCandidates(text));
console.log(`\n[Pass 1] ${candidates.length} candidates extracted\n`);

// Synthetic Pass 2 — regex-based component parsing for case citations
function synthesizeClassification(c) {
  const t = c.candidate_text;
  const provisional = c.provisional_type;

  // Case (full): "<name>, <vol> <reporter> <page> (<court year>)"
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
  if (provisional === 'statute') {
    return { ...c, citation_type: 'statute', candidate_text_hash: 'stub', components: {}, flags: [], existence: { status: 'not_applicable' } };
  }
  if (provisional === 'regulation') {
    return { ...c, citation_type: 'regulation', candidate_text_hash: 'stub', components: {}, flags: [], existence: { status: 'not_applicable' } };
  }
  if (provisional === 'court_document') {
    return { ...c, citation_type: 'court_document', candidate_text_hash: 'stub', components: {}, flags: [], existence: { status: 'not_applicable' } };
  }
  if (provisional === 'book') {
    return { ...c, citation_type: 'book', candidate_text_hash: 'stub', components: {}, flags: [], existence: { status: 'not_applicable' } };
  }
  return { ...c, citation_type: 'unknown', candidate_text_hash: 'stub', components: {}, flags: [], existence: { status: 'not_applicable' } };
}

const classified = candidates.map(synthesizeClassification);

// Pass 3
let totalFlags = 0;
let totalSuppressedFixes = 0;
const cited = [];
for (const c of classified) {
  const flags = runAllValidators(c).map((f) => {
    const composed = f.suggested_fix ? applyStaticFixes(f.suggested_fix) : null;
    const cleaned = composed ? validateSuggestedFix(c, composed) : null;
    if (composed && !cleaned) totalSuppressedFixes++;
    return { ...f, suggested_fix: cleaned };
  });
  totalFlags += flags.length;
  cited.push({ candidate: c.candidate_text.replace(/\n/g, ' ').slice(0, 80), flags });
}

console.log(`[Pass 3] ${totalFlags} flags emitted (${totalSuppressedFixes} fixes suppressed by self-check)\n`);

for (const { candidate, flags } of cited) {
  if (flags.length === 0) continue;
  console.log(`  • ${candidate}`);
  for (const f of flags) {
    console.log(`      [${f.severity.padEnd(15)}] ${f.rule_cite}${f.table_cite ? ' (' + f.table_cite + ')' : ''} — ${f.message}`);
    if (f.suggested_fix) console.log(`        ↪ fix: ${f.suggested_fix.replace(/\n/g, ' ')}`);
  }
  console.log('');
}

// Final summary
console.log(`SUMMARY:`);
console.log(`  Candidates extracted:   ${candidates.length}`);
console.log(`  Total flags:            ${totalFlags}`);
console.log(`  Fixes suppressed:       ${totalSuppressedFixes}`);
console.log(`  Citations w/ flags:     ${cited.filter(x => x.flags.length > 0).length}`);
console.log(`  Citations w/o flags:    ${cited.filter(x => x.flags.length === 0).length}`);
