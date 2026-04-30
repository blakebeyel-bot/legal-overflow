/**
 * Round 19 — Brief 7 state-aware validators.
 *
 *   citation-state-tracker — previous_citation, is_string_cite, case_state, hereinafter_registry
 *   R. 4.1   — validateIdAfterStringCite (state-aware via prev.is_string_cite)
 *   R. 4.1   — validateIdAntecedent (paragraph multi-case detection)
 *   R. 10.9  — validateShortFormGap (intervening-citation count, fires once per case)
 *   R. 4.2(b)— scanHereinafterUndeclared (document-level)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateIdAfterStringCite,
  validateIdAntecedent,
  validateShortFormGap,
  scanHereinafterUndeclared,
} from '../validators.js';
import { attachCitationState } from '../citation-state-tracker.js';

// --- attachCitationState basics -------------------------------------------

test('state tracker — sets previous_citation for second citation', () => {
  const cands = [
    { char_start: 10, candidate_text: 'Twombly v. X, 550 U.S. 544 (2007)', citation_type: 'case' },
    { char_start: 100, candidate_text: 'Id. at 555', citation_type: 'short_form_id' },
  ];
  attachCitationState(cands, 'a'.repeat(200));
  assert.equal(cands[1]._state_previous?.case_short_name, 'Twombly');
});

test('state tracker — detects string-cite member by preceding "; "', () => {
  const text = 'See A v. B, 1 F. 1 (2000); C v. D, 2 F. 2 (2001).';
  const cands = [
    { char_start: text.indexOf('A v.'), candidate_text: 'A v. B, 1 F. 1 (2000)', citation_type: 'case' },
    { char_start: text.indexOf('C v.'), candidate_text: 'C v. D, 2 F. 2 (2001)', citation_type: 'case' },
  ];
  attachCitationState(cands, text);
  // The second citation is preceded by "; " — should be marked as string-cite member.
  assert.equal(cands[1]._state_is_string_cite, true);
  // The first citation should also be retroactively marked.
  assert.equal(cands[0]._state_is_string_cite, true);
});

// --- R. 4.1 Id-after-string-cite (state-aware) ---------------------------

test('R. 4.1 — fires when prev.is_string_cite is true', () => {
  const flags = validateIdAfterStringCite({
    citation_type: 'short_form_id',
    candidate_text: 'Id. at 1289',
    pre_context: '...; Speaker v. U.S. Dep\'t, 623 F.3d 1371, 1381 (11th Cir. 2010). ',
    _state_previous: {
      case_short_name: 'Speaker',
      is_string_cite: true,
    },
  });
  const hit = flags.find((f) => f.rule_cite === 'BB R. 4.1');
  assert.ok(hit);
  assert.match(hit.message, /string cite/i);
});

test('R. 4.1 — does NOT fire when prev is single-source', () => {
  const flags = validateIdAfterStringCite({
    citation_type: 'short_form_id',
    candidate_text: 'Id.',
    pre_context: 'See Hensley Mfg. v. ProPride, 579 F.3d 603, 609 (6th Cir. 2009). ',
    _state_previous: {
      case_short_name: 'Hensley',
      is_string_cite: false,
    },
  });
  // Falls through to old pre_context check; no semicolons → no flag.
  assert.equal(flags.length, 0);
});

// --- R. 4.1 Id-antecedent (paragraph multi-case detection) ---------------

test('R. 4.1 — flags Id. when paragraph mentions other case', () => {
  const flags = validateIdAntecedent({
    citation_type: 'short_form_id',
    candidate_text: 'Id. at 685',
    pre_context: 'The leading case remains Iqbal, 556 U.S. at 678. The Seventh Circuit has applied this standard rigorously. See Tamayo v. Blagojevich, 526 F.3d 1074, 1081 (7th Cir. 2008). ',
    _state_previous: {
      case_short_name: 'Tamayo',
    },
  });
  const hit = flags.find((f) => f.rule_cite === 'BB R. 4.1');
  assert.ok(hit);
  assert.match(hit.message, /Iqbal/);
});

test('R. 4.1 — does NOT fire when only prev case mentioned', () => {
  const flags = validateIdAntecedent({
    citation_type: 'short_form_id',
    candidate_text: 'Id. at 257',
    pre_context: 'Anderson v. Liberty Lobby, 477 U.S. 242, 248 (1986). ',
    _state_previous: {
      case_short_name: 'Anderson',
    },
  });
  assert.equal(flags.length, 0);
});

// --- R. 10.9 short-form gap -----------------------------------------------

test('R. 10.9 — fires advisory when intervening_count >= 6', () => {
  const flags = validateShortFormGap({
    citation_type: 'short_form_case',
    _state_case_short_name: 'Tamayo',
    _state_case_state: {
      last_full_cite_index: 5,
      intervening_count: 19,
      gap_warning_fired: false,
    },
  });
  const hit = flags.find((f) => f.rule_cite === 'BB R. 10.9');
  assert.ok(hit);
  assert.match(hit.message, /intervening/);
});

test('R. 10.9 — does NOT fire when gap_warning_fired already true', () => {
  const flags = validateShortFormGap({
    citation_type: 'short_form_case',
    _state_case_short_name: 'Anderson',
    _state_case_state: {
      last_full_cite_index: 5,
      intervening_count: 36,
      gap_warning_fired: true,
    },
  });
  assert.equal(flags.length, 0);
});

test('R. 10.9 — does NOT fire when intervening_count < 6', () => {
  const flags = validateShortFormGap({
    citation_type: 'short_form_case',
    _state_case_short_name: 'Anderson',
    _state_case_state: {
      last_full_cite_index: 5,
      intervening_count: 3,
      gap_warning_fired: false,
    },
  });
  assert.equal(flags.length, 0);
});

// --- R. 4.2(b) hereinafter undeclared -----------------------------------

test('R. 4.2(b) — flags "The Investors Act" when undeclared', () => {
  const text = 'The Investment Advisers Act of 1940 addresses concerns. The Investors Act provides additional restrictions.';
  const flags = scanHereinafterUndeclared(text);
  const hit = flags.find((c) => /Investors Act/.test(c.candidate_text));
  assert.ok(hit);
  assert.match(hit.flags[0].message, /hereinafter/);
});

test('R. 4.2(b) — does NOT flag full-form "The Investment Advisers Act of 1940"', () => {
  const text = 'See The Investment Advisers Act of 1940. Both statutes are subject to ordinary canons.';
  const flags = scanHereinafterUndeclared(text);
  assert.equal(flags.length, 0);
});

test('R. 4.2(b) — does NOT flag declared form "The Exchange Act"', () => {
  const text = 'See 15 U.S.C. § 78j [hereinafter Exchange Act]. The Exchange Act establishes the framework.';
  const flags = scanHereinafterUndeclared(text);
  // "The Exchange Act" is followed by "establishes" not "of YYYY". The
  // regex matches it. Then registry has "Exchange Act" → registered → skip.
  const hit = flags.find((c) => /Exchange Act/.test(c.candidate_text));
  assert.equal(hit, undefined);
});
