/**
 * Citation Verifier — Pass 4 LLM judgment.
 *
 * Per BUILD_SPEC §11: cross-citation issues that cannot be resolved one
 * citation at a time. The model sees the FULL citation list (already
 * classified + already existence-checked + already table-validated) and
 * issues flags for things like:
 *
 *   - Signal ordering within string cites (R. 1.3 / R. 1.4)
 *   - Authority weight ordering (R. 1.4)
 *   - Short-form propriety (id. correctness, supra correctness) (R. 4)
 *   - Id. chain integrity across footnote breaks (R. 4.1)
 *   - Parenthetical placement and ordering (R. 1.5 / R. 10.6)
 *   - String cite separator punctuation (R. 1.1)
 *
 * Runs ONCE per document, not per citation. Skill is cached as system.
 *
 * Banned-phrase rule (BUILD_SPEC §16): same as Pass 2 — every output
 * string is sanitized before persistence.
 *
 * Failure mode
 * ------------
 * If Pass 4 fails (parse error, API error, anything), the run still
 * completes — we just emit zero cross-citation flags and log the error.
 * Pass 3 already covered the per-citation form checks; Pass 4 is purely
 * additive.
 */

import Anthropic from '@anthropic-ai/sdk';
import { MODEL_ID } from '../constants.js';
import { recordUsage } from '../supabase-admin.js';
import { skillSystemBlock, sanitizeOutput } from './skill-prompt.js';
import { extractJson } from '../anthropic.js';

const MAX_TOKENS = 8192;
const AGENT_NAME = 'citation-verifier-pass4';

let _client = null;
function client() {
  if (_client) return _client;
  const lo = process.env.LO_ANTHROPIC_API_KEY;
  const fallback = process.env.ANTHROPIC_API_KEY;
  const key =
    (lo && lo.startsWith('sk-ant-')) ? lo :
    (fallback && fallback.startsWith('sk-ant-')) ? fallback :
    null;
  if (!key) {
    throw new Error('No direct Anthropic API key found.');
  }
  _client = new Anthropic({ apiKey: key, baseURL: 'https://api.anthropic.com' });
  return _client;
}

/**
 * Run Pass 4 over the entire run.
 *
 * @param {object} args
 * @param {Array<ClassifiedCitation>} args.citations — Pass 2 output
 * @param {string} args.style — 'bluepages' | 'whitepages'
 * @param {string} args.userId
 * @param {string} [args.runId]
 * @returns {Promise<{ flags: Array<JudgmentFlag>, usage: object|null }>}
 *
 * JudgmentFlag (matches the `flags` table; citation_id_index points at
 * the citation INDEX in the input array — the orchestrator maps it back
 * to a real citation_id):
 *   {
 *     citation_index: <int>,   // 0-based index in the input array
 *     severity:       'review' | 'non_conforming',
 *     category:       'short_form' | 'signal' | 'parenthetical'
 *                   | 'capitalization' | 'history' | 'parallel',
 *     rule_cite:      string,
 *     table_cite:     string|null,
 *     message:        string,
 *     suggested_fix:  string|null
 *   }
 */
export async function judgeEdgeCases({ citations, style = 'bluepages', userId, runId = null }) {
  if (!Array.isArray(citations) || citations.length === 0) {
    return { flags: [], usage: null };
  }

  const userMessage = buildUserMessage(citations, { style });

  let response;
  try {
    response = await client().messages.create({
      model: MODEL_ID,
      max_tokens: MAX_TOKENS,
      system: skillSystemBlock(),
      messages: [{ role: 'user', content: userMessage }],
    });
  } catch (err) {
    console.error('Pass 4 API call failed:', err);
    return { flags: [], usage: null };
  }

  try {
    await recordUsage({
      userId,
      reviewId: null,
      agentName: AGENT_NAME,
      usage: response.usage,
    });
  } catch (e) {
    console.error(`recordUsage failed for ${AGENT_NAME}:`, e);
  }

  const text = response.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

  let parsed;
  try {
    parsed = extractJson(text);
  } catch (e) {
    console.error('Pass 4 JSON parse failed:', e, '\nRaw text:', text);
    return { flags: [], usage: response.usage };
  }

  if (!Array.isArray(parsed)) {
    console.error('Pass 4 did not return a JSON array. Got:', typeof parsed);
    return { flags: [], usage: response.usage };
  }

  // Sanitize every string field. Bound severity to allowed values.
  const allowedCategories = new Set([
    'short_form', 'signal', 'parenthetical', 'capitalization', 'history', 'parallel',
  ]);
  const allowedSeverities = new Set(['review', 'non_conforming']);

  const flags = parsed
    .filter((f) => f && typeof f.citation_index === 'number' && f.citation_index >= 0 && f.citation_index < citations.length)
    .map((f) => ({
      citation_index: f.citation_index,
      severity: allowedSeverities.has(f.severity) ? f.severity : 'review',
      category: allowedCategories.has(f.category) ? f.category : 'short_form',
      rule_cite: sanitizeOutput(f.rule_cite || ''),
      table_cite: f.table_cite ? sanitizeOutput(f.table_cite) : null,
      // Run BOTH the global banned-phrase sanitizer AND the Pass-4-
      // specific debug-index stripper. The latter removes internal
      // array-index leakage like "citation_index 7" or "candidate #10"
      // that Sonnet sometimes embeds in the message text despite the
      // prompt's prohibition. Defensive belt-and-suspenders.
      message: stripIndexLeakage(sanitizeOutput(f.message || '')),
      suggested_fix: f.suggested_fix ? stripIndexLeakage(sanitizeOutput(f.suggested_fix)) : null,
    }))
    .filter((f) => f.rule_cite && f.message);

  return { flags, usage: response.usage };
}

/**
 * Round 25 — Pass-4 territory dedup.
 *
 * Pass 4 (LLM) occasionally emits flags whose rule_cite belongs to Pass 3's
 * deterministic territory (R. 3.2(a) en-dash, R. 6.1 missing periods,
 * R. 10.2.2 / T6 abbreviations, R. 10.4 court parenthetical, etc.). These
 * cause user-visible duplicates with TRUNCATED suggested-fix text — the
 * LLM uses `components.case_name` (which Pass 2 sometimes extracts shorter
 * than the full case name) instead of the candidate's full text.
 *
 * Two-layer drop:
 *   (a) Hard blocklist by rule_cite — any Pass 4 emission whose rule is in
 *       PASS3_TERRITORY is dropped unconditionally.
 *   (b) Per-citation dedup — if the target citation already carries a
 *       flag with the same rule_cite (from Pass 3), drop the Pass 4
 *       emission to avoid double-comments.
 *
 * @param {Array<JudgmentFlag>} pass4Flags — flags from judgeEdgeCases()
 * @param {Array<EnrichedCitation>} citations — the array Pass 4 keys into
 *   via citation_index. Each citation must have a `flags` array (Pass 3's
 *   prior emissions).
 * @returns {{ kept: Array<JudgmentFlag>, dropped: Array<{flag, reason}> }}
 *   Kept flags are safe to merge onto target citations. Dropped is for
 *   logging / diagnostics only.
 */
export const PASS3_TERRITORY = new Set([
  'BB R. 3.2(a)',          // pin-cite ranges, em dash → en dash
  'BB R. 3.3',             // section symbol spacing
  'BB R. 6.1',             // missing periods on T6 abbreviations
  'BB R. 10.2.1',          // case-name geographic / first-word
  'BB R. 10.2.2',          // case-name T6 abbreviations
  'BB R. 10.4',            // court parenthetical
  'BB R. 10.5',            // year parenthetical formatting
  'BB R. 10.7',            // subsequent history (cert. denied, etc.)
  'BB R. 8',               // R. 8 capitalization (Pass 3 / scanner)
]);

export function filterPass4Territory(pass4Flags, citations) {
  if (!Array.isArray(pass4Flags) || pass4Flags.length === 0) {
    return { kept: [], dropped: [] };
  }
  const kept = [];
  const dropped = [];
  for (const f of pass4Flags) {
    if (PASS3_TERRITORY.has(f.rule_cite)) {
      dropped.push({ flag: f, reason: 'pass3_territory_blocklist' });
      continue;
    }
    const target = citations[f.citation_index];
    if (!target) {
      dropped.push({ flag: f, reason: 'no_target_citation' });
      continue;
    }
    const dupOfPass3 = (target.flags || []).some((existing) => existing.rule_cite === f.rule_cite);
    if (dupOfPass3) {
      dropped.push({ flag: f, reason: 'duplicates_pass3_emission' });
      continue;
    }
    kept.push(f);
  }
  return { kept, dropped };
}

/**
 * Strip internal-index leakage from Pass 4 messages.
 *
 * Sonnet occasionally includes phrases like "citation_index 7" or
 * "candidate #10" in user-facing message text despite the prompt's
 * explicit prohibition. These references are debug artifacts —
 * meaningless to attorneys reading the comments. This sanitizer
 * removes them post-hoc.
 *
 * Examples this strips:
 *   "Stoneridge cite at citation_index 7 lacks a full form"
 *      → "Stoneridge cite lacks a full form"
 *   "candidate #10 should use the case short form"
 *      → "should use the case short form"
 *   "(see citation_index 4)"
 *      → ""
 */
function stripIndexLeakage(s) {
  if (!s || typeof s !== 'string') return s;
  let out = s;
  // Phrases like "citation_index 7", "candidate_index 4", "candidate #10",
  // "citation #N", "index N", "(see citation_index N)", with or without
  // surrounding punctuation.
  out = out.replace(/\s*\(?\s*(?:see\s+)?(?:citation|candidate)[_\s#]*(?:index)?[\s#]*\d+\s*\)?\s*[,:]?/gi, ' ');
  out = out.replace(/\s*\(?\s*index\s+\d+\s*\)?\s*[,:]?/gi, ' ');
  // Collapse double spaces left behind.
  out = out.replace(/\s{2,}/g, ' ').trim();
  // If a leading "at " was orphaned (e.g., "Stoneridge at, " after stripping),
  // clean that up.
  out = out.replace(/\s+at\s*[,.]/g, '.');
  return out;
}

/**
 * Build the user-message payload for Pass 4. Per BUILD_SPEC §11.2: the
 * model sees only the structured citation list, NOT the document text.
 * This is the privilege guarantee: cross-citation reasoning runs on
 * metadata, not on the underlying brief.
 */
function buildUserMessage(citations, { style }) {
  // Strip pre/post context to keep payload compact and to enforce the
  // "Pass 4 does not see the document body" rule.
  const compact = citations.map((c, i) => ({
    citation_index: i,
    citation_type: c.citation_type,
    candidate_text: c.candidate_text,
    components: c.components || {},
    in_footnote: c.in_footnote || false,
    footnote_num: c.footnote_num ?? null,
    page_number: c.page_number ?? null,
    char_start: c.char_start, // for ordering reasoning
  }));

  const prompt =
`Apply Stage 3 cross-citation tests from the protocol to the citation list below.
Style: ${style === 'whitepages' ? 'WHITE-PAGES (R-rules)' : 'BLUEPAGES (BP-rules)'}.

Check ONLY:
- Signal ordering within string cites (R. 1.3 / R. 1.4)
- Authority weight ordering (R. 1.4)
- Short-form propriety: Id., supra, case short forms (R. 4 / R. 10.9)
- Id. chain integrity across footnote breaks (R. 4.1)
- Parenthetical placement and ordering (R. 1.5 / R. 10.6)
- String cite separator punctuation (R. 1.1)

CRITICAL — DO NOT EMIT NOISY FLAGS:

A. NEVER emit a flag whose message is essentially "this could be right or
   wrong, decide for yourself" — those are punts, not findings. If you
   genuinely cannot tell from the protocol + the cited Anthon reference,
   omit the flag. Only emit flags where the rule is unambiguously violated.

B. NEVER flag "lacking party names" / "short form missing parties" /
   "case name not found in citation" when components.case_name is
   non-null on the target citation. Pass 2 already extracted the case
   name; the absence in candidate_text is just Pass 1's reach-back
   limitation, not a real defect.

C. Signal usage (R. 1.2): "See" is correct when the cited authority
   IMPLICITLY supports the textual proposition (paraphrasing, not direct
   quote). "See, e.g.," is correct when the cited authority is one of
   several that support the proposition. DO NOT flag "See" or "See, e.g."
   as wrong unless the proposition is directly quoting the source verbatim
   (which would call for no signal). When the surrounding context isn't
   visible, ASSUME the signal is correct.

D. NEVER duplicate Pass 3 findings (case-name abbrev, reporter currency,
   court parenthetical formatting, geographical abbreviations, missing
   periods including missing periods on T6 abbreviations like "Atl"/"Atl."
   or "Co"/"Co.", section symbol spacing, reporter spacing, stray commas,
   pin-cite range hyphens/em-dashes that should be en dashes (R. 3.2(a)),
   id. short-form pin range dashes (R. 3.2(a)), paragraph range dashes
   (R. 3.2(a))). These are Pass 3's job — even if you spot them, do NOT
   emit them as Pass 4 flags. Their correct rule cite is R. 6.1 / T6 /
   R. 3.2(a), NOT R. 10.9(a). The orchestrator drops any Pass 4 flag
   whose rule_cite is in this set, so emitting one wastes tokens.

E. NEVER use the words "fake", "hallucinated", "fictitious", "incorrect",
   or "wrong" in any output.

F. NEVER include internal indices in user-facing messages. Specifically:
   the words "citation_index", "candidate_index", "candidate #N",
   "citation #N", "index N", or any reference to array positions are
   FORBIDDEN. Refer to citations by their case name + reporter cite
   only. Internal indices are for your own reasoning; they do not
   belong in the output schema's "message" field.

G. SHORT-FORM PROXIMITY (R. 10.9(a)): a case short form is permitted
   when the full citation appeared earlier in the same general
   discussion. Treat citations within ~5 entries of each other in the
   input array, OR within the same string cite (separated by ";"
   between citation_index N and citation_index N+1), as "same
   discussion." Do NOT flag the second short form in a string cite
   that begins with the full form. Do NOT flag a short form that
   follows the full form within the same paragraph as defined by
   adjacent char_start values.

If you have nothing strong to flag, return [] (empty array).

Output ONLY a JSON array, no prose, no markdown fences. Schema:

[
  {
    "citation_index":  <int>,                 // index in the input array
    "severity":        "review" | "non_conforming",
    "category":        "short_form" | "signal" | "parenthetical"
                     | "capitalization" | "history" | "parallel",
    "rule_cite":       <string>,              // e.g. "BB R. 4.1"
    "table_cite":      <string|null>,
    "message":         <string>,              // human-readable, no banned words
    "suggested_fix":   <string|null>          // ready-to-paste, when applicable
  }
]

If no cross-citation issues are found, return an empty array: [].

CITATIONS (JSON):
${JSON.stringify(compact, null, 2)}`;

  return [{ type: 'text', text: prompt }];
}
