/**
 * Citation Verifier — Pass 2 helper tests.
 *
 * Live API calls are tested by the Stage 12 corpus runner, which reads a
 * real .docx end-to-end. Here we verify the deterministic helpers:
 *   - sanitizeOutput strips banned phrases
 *   - skillSystemBlock returns a cache-tagged block
 *   - extractJson tolerates fenced and partial responses
 *
 * Run from site/ with:
 *   node --test netlify/lib/citation-verifier/__tests__/classify.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { skillText, skillSystemBlock, sanitizeOutput } from '../skill-prompt.js';
import { extractJson } from '../../anthropic.js';

// ---------------------------------------------------------------------------
// skill-prompt.js
// ---------------------------------------------------------------------------

test('skillText loads SKILL.md and returns non-empty content', () => {
  const t = skillText();
  assert.ok(typeof t === 'string');
  assert.ok(t.length > 5000, `skill text suspiciously short (${t.length} chars)`);
  assert.match(t, /Bluebook 22e/);
  assert.match(t, /BB R\. 10/);
});

test('skillSystemBlock returns two cache-tagged text blocks (Anthon ref + protocol)', () => {
  const blocks = skillSystemBlock();
  assert.equal(blocks.length, 2);
  // Both blocks are cache-tagged so the prompt cache stores them once
  // and reads them back at 90% discount on subsequent calls.
  for (const b of blocks) {
    assert.equal(b.type, 'text');
    assert.deepEqual(b.cache_control, { type: 'ephemeral' });
  }
  // First block: Anthon "Bluebook Uncovered" reference text.
  assert.match(blocks[0].text, /BLUEBOOK UNCOVERED/);
  // Second block: the citation verification protocol itself.
  assert.match(blocks[1].text, /CITATION VERIFICATION PROTOCOL/);
});

// ---------------------------------------------------------------------------
// sanitizeOutput — banned-phrase guard
// ---------------------------------------------------------------------------

test('sanitizeOutput replaces "fake" with the permitted phrase', () => {
  const out = sanitizeOutput('This citation appears fake.');
  assert.match(out, /could not be located in CourtListener/);
  assert.doesNotMatch(out, /\bfake\b/);
});

test('sanitizeOutput replaces "hallucinated" with the permitted phrase', () => {
  const out = sanitizeOutput('The case is hallucinated by the model.');
  assert.match(out, /could not be located in CourtListener/);
  assert.doesNotMatch(out, /hallucinat/i);
});

test('sanitizeOutput replaces "this case does not exist"', () => {
  const out = sanitizeOutput('This case does not exist in any reporter.');
  assert.match(out, /could not be located in CourtListener/);
});

test('sanitizeOutput softens "incorrect" / "wrong" to "non-conforming"', () => {
  assert.match(sanitizeOutput('The reporter is incorrect.'), /non-conforming/);
  assert.match(sanitizeOutput('That cite is wrong.'),        /non-conforming/);
});

test('sanitizeOutput is idempotent — running twice gives same result', () => {
  const a = sanitizeOutput('This citation appears fake and incorrect.');
  const b = sanitizeOutput(a);
  assert.equal(a, b);
});

test('sanitizeOutput preserves non-banned text', () => {
  const ok = 'BB R. 10.2.2; T6 — case name "Corporation" must be abbreviated "Corp."';
  assert.equal(sanitizeOutput(ok), ok);
});

// ---------------------------------------------------------------------------
// extractJson — borrowed from lib/anthropic.js
// ---------------------------------------------------------------------------

test('extractJson handles markdown-fenced JSON', () => {
  const text = 'Here is the result:\n```json\n[{"a":1}]\n```\nDone.';
  assert.deepEqual(extractJson(text), [{ a: 1 }]);
});

test('extractJson handles bare JSON arrays', () => {
  const text = '[{"a":1},{"a":2}]';
  assert.deepEqual(extractJson(text), [{ a: 1 }, { a: 2 }]);
});

test('extractJson handles JSON with prose before', () => {
  const text = 'I have classified the candidates as follows: [{"a":1}]';
  assert.deepEqual(extractJson(text), [{ a: 1 }]);
});

test('extractJson repairs truncated JSON arrays', () => {
  // Truncated mid-element — should rewind to last complete element.
  const text = '[{"a":1},{"a":2},{"a":';
  const result = extractJson(text);
  assert.deepEqual(result, [{ a: 1 }, { a: 2 }]);
});
