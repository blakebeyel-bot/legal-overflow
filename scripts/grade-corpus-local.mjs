/**
 * Local pipeline runner for the auto-grader.
 *
 * Reads source .docx briefs from site/tools/grader/grader/source_briefs/,
 * runs Pass 1 (regex extraction) + synthetic Pass 2 (regex classifier) +
 * Pass 3 (deterministic validators) + Pass 5b (DOCX markup), and writes
 * marked .docx files into site/tools/grader/grader/inputs/.
 *
 * Then invokes the Python grader (run_corpus.py) and propagates exit code.
 *
 * Why synthetic Pass 2: production runs Sonnet for classification +
 * components, but the deterministic validators (Round 13 rules) only
 * need provisional_type and candidate_text + a few derived fields.
 * Synthetic Pass 2 is enough to exercise every rule the grader checks.
 *
 * Pass 4 (cross-citation LLM judge) is not invoked here — Round 13 added
 * defensive filters in the prompt but the grader scores deterministic
 * catches only.
 *
 * Usage (from site/):
 *   node scripts/grade-corpus-local.mjs
 *   node scripts/grade-corpus-local.mjs --prev-dir=tools/grader/grader/last_run
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { extractDocxForCitations } from '../netlify/lib/citation-verifier/extract-docx.js';
import { runAllValidators } from '../netlify/lib/citation-verifier/validators.js';
import { applyStaticFixes } from '../netlify/lib/citation-verifier/compose-fixes.js';
import { validateSuggestedFix } from '../netlify/lib/citation-verifier/fix-self-check.js';
import { applyCitationMarkupDocx } from '../netlify/lib/citation-verifier/markup-docx-citations.js';
import { sha256Hex } from '../netlify/lib/citation-verifier/extract.js';
import { scanDocumentIssues } from '../netlify/lib/citation-verifier/scan-document-issues.js';
import { findSecondarySourceCandidates } from '../netlify/lib/citation-verifier/secondary-source-patterns.js';
import { findOfficialSourceCandidates } from '../netlify/lib/citation-verifier/official-source-patterns.js';
import { attachCitationState } from '../netlify/lib/citation-verifier/citation-state-tracker.js';
import { findForeignSourceCandidates } from '../netlify/lib/citation-verifier/foreign-source-patterns.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const GRADER_DIR = join(ROOT, 'tools', 'grader', 'grader');
const SOURCE_DIR = join(GRADER_DIR, 'source_briefs');
const INPUTS_DIR = join(GRADER_DIR, 'inputs');

const CORPUS = ['acme', 'titan', 'brief3', 'brief4', 'brief5', 'brief6', 'brief7', 'brief8'];

const args = new Map();
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--')) {
    const [k, v] = a.replace(/^--/, '').split('=');
    args.set(k, v ?? true);
  }
}

mkdirSync(INPUTS_DIR, { recursive: true });

// Reporter alternation — explicit longest-first list to prevent the synthetic
// Pass 2 regex from splitting "F. Supp. 2d" into reporter="F. Supp." +
// page="2" (which would null out court_parenthetical and trigger a spurious
// R. 10.4 missing-parenthetical flag). MUST be defined before
// synthesizeClassification is called below.
const REPORTER_ALTS = [
  'F\\. ?Supp\\. ?3d', 'F\\. ?Supp\\. ?2d', 'F\\. ?Supp\\.',
  'F\\.4th', 'F\\.3d', 'F\\.2d', 'F\\.',
  'U\\.S\\.', 'S\\. ?Ct\\.', 'L\\. ?Ed\\. ?2d', 'L\\. ?Ed\\.',
  'F\\.R\\.D\\.', 'B\\.R\\.', 'Bankr\\.', 'T\\.C\\.',
  'A\\.3d', 'A\\.2d', 'A\\.',
  'P\\.3d', 'P\\.2d', 'P\\.',
  'N\\.E\\.3d', 'N\\.E\\.2d', 'N\\.E\\.',
  'N\\.W\\.3d', 'N\\.W\\.2d', 'N\\.W\\.',
  'S\\.E\\.2d', 'S\\.E\\.', 'S\\.W\\.3d', 'S\\.W\\.2d', 'S\\.W\\.',
  'So\\. ?3d', 'So\\. ?2d', 'So\\.',
  'Cal\\. ?Rptr\\. ?3d', 'Cal\\. ?Rptr\\. ?2d', 'Cal\\. ?Rptr\\.',
  'Cal\\. ?App\\. ?5th', 'Cal\\. ?App\\. ?4th', 'Cal\\. ?App\\. ?3d', 'Cal\\. ?App\\. ?2d', 'Cal\\. ?App\\.',
  'Cal\\. ?5th', 'Cal\\. ?4th', 'Cal\\. ?3d', 'Cal\\. ?2d', 'Cal\\.',
  'N\\.Y\\.3d', 'N\\.Y\\.2d', 'N\\.Y\\.',
  'A\\.D\\.3d', 'A\\.D\\.2d', 'A\\.D\\.',
  'Mass\\. ?App\\. ?Ct\\.', 'Mass\\.',
  'Eng\\. ?Rep\\.', 'Ex\\.',
  // Malformed (no/missing periods)
  'U\\.S(?!\\.)', 'US',
];
const REPORTER_RE = `(?:${REPORTER_ALTS.join('|')})`;
const CASE_REGEX = new RegExp(
  '^(.*?),\\s*(\\d{1,4})\\s+(' + REPORTER_RE + ')\\s+(\\d{1,5})(?:[,\\s]+\\d+(?:[\\u2013\\-]\\d+)?)*(?:\\s*\\((.*?)(\\d{4})\\))?'
);

console.log(`[grade-corpus-local] Source briefs: ${SOURCE_DIR}`);
console.log(`[grade-corpus-local] Marked outputs: ${INPUTS_DIR}\n`);

for (const name of CORPUS) {
  const srcPath = join(SOURCE_DIR, `${name}.docx`);
  if (!existsSync(srcPath)) {
    console.error(`  ⚠️  ${name}: source not found at ${srcPath} — skip`);
    continue;
  }
  const buf = readFileSync(srcPath);

  // Pass 1: extract candidates from .docx (body + footnotes)
  const ext = await extractDocxForCitations(buf);
  // Round 15 — also scan for document-level issues (ellipsis, block quotes,
  // capitalization). They come back as synthetic candidates with pre-
  // attached flags and flow through markup unchanged.
  const documentIssues = scanDocumentIssues(ext.text || '');
  // Round 16 — secondary-source extractor (books, articles, manuscripts,
  // forthcoming, internet). Produces candidates that flow through Pass 3
  // validators just like case candidates.
  const secondaryCandidates = findSecondarySourceCandidates(ext.text || '');
  // Round 17 — official sources (constitutional, legislative, administrative).
  const officialCandidates = findOfficialSourceCandidates(ext.text || '');
  // Round 20 — foreign cases, treaties, international tribunals, specialty federal courts
  const foreignCandidates = findForeignSourceCandidates(ext.text || '');
  const candidates = [...ext.candidates, ...secondaryCandidates, ...officialCandidates, ...foreignCandidates, ...documentIssues];

  // Synthetic Pass 2: regex-based classification + component parse.
  // Production uses Sonnet; for grading we cover the deterministic rules
  // by bucketing on provisional_type and parsing components for `case`.
  // Synthetic candidates from scanDocumentIssues already carry their own
  // citation_type='document_annotation' and pre-attached flags; pass them
  // through unchanged.
  const classified = candidates.map((c) => {
    if (c.provisional_type === 'document_annotation') {
      // Already classified + flagged by the doc-issue scanner.
      return { ...c };
    }
    // Secondary-source provisional types map straight through to citation_type;
    // the synth Pass 2 doesn't try to parse components for them — the
    // validators read candidate_text directly.
    if ([
      'book', 'article', 'manuscript', 'forthcoming', 'internet', 'news_article',
      'constitutional', 'legislative_report', 'legislative_hearing', 'cong_rec', 'bill',
      'fed_reg', 'exec_order',
      'foreign_case', 'multilateral_treaty', 'bilateral_treaty',
      'icj_case', 'echr_case', 'tribunal_case', 'tcm_case',
    ].includes(c.provisional_type)) {
      return {
        ...c,
        candidate_text_hash: sha256Hex(Buffer.from(c.candidate_text, 'utf8')),
        citation_type: c.provisional_type,
        components: {},
        governing_rule: c.provisional_type === 'book' ? 'BB R. 15'
                       : c.provisional_type === 'article' ? 'BB R. 16'
                       : c.provisional_type === 'manuscript' ? 'BB R. 17.1'
                       : c.provisional_type === 'forthcoming' ? 'BB R. 17.2'
                       : c.provisional_type === 'news_article' ? 'BB R. 18.2'
                       : c.provisional_type === 'constitutional' ? 'BB R. 11'
                       : c.provisional_type === 'legislative_report' ? 'BB R. 13.4'
                       : c.provisional_type === 'legislative_hearing' ? 'BB R. 13.3'
                       : c.provisional_type === 'cong_rec' ? 'BB R. 13.5'
                       : c.provisional_type === 'bill' ? 'BB R. 13.2'
                       : c.provisional_type === 'fed_reg' ? 'BB R. 14.2'
                       : c.provisional_type === 'exec_order' ? 'BB R. 14.7'
                       : c.provisional_type === 'foreign_case' ? 'BB R. 20'
                       : c.provisional_type === 'multilateral_treaty' ? 'BB R. 21.4'
                       : c.provisional_type === 'bilateral_treaty' ? 'BB R. 21.4'
                       : c.provisional_type === 'icj_case' ? 'BB R. 21'
                       : c.provisional_type === 'echr_case' ? 'BB R. 21'
                       : c.provisional_type === 'tribunal_case' ? 'BB R. 21'
                       : c.provisional_type === 'tcm_case' ? 'BB R. 10'
                       : 'BB R. 18',
        governing_table: c.provisional_type === 'article' ? 'T13' : null,
        flags: [],
        existence: { status: 'not_applicable' },
      };
    }
    const synth = synthesizeClassification(c.candidate_text, c.provisional_type);
    return {
      ...c,
      candidate_text_hash: sha256Hex(Buffer.from(c.candidate_text, 'utf8')),
      citation_type: synth.citation_type,
      components: synth.components,
      governing_rule: synth.governing_rule,
      governing_table: synth.governing_table,
      flags: [],
      existence: { status: 'not_applicable' },
    };
  });

  // Round 19 — attach citation state (previous_citation, is_string_cite,
  // case_state, hereinafter_registry) so state-aware validators can fire.
  attachCitationState(classified, ext.text || '');

  // Pass 3: validators. Preserve pre-attached flags on document-annotation
  // synthetic candidates (runAllValidators correctly returns [] for them
  // since they aren't real citations).
  let totalFlags = 0;
  for (const c of classified) {
    // Round 18 — pass document text so validators can do document-level
    // checks (e.g., supra-for-cases needs to look up author vs. case).
    c.document_text = ext.text || '';
    const preAttached = Array.isArray(c.flags) ? c.flags : [];
    const raw = runAllValidators(c);
    const merged = [...preAttached, ...raw];
    c.flags = merged.map((f) => {
      const composed = f.suggested_fix ? applyStaticFixes(f.suggested_fix) : null;
      const cleaned = composed ? validateSuggestedFix(c, composed) : null;
      return { ...f, suggested_fix: cleaned };
    });
    totalFlags += c.flags.length;
  }

  // Pass 5b: apply citation markup → marked .docx buffer
  const { buffer: marked, applied, unanchored } = await applyCitationMarkupDocx(buf, classified);
  const outPath = join(INPUTS_DIR, `${name}.docx`);
  writeFileSync(outPath, marked);

  console.log(
    `  ✓ ${name.padEnd(8)} candidates=${String(candidates.length).padStart(2)} flags=${String(totalFlags).padStart(2)} ` +
    `applied=${applied} unanchored=${Array.isArray(unanchored) ? unanchored.length : 0} → ${outPath}`
  );

  if (args.get('verbose')) {
    for (const c of classified) {
      const tag = `${c.in_footnote ? 'FN' : 'BD'}${c.footnote_num ? c.footnote_num : ''}`;
      const flagMark = c.flags.length > 0 ? '*' : ' ';
      console.log(`     ${flagMark}[${tag.padEnd(4)}|${c.provisional_type.padEnd(18)}] "${c.candidate_text.replace(/\n/g, ' ').slice(0, 90)}"`);
      for (const f of c.flags) {
        console.log(`         [${f.severity.padEnd(15)}] ${f.rule_cite} — ${f.message.slice(0, 100)}`);
      }
    }
  }
}

// Run the Python grader
console.log(`\n[grade-corpus-local] Invoking auto-grader…\n`);
const prevDir = args.get('prev-dir');
const PYTHON = process.platform === 'win32' ? 'py' : 'python3';
const grader = spawnSync(PYTHON, [
  'run_corpus.py',
  '--inputs', INPUTS_DIR,
  '--keys', join(GRADER_DIR, 'answer_keys'),
  '--out', join(GRADER_DIR, 'grader_output'),
  ...(prevDir ? ['--prev_dir', prevDir] : []),
], {
  cwd: GRADER_DIR,
  stdio: 'inherit',
  // Force UTF-8 on Windows so grader Markdown writes don't crash on en-dashes/arrows.
  env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
});

if (grader.error) {
  console.error('Grader spawn error:', grader.error);
  process.exit(2);
}
process.exit(grader.status ?? 1);

// ===========================================================================
// helpers
// ===========================================================================

function synthesizeClassification(text, provisionalType) {
  const caseMatch = text.match(CASE_REGEX);
  if (provisionalType === 'case' && caseMatch) {
    const [, caseName, vol, rawRep, pg, paren, year] = caseMatch;
    return {
      citation_type: 'case',
      components: {
        case_name: caseName.replace(/^\s*(?:See\s+|See also\s+|Cf\.\s+|Even\s+|See, e\.g\.,\s+|But see\s+|See generally\s+|Cf\.,\s+)?/i, '').trim(),
        volume: parseInt(vol, 10),
        reporter: (rawRep || '').trim(),
        first_page: parseInt(pg, 10),
        year: year ? parseInt(year, 10) : null,
        court_parenthetical: paren ? `${paren}${year || ''}`.trim() : null,
      },
      governing_rule: 'BB R. 10',
      governing_table: 'T1; T6; T7',
    };
  }
  if (provisionalType === 'short_form_case') {
    // Pull a putative case name out of the lead-in: "<X>, <V> <R> at <P>"
    const sf = text.match(/^([A-Z][A-Za-z'\.\-\s&]*?)(?:,\s*(\d{1,4})\s+([A-Za-z\.\d\s]+?)\s+at)/);
    return {
      citation_type: 'short_form_case',
      components: sf ? { case_name: sf[1].trim() } : {},
      governing_rule: 'BB R. 10.9',
      governing_table: 'T6',
    };
  }
  if (provisionalType === 'short_form_supra') {
    return {
      citation_type: 'short_form_supra',
      components: {},
      governing_rule: 'BB R. 4.2',
      governing_table: null,
    };
  }
  if (provisionalType === 'short_form_id') {
    return { citation_type: 'short_form_id', components: {}, governing_rule: 'BB R. 4.1', governing_table: null };
  }
  if (provisionalType === 'statute') {
    return { citation_type: 'statute', components: {}, governing_rule: 'BB R. 12', governing_table: 'T1.1' };
  }
  if (provisionalType === 'regulation') {
    return { citation_type: 'regulation', components: {}, governing_rule: 'BB R. 14', governing_table: null };
  }
  if (provisionalType === 'court_document') {
    return { citation_type: 'court_document', components: {}, governing_rule: 'BB R. 11', governing_table: null };
  }
  if (provisionalType === 'book') {
    return { citation_type: 'book', components: {}, governing_rule: 'BB R. 15', governing_table: null };
  }
  return { citation_type: 'unknown', components: {}, governing_rule: null, governing_table: null };
}
