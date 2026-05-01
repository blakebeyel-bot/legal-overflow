/**
 * Round 25 — Pass-4 Pass-3-territory dedup.
 *
 * Bug: the edge-case stress test brief produced a duplicate Chevron
 * comment with a TRUNCATED suggested_fix ("Council, Inc., 467 U.S. 837,
 * 842–43 (1984)"). Pass 3 (validators.js) emits the correct full
 * Chevron emission, then Pass 4 (LLM judge) emits a second R. 3.2(a)
 * flag using components.case_name (which Pass 2 sometimes extracts
 * shorter than the full case name).
 *
 * Fix: filterPass4Territory drops Pass 4 emissions whose rule_cite is in
 * Pass 3's territory (R. 3.2(a), R. 6.1, R. 10.2.2/T6, R. 10.4, etc.)
 * OR already exists on the target citation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { filterPass4Territory, PASS3_TERRITORY } from '../judge-edge-cases.js';

test('Round 25 — drops Pass 4 R. 3.2(a) emissions (Chevron duplicate scenario)', () => {
  const citations = [
    {
      candidate_text: 'Chevron U.S.A., Inc. v. Nat. Res. Def. Council, Inc., 467 U.S. 837, 842-43 (1984)',
      flags: [
        // Pass 3 already caught this, with the correct full case-name fix.
        {
          rule_cite: 'BB R. 3.2(a)',
          message: 'Pin-cite range "842-43" uses hyphen; R. 3.2(a) requires an en dash (–): "842–43".',
          suggested_fix: 'Chevron U.S.A., Inc. v. Nat. Res. Def. Council, Inc., 467 U.S. 837, 842–43 (1984)',
        },
      ],
    },
  ];

  // Pass 4's (incorrect) emission: same rule, truncated case name.
  const pass4 = [
    {
      citation_index: 0,
      rule_cite: 'BB R. 3.2(a)',
      message: 'Pin-cite range "842-43" uses hyphen; R. 3.2(a) requires an en dash (–): "842–43".',
      suggested_fix: 'Council, Inc., 467 U.S. 837, 842–43 (1984)',
    },
  ];

  const { kept, dropped } = filterPass4Territory(pass4, citations);
  assert.equal(kept.length, 0, 'Pass 4 R. 3.2(a) emission must be dropped');
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].reason, 'pass3_territory_blocklist');
});

test('Round 25 — drops Pass 4 R. 10.2.2 emissions (T6 territory)', () => {
  const citations = [
    {
      candidate_text: 'Department of Homeland Security v. Regents...',
      flags: [{ rule_cite: 'BB R. 10.2.2', message: 'Department -> Dep\'t', suggested_fix: 'Dep\'t of...' }],
    },
  ];
  const pass4 = [{
    citation_index: 0,
    rule_cite: 'BB R. 10.2.2',
    message: 'Some LLM-mimicked T6 finding',
    suggested_fix: 'truncated...',
  }];
  const { kept, dropped } = filterPass4Territory(pass4, citations);
  assert.equal(kept.length, 0);
  assert.equal(dropped[0].reason, 'pass3_territory_blocklist');
});

test('Round 25 — keeps legitimate Pass 4 short-form / signal flags', () => {
  const citations = [
    {
      candidate_text: 'Tamayo, 526 F.3d at 1081',
      flags: [],
    },
  ];
  const pass4 = [
    // R. 4.1 — Id. chain integrity (Pass 4's job, not Pass 3's)
    {
      citation_index: 0,
      rule_cite: 'BB R. 4.1',
      message: 'Id. used after intervening citation',
      suggested_fix: 'Use full citation',
    },
    // R. 10.9 — short-form propriety (Pass 4's job)
    {
      citation_index: 0,
      rule_cite: 'BB R. 10.9',
      message: 'Short form used after 8 intervening citations',
      suggested_fix: null,
    },
  ];
  const { kept, dropped } = filterPass4Territory(pass4, citations);
  assert.equal(kept.length, 2, 'Pass 4 R. 4.1 and R. 10.9 must survive');
  assert.equal(dropped.length, 0);
});

test('Round 25 — per-citation dedup drops Pass 4 emission already on target', () => {
  // Pass 4 fires a rule that ISN'T in PASS3_TERRITORY but the target
  // citation already has that rule_cite from elsewhere (e.g., another
  // Pass 4 path or a duplicate Pass 4 emission). Drop the second one.
  const citations = [
    {
      candidate_text: 'Some citation',
      flags: [{ rule_cite: 'BB R. 4.1', message: 'first emission', suggested_fix: null }],
    },
  ];
  const pass4 = [{
    citation_index: 0,
    rule_cite: 'BB R. 4.1',
    message: 'duplicate emission',
    suggested_fix: null,
  }];
  const { kept, dropped } = filterPass4Territory(pass4, citations);
  assert.equal(kept.length, 0);
  assert.equal(dropped[0].reason, 'duplicates_pass3_emission');
});

test('Round 25 — drops Pass 4 emission targeting an out-of-range citation_index', () => {
  const citations = [{ candidate_text: 'A', flags: [] }];
  const pass4 = [{ citation_index: 99, rule_cite: 'BB R. 4.1', message: 'orphan', suggested_fix: null }];
  const { kept, dropped } = filterPass4Territory(pass4, citations);
  assert.equal(kept.length, 0);
  assert.equal(dropped[0].reason, 'no_target_citation');
});

test('Round 25 — PASS3_TERRITORY contains expected rule cites', () => {
  // Sanity check: ensure the blocklist covers the major Pass 3 rule cites.
  for (const rule of ['BB R. 3.2(a)', 'BB R. 6.1', 'BB R. 10.2.2', 'BB R. 10.4']) {
    assert.ok(PASS3_TERRITORY.has(rule), `${rule} must be in PASS3_TERRITORY`);
  }
});
