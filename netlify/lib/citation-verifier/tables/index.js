/**
 * Citation Verifier — Bluebook table loader.
 *
 * Tables are JSON files in this directory. We import them directly as
 * ESM JSON modules so esbuild bundles them into the function output —
 * no runtime fs.readFileSync, no included_files juggling, no chance of
 * the function dying at cold start with ENOENT because the JSON didn't
 * make it into the deploy package.
 *
 * Why this matters in production:
 *   On Netlify with esbuild bundling, runtime readFileSync targets are
 *   NOT traced by the bundler. Without explicit `included_files` config,
 *   the JSON files would be missing from the function bundle and every
 *   cold start would crash silently before the first DB update — leaving
 *   verification_runs rows stuck in "queued" forever with no error
 *   message. ESM JSON imports make the bundling part of the dependency
 *   graph, which is what we want.
 */

// Tables are imported as JS modules (auto-generated from the .json
// source files; see netlify/lib/citation-verifier/tables/*.js). This
// sidesteps two cross-runtime headaches at once:
//
//   1. Native Node ESM requires `with { type: 'json' }` for direct .json
//      imports. Node 22+ supports it; Node 20 needs an experimental flag.
//   2. Netlify's esbuild bundler doesn't include readFileSync targets in
//      the function output unless explicitly listed in `included_files`.
//
// JS-module imports work everywhere — local node, Node 20, esbuild,
// browser bundlers — without any attribute or config.
//
// To regenerate after editing a table source:
//   node -e "..." (see scripts/build-skill-text.mjs and the inline
//   generation script in chat history; can be wrapped into a script if
//   the tables get edited often).
import T1Data from './T1.js';
import T6Data from './T6.js';
import T7Data from './T7.js';
import T10Data from './T10.js';
import T13Data from './T13.js';
import RCData  from './reporter-currency.js';

export function T1()  { return T1Data; }
export function T6()  { return T6Data; }
export function T7()  { return T7Data; }
export function T10() { return T10Data; }
export function T13() { return T13Data; }
export function reporterCurrency() { return RCData; }

// Kept for API compatibility — every table is already in memory after
// import resolution, so this is a no-op.
export function preloadAllTables() {
  return { T1: T1Data, T6: T6Data, T7: T7Data, T10: T10Data, T13: T13Data, reporterCurrency: RCData };
}
