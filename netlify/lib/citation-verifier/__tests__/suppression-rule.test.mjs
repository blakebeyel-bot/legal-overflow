/**
 * FIX #1 — Suppression rule:
 *
 *   When Pipeline A produces ANY comment on a given citation,
 *   Pipeline B emits no UNRESOLVED comment on that same citation.
 *   Hard rule, no exceptions.
 *
 * These tests pin the contract.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { existenceResultToFlag } from '../court-listener.js';

test('UNRESOLVED suppressed when hasFormatError=true', () => {
  const result = { status: 'existence_not_found' };
  const flag = existenceResultToFlag(result, { hasFormatError: true });
  assert.equal(flag, null, 'UNRESOLVED must be silent when Pipeline A flagged anything');
});

test('UNRESOLVED emitted when hasFormatError=false', () => {
  const result = { status: 'existence_not_found' };
  const flag = existenceResultToFlag(result, { hasFormatError: false });
  assert.ok(flag, 'UNRESOLVED must surface when no Pipeline A flag exists');
  assert.match(flag.message, /Not found in CourtListener/);
});

test('NAME_MISMATCH NOT suppressed even when hasFormatError=true', () => {
  // The cite-locates-to-different-case finding stands on its own —
  // it is independent of any format error and must always surface.
  const result = {
    status: 'existence_name_mismatch',
    cited_text: '562 U.S. 521',
    actual_case_name: 'Some Other Case',
    actual_year: '2011',
  };
  const flag = existenceResultToFlag(result, { hasFormatError: true });
  assert.ok(flag, 'NAME_MISMATCH must surface regardless of Pipeline A');
  assert.match(flag.message, /case name does not match/i);
});

test('LOCATION_MISMATCH NOT suppressed even when hasFormatError=true', () => {
  const result = {
    status: 'existence_location_mismatch',
    actual_citation: '500 U.S. 100',
    cited_text: '562 U.S. 521',
  };
  const flag = existenceResultToFlag(result, { hasFormatError: true });
  assert.ok(flag, 'LOCATION_MISMATCH must surface regardless of Pipeline A');
  assert.match(flag.message, /not the cited/);
});

test('VERIFIED is silent regardless of hasFormatError', () => {
  const result = { status: 'existence_verified' };
  assert.equal(existenceResultToFlag(result, { hasFormatError: true }),  null);
  assert.equal(existenceResultToFlag(result, { hasFormatError: false }), null);
});

test('not_applicable (silent quota / api / non-US reporter) returns null', () => {
  const result = { status: 'not_applicable', _silent_reason: 'quota_exhausted' };
  assert.equal(existenceResultToFlag(result, { hasFormatError: false }), null);
  assert.equal(existenceResultToFlag(result, { hasFormatError: true }),  null);
});

test('FIX #2 — quota_exhausted skip never produces a comment', () => {
  const result = { status: 'not_applicable', _silent_reason: 'quota_exhausted' };
  const flag = existenceResultToFlag(result, { hasFormatError: false });
  assert.equal(flag, null, 'quota_exhausted must NEVER produce a per-citation comment');
});

test('FIX #2 — api_error skip never produces a comment', () => {
  const result = { status: 'not_applicable', _silent_reason: 'api_error' };
  const flag = existenceResultToFlag(result, { hasFormatError: false });
  assert.equal(flag, null, 'api_error must NEVER produce a per-citation comment');
});
