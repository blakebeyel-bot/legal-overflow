/**
 * Citation Verifier — form-report smoke test.
 *
 * We don't validate every line of the generated report — we just ensure
 * the function runs end-to-end with realistic input and emits a buffer
 * that JSZip recognizes as a valid OOXML zip.
 *
 *   node --test netlify/lib/citation-verifier/__tests__/form-report.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';

import { buildFormReport } from '../form-report.js';

const fixtureRun = {
  id: '00000000-0000-0000-0000-000000000001',
  user_id: 'u1',
  file_name: 'sample-brief.docx',
  file_format: 'docx',
  bluebook_edition: '22e',
  ruleset: 'federal',
  style: 'bluepages',
};

const fixtureCitations = [
  {
    candidate_text: 'Brown v. Board of Education, 347 U.S. 483 (1954)',
    char_start: 0, char_end: 48, page_number: 1, in_footnote: false, footnote_num: null,
    citation_type: 'case',
    components: { case_name: 'Brown v. Board of Education', volume: 347, reporter: 'U.S.', first_page: 483, year: 1954, pin_cite: '495' },
    governing_rule: 'BB R. 10', governing_table: 'T1.1; T6; T7',
    flags: [], // ✓ conforming
    existence: { status: 'existence_verified', url: 'https://example/' },
  },
  {
    candidate_text: 'Smith v. Acme Corporation, 100 F.3d 200 (2nd Cir. 2022)',
    char_start: 100, char_end: 155, page_number: 1, in_footnote: false, footnote_num: null,
    citation_type: 'case',
    components: { case_name: 'Smith v. Acme Corporation', volume: 100, reporter: 'F.3d', first_page: 200, year: 2022, court_parenthetical: '2nd Cir. 2022' },
    governing_rule: 'BB R. 10', governing_table: 'T1.1; T6; T7',
    flags: [
      { severity: 'non_conforming', category: 'abbreviations', rule_cite: 'BB R. 10.2.2', table_cite: 'T6',
        message: 'Case-name word "Corporation" must be abbreviated as "Corp." per T6.', suggested_fix: 'Smith v. Acme Corp.' },
      { severity: 'non_conforming', category: 'reporter',      rule_cite: 'BB R. 10.3', table_cite: 'T1',
        message: 'Reporter "F.3d" ended in 2021; the cited year 2022 is outside its range.', suggested_fix: null },
    ],
    existence: { status: 'existence_not_found', search_url: 'https://courtlistener.com/search/?q=...' },
  },
  {
    candidate_text: 'Doe v. Roe, 100 F. Supp. 3d 200 (S.D.N.Y. 2015)',
    char_start: 200, char_end: 247, page_number: 2, in_footnote: false, footnote_num: null,
    citation_type: 'case',
    components: { case_name: 'Doe v. Roe', volume: 100, reporter: 'F. Supp. 3d', first_page: 200, year: 2015 },
    governing_rule: 'BB R. 10', governing_table: 'T1.1; T7',
    flags: [
      { severity: 'review', category: 'short_form', rule_cite: 'BB R. 4.1', table_cite: null,
        message: 'Subsequent reference uses Id. across a footnote break — re-verify R. 4.1 applies.', suggested_fix: null },
    ],
    existence: { status: 'existence_uncertain', note: 'CourtListener returned results but none matched.', search_url: 'https://courtlistener.com/search/?q=...' },
  },
];

const docFlags = [
  { severity: 'review', category: 'signal', rule_cite: 'BB R. 1.3', table_cite: null,
    message: 'String cite at p.5 mixes "See" and "See also" out of order — see R. 1.3.', suggested_fix: null },
];

// ---------------------------------------------------------------------------

test('buildFormReport returns a valid .docx buffer', async () => {
  const buf = await buildFormReport({
    run: fixtureRun,
    citations: fixtureCitations,
    documentFlags: docFlags,
  });
  assert.ok(Buffer.isBuffer(buf), 'should return a Buffer');
  assert.ok(buf.length > 1000, `buffer suspiciously small (${buf.length} bytes)`);

  // Every .docx is a zip with [Content_Types].xml + word/document.xml.
  const zip = await JSZip.loadAsync(buf);
  assert.ok(zip.file('[Content_Types].xml'), 'missing [Content_Types].xml');
  assert.ok(zip.file('word/document.xml'),    'missing word/document.xml');
});

test('report contains the expected section headings', async () => {
  const buf = await buildFormReport({ run: fixtureRun, citations: fixtureCitations, documentFlags: docFlags });
  const zip = await JSZip.loadAsync(buf);
  const documentXml = await zip.file('word/document.xml').async('string');

  // Each h2 heading should appear in the rendered document.xml as visible text.
  for (const heading of [
    'CITATION FORM-CHECK REPORT',
    '1. Summary',
    '2. Non-conforming citations',
    '3. Citations needing correction',
    '4. Conforming citations',
    '5. Existence-check findings',
    '6. Aggregate form findings',
    '7. Corrective-action checklist',
    '8. Items requiring senior-counsel attention',
    '9. Drafting sign-off',
    'Appendix A',
    'Appendix B',
  ]) {
    assert.ok(documentXml.includes(heading), `missing section: ${heading}`);
  }
});

test('report sanitizes any banned phrases in flag messages', async () => {
  const tainted = [
    {
      ...fixtureCitations[0],
      flags: [
        { severity: 'non_conforming', category: 'existence', rule_cite: 'BB R. 10', table_cite: null,
          message: 'This case appears fake and incorrect — the citation does not exist anywhere.',
          suggested_fix: null },
      ],
      existence: { status: 'existence_not_found' },
    },
  ];
  const buf = await buildFormReport({ run: fixtureRun, citations: tainted, documentFlags: [] });
  const zip = await JSZip.loadAsync(buf);
  const documentXml = await zip.file('word/document.xml').async('string');

  // Banned phrases must not survive sanitization.
  assert.doesNotMatch(documentXml, /\bfake\b/i);
  assert.doesNotMatch(documentXml, /\bincorrect\b/i);
  assert.doesNotMatch(documentXml, /does not exist/i);

  // Permitted phrasing should appear instead.
  assert.match(documentXml, /could not be located in CourtListener/);
});
