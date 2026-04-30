/**
 * Round 21 — T10 jurisdiction-period FP fix.
 *
 * Riverside real-world brief surfaced a false positive on
 *   Hodges v. S.C. Toof & Co., 833 S.W.2d 896 (Tenn. 1992)
 * The validator fired on "Tenn" claiming it needed a period, despite the
 * period already being present, and produced suggested fix "(Tenn.. 1992)"
 * with two consecutive periods.
 *
 * Root cause: the T10 regex's negative lookahead was `(?![A-Za-z])` — it
 * allowed period through, so "Tenn." matched the same as "Tenn ".
 *
 * Fix: lookahead now excludes period as well: `(?![A-Za-z.])`.
 *
 * Also: the self-check now rejects any fix that contains a double-period
 * pattern (`\.\.`) — that's a Bluebook violation in its own right.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateGeographicalAbbreviations } from '../validators.js';
import { validateSuggestedFix } from '../fix-self-check.js';

test('R. 10.2.2 / T10 — does NOT fire on "(Tenn. 1992)" (already has period)', () => {
  const text = 'Hodges v. S.C. Toof & Co., 833 S.W.2d 896 (Tenn. 1992)';
  const flags = validateGeographicalAbbreviations(text);
  const hit = flags.find((f) => /Tenn/.test(f.message));
  assert.equal(hit, undefined, `should not flag "Tenn." in (Tenn. 1992); got: ${hit?.message}`);
});

test('R. 10.2.2 / T10 — DOES fire on "(Tenn 1992)" (missing period)', () => {
  const text = 'Hodges v. S.C. Toof & Co., 833 S.W.2d 896 (Tenn 1992)';
  const flags = validateGeographicalAbbreviations(text);
  const hit = flags.find((f) => /Tenn/.test(f.message));
  assert.ok(hit, 'should flag bare "Tenn" without period');
  assert.match(hit.suggested_fix, /\(Tenn\. 1992\)/);
  // The fix must NOT contain a double period.
  assert.doesNotMatch(hit.suggested_fix, /\.\./);
});

test('R. 10.2.2 / T10 — does NOT fire on "(Mont. 2010)" (already has period)', () => {
  const text = 'See Smith v. Jones, 100 P.3d 200 (Mont. 2010)';
  const flags = validateGeographicalAbbreviations(text);
  const hit = flags.find((f) => /Mont/.test(f.message));
  assert.equal(hit, undefined);
});

test('R. 10.2.2 / T10 — still fires on "Calif." (canonical bad form)', () => {
  const text = 'See Smith v. Jones, 100 P.3d 200 (Calif. 2010)';
  const flags = validateGeographicalAbbreviations(text);
  const hit = flags.find((f) => /Calif/.test(f.message));
  assert.ok(hit, 'should still flag "Calif." → "Cal."');
});

// Self-check coverage —————————————————————————————————————————————————————

test('self-check — rejects suggested fix with double period "Tenn.."', () => {
  const citation = {
    citation_type: 'case',
    candidate_text: 'Hodges v. S.C. Toof & Co., 833 S.W.2d 896 (Tenn. 1992)',
  };
  // Simulated buggy fix that would have escaped pre-Round-21.
  const buggy = 'Hodges v. S.C. Toof & Co., 833 S.W.2d 896 (Tenn.. 1992)';
  const cleaned = validateSuggestedFix(citation, buggy);
  assert.equal(cleaned, null, 'self-check must reject double-period fixes');
});

test('self-check — does NOT reject legitimate ellipsis " . . . "', () => {
  // The double-period rejection must NOT trigger on three-period ellipses.
  const citation = {
    citation_type: 'case',
    candidate_text: 'Smith v. Jones, 100 F.3d 200 (2d Cir. 2010)',
  };
  // A fix that contains an ellipsis (...) is fine — the regex's negative
  // lookbehind/lookahead excludes legitimate three-period sequences.
  const fix = 'Smith v. Jones, 100 F.3d 200, 205 ... (2d Cir. 2010)';
  const cleaned = validateSuggestedFix(citation, fix);
  assert.equal(cleaned, fix, 'three-period ellipsis must pass');
});
