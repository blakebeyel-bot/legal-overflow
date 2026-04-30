/**
 * Citation Verifier — skill-prompt loader.
 *
 * Loads the bundled SKILL.md once at module init and exposes it as the
 * cached system-prompt block for Pass 2 (classifier) and Pass 4 (judge).
 *
 * Per BUILD_SPEC §16: prompt caching is locked ON for skill text — the
 * skill is the single largest constant input across every call, so it
 * must be a separate cache_control block. Cache reads cost 90% less than
 * fresh input tokens.
 *
 * Per BUILD_SPEC §16: NEVER include any of the banned phrases in any
 * prompt or model output: "fake", "fictitious", "hallucinated",
 * "incorrect", "wrong", "this case does not exist". The strongest
 * permitted language is "could not be located in CourtListener — please
 * verify before filing." A pre-commit grep guards this directory.
 */

// Skill content is bundled as a JS module (see skill-text.js) so esbuild
// includes it automatically. The original SKILL.md is the source of truth;
// regenerate skill-text.js whenever the protocol is updated.
import skillTextContent from './skill-text.js';

// "The Bluebook Uncovered" by Dionne E. Anthon (22e) — comprehensive
// practical reference for Bluebook 22e, ingested as a cached system
// block so Sonnet anchors every classification / form judgment in the
// authoritative guide rather than only in training data.
import anthonTextContent from './anthon-text.js';

/**
 * Returns the SKILL.md text as a string. Loaded once per cold start.
 */
export function skillText() {
  return skillTextContent;
}

/**
 * Returns the full Anthon Bluebook Uncovered text. ~131K tokens.
 * Cached via prompt caching after first call.
 */
export function anthonText() {
  return anthonTextContent;
}

/**
 * Returns the system-prompt blocks ready for the Anthropic SDK's `system`
 * parameter. The skill is wrapped with a cache_control hint so subsequent
 * calls inside the 5-minute cache TTL read it at 90% discount.
 *
 * Caller should add their per-pass instructions as a SECOND cached or
 * un-cached block (see classifier / judge for examples).
 */
export function skillSystemBlock() {
  // Two cache breakpoints, both ephemeral (5-minute TTL):
  //
  //   1. Anthon "Bluebook Uncovered" reference text (~131K tokens) —
  //      the authoritative guide Sonnet consults for rule wording and
  //      worked examples. Goes FIRST so it's cached as the largest
  //      stable prefix; if it ever rotates we don't invalidate the
  //      protocol cache below it.
  //
  //   2. Citation Verification Protocol (~5K tokens) — the
  //      decision-making spec for this pipeline. Tells Sonnet HOW to
  //      apply the Anthon reference in service of the verifier's
  //      output schema.
  //
  // First call costs the full ~136K cache write. Every subsequent call
  // within the 5-min window pays only the ~10% cache-read rate. For a
  // 14-citation brief batched as 1 Pass 2 call + 1 Pass 4 call, that's
  // ONE cache write + ONE cache read.
  return [
    {
      type: 'text',
      text:
        '=== REFERENCE: THE BLUEBOOK UNCOVERED (22e) ===\n' +
        'The text below is "The Bluebook Uncovered" by Dionne E. Anthon, ' +
        'a comprehensive practical guide to The Bluebook (22nd Edition). ' +
        'Use this as your authoritative reference for every rule pin-cite ' +
        'you emit, every form judgment you make, and every example you ' +
        'consult. When the protocol below references a rule (e.g., "R. 10.2.2"), ' +
        'find the corresponding section in this reference text and apply ' +
        'what it says. Do NOT reproduce text from this reference in your ' +
        'output — cite the rule number only.\n\n' +
        anthonText(),
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text:
        '=== CITATION VERIFICATION PROTOCOL ===\n\n' +
        'You are operating under the Citation Verification Protocol below. ' +
        'The protocol governs HOW you classify candidates, map them to ' +
        'rules, and assign severity. The Anthon reference above is your ' +
        'authority for the rule content itself; the protocol below is ' +
        'your job description for this pipeline. Cite specific Bluebook ' +
        'rule and table pin-cites in every output (e.g., "BB R. 10.2.2; T6").' +
        '\n\n' +
        skillText(),
      cache_control: { type: 'ephemeral' },
    },
  ];
}

/**
 * Banned-phrase guard. Run on any string we are about to send back to the
 * user (e.g., flag.message, suggested_fix). Returns the string with every
 * banned phrase replaced by the permitted softer phrasing. This is a
 * post-processor — Pass 4 prompts also instruct the model not to emit
 * these, but we belt-and-suspenders here in case the model ignores it.
 *
 * Per BUILD_SPEC §16, banned exactly: "fake", "fictitious", "hallucinated",
 * "incorrect", "wrong", "this case does not exist".
 *
 * Strongest permitted: "could not be located in CourtListener — please
 * verify before filing".
 */
export function sanitizeOutput(s) {
  if (typeof s !== 'string') return s;
  let out = s;

  // Phrase-level replacements first (longest match wins).
  // The banned phrase per BUILD_SPEC §16 is "this case does not exist" —
  // we extend that to any subject ("the citation", "the case", etc.) so a
  // paraphrase can't sneak past the guard.
  const phrases = [
    [/\b(?:this|the)\s+(?:case|citation|opinion|authority)\s+does\s+not\s+exist[^.]*/gi,
      'could not be located in CourtListener — please verify before filing'],
    [/\bdoes\s+not\s+exist\b[^.]*/gi,
      'could not be located in CourtListener — please verify before filing'],
    [/(?:appears? to be |looks )?hallucinat(?:ed|ion)\b/gi, 'could not be located in CourtListener — please verify before filing'],
    [/(?:appears? to be |is )?fictitious\b/gi, 'could not be located in CourtListener — please verify before filing'],
    [/(?:appears? to be |is )?fake\b/gi, 'could not be located in CourtListener — please verify before filing'],
  ];
  for (const [re, replacement] of phrases) {
    out = out.replace(re, replacement);
  }

  // Word-level replacements with looser surrounding language.
  const words = [
    [/\bincorrect\b/gi, 'non-conforming'],
    [/\bwrong\b/gi,     'non-conforming'],
  ];
  for (const [re, replacement] of words) {
    out = out.replace(re, replacement);
  }

  return out;
}
