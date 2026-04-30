/**
 * Citation Verifier — local dry-run.
 *
 * Exercises the deterministic parts of the pipeline (Pass 1 extraction,
 * Pass 3 validators, Pass 5a report) against the planted-error fixture
 * brief — no API keys required, no network calls. Produces:
 *
 *   tmp/citation-verifier-dry-run/form-check-report.docx
 *
 * Open that file in Word to see what the actual report looks like.
 *
 * Run from site/ with:
 *   node scripts/citation-verifier-dry-run.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  findCitationCandidates, dropContainedDuplicates,
} from '../netlify/lib/citation-verifier/citation-patterns.js';
import { runAllValidators } from '../netlify/lib/citation-verifier/validators.js';
import { buildFormReport } from '../netlify/lib/citation-verifier/form-report.js';
import { sha256Hex } from '../netlify/lib/citation-verifier/extract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(
  __dirname, '..',
  'netlify', 'lib', 'citation-verifier', '__tests__',
  'fixtures', 'corpus-fixture-2-planted-errors.txt'
);
const outDir = join(__dirname, '..', 'tmp', 'citation-verifier-dry-run');
mkdirSync(outDir, { recursive: true });

const text = readFileSync(fixturePath, 'utf8');
console.log(`\n[dry-run] Loaded fixture: ${fixturePath}`);
console.log(`[dry-run] Length: ${text.length} chars\n`);

// ---- Pass 1: extract candidates ------------------------------------------
const candidates = dropContainedDuplicates(findCitationCandidates(text));
console.log(`[Pass 1] Extracted ${candidates.length} citation candidates:`);
for (const c of candidates) {
  const truncated = c.candidate_text.length > 60
    ? c.candidate_text.slice(0, 57) + '...'
    : c.candidate_text;
  console.log(
    `  [${c.provisional_type.padEnd(20)}] [${String(c.char_start).padStart(4)}-${String(c.char_end).padEnd(4)}] "${truncated.replace(/\n/g, ' ')}"`
  );
}

// ---- Synthetic Pass 2: hand-classify the candidates we know about --------
// In production, Sonnet does this. For the dry-run we hand-assign components
// based on the regex matches so we can exercise Pass 3 + Pass 5 against
// realistic inputs.
const classifications = candidates.map((c) => {
  const synthetic = synthesizeClassification(c.candidate_text, c.provisional_type);
  return {
    ...c,
    candidate_text_hash: sha256Hex(Buffer.from(c.candidate_text, 'utf8')),
    citation_type: synthetic.citation_type,
    components: synthetic.components,
    governing_rule: synthetic.governing_rule,
    governing_table: synthetic.governing_table,
    flags: [],                       // Pass 3 fills this in
    existence: { status: 'not_applicable' }, // Pass 2.5 normally fills
  };
});

// Debug: show parsed components per citation
console.log(`\n[Synthetic Pass 2] Component parses:`);
for (const c of classifications) {
  if (c.citation_type === 'case') {
    console.log(`  • "${truncate(c.candidate_text.replace(/\n/g, ' '), 50)}"`);
    console.log(`      case_name: "${c.components.case_name || '(none)'}"`);
    console.log(`      reporter:  "${c.components.reporter || '(none)'}"  year: ${c.components.year || '(none)'}  paren: "${c.components.court_parenthetical || '(none)'}"`);
  }
}

// ---- Pass 3: run validators ----------------------------------------------
let totalFlags = 0;
for (const c of classifications) {
  c.flags = runAllValidators(c);
  totalFlags += c.flags.length;
}
console.log(`\n[Pass 3] Validators emitted ${totalFlags} flag(s):`);
for (const c of classifications) {
  if (c.flags.length === 0) continue;
  console.log(`  • ${truncate(c.candidate_text, 55)}`);
  for (const f of c.flags) {
    console.log(`      [${f.severity.padEnd(15)}] ${f.rule_cite || ''} ${f.table_cite ? '(' + f.table_cite + ')' : ''} ${f.message}`);
    if (f.suggested_fix) console.log(`        ↪ fix: ${f.suggested_fix}`);
  }
}

// ---- Pass 5a: build the form report --------------------------------------
const fakeRun = {
  id: '00000000-0000-0000-0000-dryRun00001',
  user_id: 'dry-run-user',
  file_name: 'corpus-fixture-2-planted-errors.txt',
  file_format: 'docx',
  bluebook_edition: '22e',
  ruleset: 'federal',
  style: 'bluepages',
};

const reportBuf = await buildFormReport({
  run: fakeRun,
  citations: classifications,
  documentFlags: [],
});
const reportPath = join(outDir, 'form-check-report.docx');
writeFileSync(reportPath, reportBuf);

console.log(`\n[Pass 5a] Form-check report written:`);
console.log(`   ${reportPath}`);
console.log(`   ${reportBuf.length.toLocaleString()} bytes`);

console.log(`\n[dry-run] Done. Open the .docx in Word to see the live report layout.\n`);

// ===========================================================================
// helpers
// ===========================================================================

function synthesizeClassification(text, provisionalType) {
  // Quick best-effort component parser purely so the validators have
  // something to chew on. Production uses Sonnet.

  // Case citation: "<Name>, <Vol> <Reporter> <Page> (<Court Year>)"
  // Reporter may contain digits (F.3d, S.W.2d, So. 3d, etc.) so the
  // character class must allow them.
  const caseMatch = text.match(/^(.*?),\s*(\d{1,4})\s+([A-Za-z][A-Za-z\.\d\s]*?)\s+(\d{1,5})(?:[,\s]+\d+)?(?:\s*\((.*?)(\d{4})\))?/);
  if (provisionalType === 'case' && caseMatch) {
    const [, caseName, volume, rawReporter, firstPage, courtParen, year] = caseMatch;
    const reporter = (rawReporter || '').trim();
    return {
      citation_type: 'case',
      components: {
        case_name: caseName.replace(/^\s*(?:See\s+|See also\s+|Cf\.\s+)?/, '').trim(),
        volume: parseInt(volume, 10),
        reporter,
        first_page: parseInt(firstPage, 10),
        year: year ? parseInt(year, 10) : null,
        court_parenthetical: courtParen ? `${courtParen}${year || ''}`.trim() : null,
      },
      governing_rule: 'BB R. 10',
      governing_table: 'T1; T6; T7',
    };
  }
  if (provisionalType === 'statute') {
    return { citation_type: 'statute', components: {}, governing_rule: 'BB R. 12', governing_table: 'T1.1' };
  }
  if (provisionalType === 'regulation') {
    return { citation_type: 'regulation', components: {}, governing_rule: 'BB R. 14', governing_table: null };
  }
  if (provisionalType === 'constitutional') {
    return { citation_type: 'constitutional', components: {}, governing_rule: 'BB R. 11', governing_table: null };
  }
  if (provisionalType === 'short_form_id') {
    return { citation_type: 'short_form_id', components: {}, governing_rule: 'BB R. 4.1', governing_table: null };
  }
  return { citation_type: 'unknown', components: {}, governing_rule: null, governing_table: null };
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 3) + '...' : s;
}
