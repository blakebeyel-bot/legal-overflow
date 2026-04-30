/**
 * Round 22 — Santiago real-world brief surfaced two implementation bugs.
 *
 * Bug A: Case-name truncation in suggested fix when `&` appears before " v."
 *   Burlington N. & Santa Fe Ry. Co. v. White — pin-range catch fired
 *   correctly, but suggested fix was "Co. v. White, 548 U.S. 53, 67–68
 *   (2006)" — missing "Burlington N. & Santa Fe Ry." Root cause: the
 *   case-name reach-back's sentence-boundary detector treated `Ry.` as a
 *   terminator (because `Ry` wasn't in the ABBREV set), splitting the
 *   case name mid-token. Fix: extend ABBREV with the full T6
 *   abbreviation set (Ry, Mut, Sav, Equip, Auto, Indep, Mach, etc.).
 *
 * Bug B: Anchor placement extends past citation end.
 *   Westmoreland v. TWC Admin. LLC, 924 F.3d 718, 725-26 (4th Cir. 2019)
 *   — the comment range wrapped the entire run including ". At a
 *   minimum, those statements..." prose AFTER the citation. Root cause:
 *   markup-docx's annotate path was returning the entire run XML
 *   wrapped in commentRangeStart/End. Fix: split the run into
 *   [before][needle][after] sub-runs and wrap only the middle.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findCitationCandidates } from '../citation-patterns.js';
import { applyCitationMarkupDocx } from '../markup-docx-citations.js';
import JSZip from 'jszip';

// --- Bug A: case-name preservation across `&` connector ------------------

test('Bug A — Burlington N. & Santa Fe Ry. Co. v. White preserves full plaintiff name', () => {
  const text = 'See Burlington N. & Santa Fe Ry. Co. v. White, 548 U.S. 53, 67-68 (2006).';
  const cands = findCitationCandidates(text);
  const hit = cands.find((c) => c.provisional_type === 'case');
  assert.ok(hit, 'should extract the Burlington case');
  assert.match(hit.candidate_text, /Burlington N\. & Santa Fe Ry\. Co\. v\. White/);
});

test('Bug A — "Ry." inside case name is not treated as sentence boundary', () => {
  // The previous bug: `Ry.` (Railway) was missing from the ABBREV set,
  // so the period after Ry was treated as a sentence boundary. Walk-back
  // landed at "Co. v. White" instead of "Burlington N. & Santa Fe Ry. Co.
  // v. White".
  const text = 'Other authorities. See Burlington N. & Santa Fe Ry. Co. v. White, 548 U.S. 53, 67-68 (2006).';
  const cands = findCitationCandidates(text);
  const hit = cands.find((c) => c.provisional_type === 'case');
  assert.match(hit.candidate_text, /Burlington/, 'walk-back should reach Burlington');
});

test('Bug A — defendant-side `&` (EEOC v. Sears Roebuck & Co.) still works', () => {
  // The user noted that comment #4 on EEOC v. Sears Roebuck & Co. on the
  // Santiago brief correctly preserved the `&` in the defendant portion;
  // the bug was specifically the pre-"v." walk-back. Confirm the post-"v."
  // side hasn't regressed.
  const text = 'See EEOC v. Sears Roebuck & Co., 233 F.3d 432, 440 (7th Cir. 2000).';
  const cands = findCitationCandidates(text);
  const hit = cands.find((c) => c.provisional_type === 'case');
  assert.match(hit.candidate_text, /EEOC v\. Sears Roebuck & Co\./);
});

// --- Bug B: comment range stays at citation end --------------------------

test('Bug B — comment range does not extend past citation end', async () => {
  // Synthesize a minimal .docx with a single paragraph containing the
  // Westmoreland citation followed by trailing prose. Run the markup
  // pipeline and confirm the commentRangeEnd lands at the citation's
  // closing parenthesis, not at the next sentence boundary.
  const paragraphText = 'Westmoreland v. TWC Admin. LLC, 924 F.3d 718, 725-26 (4th Cir. 2019). At a minimum, those statements create a genuine dispute of material fact regarding causation.';
  const docxBuffer = await buildSimpleDocx(paragraphText);

  const findings = [
    {
      markup_type: 'annotate',
      source_text: 'Westmoreland v. TWC Admin. LLC, 924 F.3d 718, 725-26 (4th Cir. 2019)',
      anchor_text: 'Westmoreland v. TWC Admin. LLC, 924 F.3d 718, 725-26 (4th Cir. 2019)',
      external_comment: 'Pin-cite range "725-26" must use an en dash (–), not a hyphen.',
    },
  ];

  const { buffer } = await applyCitationMarkupDocx(docxBuffer, [
    {
      candidate_text: findings[0].source_text,
      flags: [{ rule_cite: 'BB R. 3.2(a)', message: findings[0].external_comment, suggested_fix: null }],
    },
  ]);

  // Read the comment range start/end and confirm the wrapped text is
  // exactly the citation, not the citation + trailing prose.
  const zip = await JSZip.loadAsync(buffer);
  const docXml = await zip.file('word/document.xml').async('string');

  // Extract text between commentRangeStart and commentRangeEnd.
  const startMatch = docXml.match(/<w:commentRangeStart\s+w:id="(\d+)"\/>/);
  assert.ok(startMatch, 'commentRangeStart should be present');
  const cid = startMatch[1];

  const startIdx = docXml.indexOf(`<w:commentRangeStart w:id="${cid}"/>`);
  const endIdx = docXml.indexOf(`<w:commentRangeEnd w:id="${cid}"/>`);
  assert.ok(startIdx >= 0 && endIdx > startIdx, 'comment range markers should be paired');

  const between = docXml.slice(startIdx, endIdx);
  // Extract the visible text inside the comment range.
  const visibleText = [...between.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
    .map((m) => m[1])
    .join('');

  // The visible text should END with "(4th Cir. 2019)" — not with prose
  // beyond. A small trailing space tolerance is fine.
  assert.match(visibleText, /\(4th Cir\. 2019\)\s*$/, `comment text should end at citation; got: ${JSON.stringify(visibleText)}`);
  assert.doesNotMatch(visibleText, /At a minimum/, 'must not include trailing prose');
});

// --- helper: synthesize a minimal .docx with one paragraph ---------------

async function buildSimpleDocx(paragraphText) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:r><w:t xml:space="preserve">${paragraphText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</w:t></w:r></w:p>
</w:body>
</w:document>`);
  return await zip.generateAsync({ type: 'nodebuffer' });
}
