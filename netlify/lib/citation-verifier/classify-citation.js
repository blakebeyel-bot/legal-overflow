/**
 * Citation Verifier — Pass 2 classifier (Sonnet 4.6).
 *
 * Per BUILD_SPEC §3 + §8: takes a batch of Pass 1 candidates plus their
 * surrounding context and returns structured ClassifiedCitation objects:
 *   - citation_type (case / statute / regulation / constitutional /
 *     short_form_id / short_form_supra / short_form_case / book /
 *     periodical / internet / court_document / unknown)
 *   - components (case_name, volume, reporter, first_page, pin_cite,
 *     year, court_parenthetical, OR title/section/code, etc.)
 *   - governing_rule (Bluebook rule pin-cite)
 *   - governing_table (Bluebook table pin-cite, optional)
 *
 * Why batch the candidates
 * ------------------------
 * The skill (15+ KB) gets cached as the system prompt. Every additional
 * candidate in the same call costs only the per-candidate context window,
 * not the skill re-read. Per BUILD_SPEC §8: classify in batches of 10–20
 * candidates per call. Keeps cache hit rate near 100% across the
 * document.
 *
 * Why Sonnet 4.6 specifically
 * ---------------------------
 * Per BUILD_SPEC §16: Sonnet 4.6 is locked for Pass 2 and Pass 4. Do not
 * downgrade. Citation classification needs the full reasoning of the
 * frontier; a Haiku would miscall short forms and string-cite components.
 *
 * Token-budget safety
 * -------------------
 * Pass 1 may extract hundreds of candidates from a 50-page brief. The
 * orchestrator slices into batches of BATCH_SIZE; this module classifies
 * one batch at a time. The orchestrator owns the loop; we just classify
 * what we're handed.
 */

import Anthropic from '@anthropic-ai/sdk';
import { MODEL_ID } from '../constants.js';
import { recordUsage } from '../supabase-admin.js';
import { skillSystemBlock, sanitizeOutput } from './skill-prompt.js';
import { extractJson } from '../anthropic.js';

export const BATCH_SIZE = 15; // candidates per call
const MAX_TOKENS = 8192;
const AGENT_NAME = 'citation-verifier-pass2';

let _client = null;
function client() {
  if (_client) return _client;
  // Mirrors lib/anthropic.js: Netlify auto-injects ANTHROPIC_API_KEY with
  // a JWT; we read LO_ANTHROPIC_API_KEY first to keep using our own key.
  const lo = process.env.LO_ANTHROPIC_API_KEY;
  const fallback = process.env.ANTHROPIC_API_KEY;
  const key =
    (lo && lo.startsWith('sk-ant-')) ? lo :
    (fallback && fallback.startsWith('sk-ant-')) ? fallback :
    null;
  if (!key) {
    throw new Error(
      'No direct Anthropic API key found. Set LO_ANTHROPIC_API_KEY to your sk-ant-api03-... key.'
    );
  }
  _client = new Anthropic({ apiKey: key, baseURL: 'https://api.anthropic.com' });
  return _client;
}

/**
 * Classify one batch of candidates.
 *
 * @param {object} args
 * @param {Array<Candidate>} args.candidates — Pass 1 candidates (BATCH_SIZE max)
 * @param {string} args.style — 'bluepages' | 'whitepages'
 * @param {string} args.ruleset — 'federal' (used to pick BT2 local rules)
 * @param {string} args.userId — for usage tracking
 * @param {string} [args.runId] — for log correlation; not stored as FK
 * @returns {Promise<{ classifications: ClassifiedCitation[], usage }>}
 */
export async function classifyCitationBatch({
  candidates,
  style = 'bluepages',
  ruleset = 'federal',
  userId,
  runId = null,
}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { classifications: [], usage: null };
  }
  if (candidates.length > BATCH_SIZE) {
    throw new Error(
      `classifyCitationBatch received ${candidates.length} candidates; max is ${BATCH_SIZE}. ` +
      'The orchestrator should slice before calling.'
    );
  }

  const userMessage = buildUserMessage(candidates, { style, ruleset });

  const response = await client().messages.create({
    model: MODEL_ID,
    max_tokens: MAX_TOKENS,
    system: skillSystemBlock(),
    messages: [{ role: 'user', content: userMessage }],
  });

  // Best-effort usage tracking. citation-verifier runs are NOT in the
  // reviews table (different agent), so review_id is null. agent_name
  // disambiguates citation-verifier vs contract-review.
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

  // Parse JSON, then sanitize every string field that goes into the user
  // experience (suggested_fix, etc.).
  let parsed;
  try {
    parsed = extractJson(text);
  } catch (e) {
    console.error('Pass 2 JSON parse failed:', e, '\nRaw text:', text);
    throw new Error(`Pass 2 classifier returned unparseable JSON: ${e.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Pass 2 classifier did not return a JSON array of classifications.');
  }

  // CRITICAL — iterate over INPUT candidates, not Sonnet's parsed output.
  // Sonnet sometimes returns fewer entries than we sent (skipping borderline
  // cases, merging duplicates, dropping ones it doesn't classify confidently).
  // The previous code mapped over `parsed`, which silently dropped any
  // candidate Sonnet skipped — Pass 3 validators never ran on those, and
  // the brief's Skinner / Murphy / Helicopteros catches were missed in
  // exactly that pattern.
  //
  // New behavior: every input candidate gets a classification, even if
  // Sonnet didn't return one for it. Missing entries fall back to
  // citation_type='unknown' with empty components — Pass 3's text-level
  // validators (validateCitationForm, validateCorporateCommas, etc.) still
  // run on candidate_text and catch form errors. Component-dependent
  // validators (case-name abbreviations, nominative reporters) gracefully
  // no-op on empty components.
  const byIndex = new Map();
  for (const r of parsed) {
    if (typeof r?.candidate_index === 'number') byIndex.set(r.candidate_index, r);
  }
  const classifications = candidates.map((orig, idx) => {
    const r = byIndex.get(idx) || {};
    return {
      // Stable identity from Pass 1 — present for every candidate.
      pattern_name: orig.pattern_name,
      // Round 30 — propagate provisional_type alongside citation_type so
      // downstream short-form gates have a deterministic Pass-1 signal to
      // fall back on when Pass 2's LLM misclassifies (e.g., classifying
      // "Vivendi, 838 F.3d at 247" as 'case' instead of 'short_form_case'
      // when the LLM lost short-form context). Validators use the helper
      // isShortFormCaseCitation() which checks citation_type OR
      // provisional_type OR pattern_name === 'short_case'.
      provisional_type: orig.provisional_type,
      candidate_text: orig.candidate_text,
      candidate_text_hash: orig.candidate_text_hash,
      char_start: orig.char_start,
      char_end: orig.char_end,
      page_number: orig.page_number ?? null,
      in_footnote: orig.in_footnote ?? false,
      footnote_num: orig.footnote_num ?? null,
      // Pass 2 outputs — but Pass 1's provisional type wins when Sonnet
      // says 'unknown' or returns nothing. Round 9 fix: the `||`
      // operator below didn't fire when Sonnet returned the literal
      // string 'unknown' (truthy), so Murphy and Globe Refining were
      // dropped to 'unknown' citation_type → filtered out of the case-
      // citation list → marked not_applicable by CourtListener even
      // though Pass 1 had correctly identified them as 'case'.
      // pickCitationType keeps Pass 1's authoritative case detection
      // when Sonnet's response is missing or unhelpful.
      citation_type: pickCitationType(r.citation_type, orig.provisional_type),
      components: r.components || {},
      governing_rule: sanitizeOutput(r.governing_rule || null),
      governing_table: sanitizeOutput(r.governing_table || null),
    };
  });

  return { classifications, usage: response.usage };
}

/**
 * If Sonnet didn't classify a candidate, fall back to the provisional
 * type Pass 1 already assigned. Pass 1's regex set `provisional_type`
 * to one of: 'case', 'short_form_id', 'short_form_supra',
 * 'short_form_case', 'statute', 'regulation', 'constitutional',
 * 'court_document', 'book', or 'unknown'. We re-use it so downstream
 * validators that gate on citation_type still run sensibly.
 */
function inferTypeFromProvisional(provisional) {
  const VALID = new Set([
    'case', 'short_form_id', 'short_form_supra', 'short_form_case',
    'statute', 'regulation', 'constitutional', 'court_document',
    'book', 'periodical', 'internet', 'unknown',
  ]);
  if (provisional && VALID.has(provisional)) return provisional;
  return 'unknown';
}

/**
 * Pick the authoritative citation_type for a candidate.
 *
 * Pass 1's regex-based detection is deterministic — when it tags a
 * candidate as 'case' (because the candidate text contains " v. " /
 * " v " / " vs. " between two capitalized parties followed by
 * volume + reporter + page), that classification is correct by
 * construction. Sonnet's Pass 2 sometimes downgrades these to
 * 'unknown' (especially when "vs." or other non-standard versus
 * markers throw it off). Round 9 fix:
 *
 *   - If Pass 1 said 'case' AND Sonnet said 'unknown' or nothing,
 *     the result is 'case'. Pass 1 wins on this specific override.
 *   - If Pass 1 said 'case' AND Sonnet said 'short_form_case' or
 *     similarly more-specific case-family type, prefer Sonnet's.
 *   - Otherwise prefer Sonnet, fall back to Pass 1's provisional.
 */
function pickCitationType(parsedType, provisional) {
  const CASE_FAMILY = new Set(['case', 'short_form_case']);
  if (provisional === 'case' && (!parsedType || parsedType === 'unknown')) {
    return 'case';
  }
  if (provisional === 'case' && CASE_FAMILY.has(parsedType)) {
    return parsedType; // Sonnet picked the more-specific family member.
  }
  return parsedType || inferTypeFromProvisional(provisional);
}

/**
 * Build the user-message content for one batch. Returns the SDK-shaped
 * `content` array (a single text block — keeping things simple).
 *
 * The message is intentionally compact: the skill is in the system, so
 * here we only need (a) a clear instruction, (b) the candidates with
 * surrounding context. Two-shot is enough; the skill carries the
 * detailed protocol.
 */
function buildUserMessage(candidates, { style, ruleset }) {
  const candidatesJson = candidates.map((c, i) => ({
    candidate_index: i,
    provisional_type: c.provisional_type,
    candidate_text: c.candidate_text,
    pre_context: c.pre_context,
    post_context: c.post_context,
    in_footnote: c.in_footnote || false,
    footnote_num: c.footnote_num || null,
    page_number: c.page_number ?? null,
  }));

  const prompt =
`Classify each candidate citation below according to the Citation Verification Protocol.
Apply ${style === 'whitepages' ? 'WHITE-PAGES (R-rules; scholarly)' : 'BLUEPAGES (BP-rules; practitioner)'} style.
Ruleset: ${ruleset}.

CRITICAL CLASSIFICATION RULES — read carefully:

0. FULL CASE vs SHORT FORM — most common misclassification:
   • If the candidate_text OR pre_context contains a "v." (or "v" no period)
     between two capitalized parties followed by volume + reporter + page,
     classify as citation_type="case" — even when the candidate_text Pass 1
     gave you starts mid-cite (e.g., "564 U.S. 873 (2011)" with the case
     name in pre_context). DO NOT default to "short_form_case" just because
     the candidate_text doesn't include the "v." token. ALWAYS scan
     pre_context for the case name first.
   • Use citation_type="short_form_case" ONLY when the pattern is
     "<short_name>, <vol> <reporter> at <pin>" (R. 10.9) — i.e., the
     short form has "at" before the pin-cite and references a case that
     was cited in full earlier.
   • Use citation_type="short_form_id" ONLY for "Id." or "Id. at X".
   • Use citation_type="short_form_supra" ONLY for "<name> supra" patterns.

1. CASE NAMES (components.case_name for citation_type="case"):
   • Output the case name PROPER — start at the first capital letter of
     the plaintiff/petitioner/movant. STRIP every leading word that is
     not part of the case name itself: "See", "See also", "See, e.g.,",
     "Cf.", "Contra", "But see", "But cf.", "Compare", "Accord", "e.g.,",
     "as in", "as set forth in", "Even", "Although", "While in", "In",
     "the seminal case", etc.
   • Use the canonical Bluebook abbreviations (Corp., Co., Inc., Bros.,
     Bd. of Educ., Ass'n, Comm'n, Dep't, etc.). You may return the
     UNABBREVIATED form here — Pass 3 will flag T6 violations separately
     — but do NOT introduce abbreviations that aren't in the source.
   • Include the "v." (lowercase, with period). Both party names belong
     in case_name.
   • Examples (verbatim → case_name):
       "See Brown v. Bd. of Educ., 347 U.S. 483 (1954)"
         → "Brown v. Bd. of Educ."
       "Even Marbury v. Madison, 5 U.S. 137 (1803)"
         → "Marbury v. Madison"
       "Court relied on Int'l Shoe Co. v. Washington, 326 U.S. 310, 316 (1945)"
         → "Int'l Shoe Co. v. Washington"
       "the test in Smith v. Jones, 100 F.3d 1 (2d Cir. 1990)"
         → "Smith v. Jones"
       "Reyes v. Gulfstream Indem. Co., 318 So.3d 442 (Fla. 4th DCA 2021)"
         → "Reyes v. Gulfstream Indem. Co."

2. WHEN A CASE NAME ISN'T VISIBLE in pre_context or candidate_text:
   • Set components.case_name to null. Do NOT guess. Do NOT fabricate.
     Pass 2.5's existence check + the marked-source comments will surface
     missing case names so the drafting attorney sees the gap.

3. REPORTER + VOLUME + FIRST PAGE:
   • Use canonical Bluebook reporter abbreviations exactly as printed
     (e.g., "F.3d" not "F. 3d"; "U.S." not "US"; "S.W.2d" not "SW2d").
   • volume and first_page are integers. pin_cite is a string ("495",
     "495-97", "495 n.12").

4. COURT PARENTHETICAL:
   • Capture EXACTLY what's in the parens, e.g. "2d Cir. 2019" not just
     the year. Pass 3 validates the form against T7.

5. NORMALIZATION:
   • For reporter abbreviations, output the canonical Bluebook form even
     when the source dropped periods. Example: source="556 US 662"
     → reporter="U.S." (canonical). This lets Pass 3 flag the form
     error while still letting CourtListener verify against the cite.
   • For "U.S.C." vs "USC": always output components.code="U.S.C.".
   • For "C.F.R." vs "CFR": always output components.code="C.F.R.".

6. NEW CITATION TYPES — handle these when you see them:

   • RESTATEMENT (R. 12.9.5):
     citation_type = "book", components = {
       title: "Restatement (Second) of Contracts" or whatever appears,
       section: section number ("351"),
       publisher: "Am. L. Inst." or null if absent,
       year: number or null,
     }
     Example source: "Restatement 2d Contracts §351"
       → citation_type="book", components.title="Restatement 2d Contracts",
         section="351", publisher=null, year=null
     (Pass 3 flags the missing publisher/year/parenthesized series.)

   • FEDERAL RULES (R. 12.9.3):
     citation_type = "court_document", components = {
       rule_set: "Fed. R. Civ. P." | "Fed. R. Crim. P." | "Fed. R. App. P."
                 | "Fed. R. Evid." | "FRCP" | "FRCrP" | "FRAP" | "FRE"
                 (output verbatim what the source uses; Pass 3 normalizes),
       rule_number: "12(b)(2)" or whatever,
     }

   • UNREPORTED CASE / WL (R. 10.8.1):
     citation_type = "case", components = {
       case_name, year, database: "WL" | "LEXIS",
       database_number: "4567321",
       court_parenthetical, pin_cite_after_star, decision_date (e.g. "Sept. 18, 2019")
     }
     If pin_cite_after_star or decision_date is missing in the source, set
     them to null — Pass 3 will flag the omission.

7. SHORT FORMS:
   • short_form_id: components.pin_cite is the page after "at", e.g.
     "Id. at 495" → pin_cite="495"; "Id." alone → pin_cite=null.
   • short_form_supra: components.referent_name is whatever name precedes
     "supra" in the source. note is the footnote number if present.
   • short_form_case: components.case_short is the shortened name (e.g.
     "Brown" from "Brown, 347 U.S. at 495").

Output ONLY a JSON array, no prose, no markdown fences. One object per
candidate, in the same order. Schema:

[
  {
    "candidate_index": <int>,                         // matches input
    "citation_type": "case" | "statute" | "regulation" | "constitutional"
                   | "short_form_id" | "short_form_supra" | "short_form_case"
                   | "book" | "periodical" | "internet" | "court_document"
                   | "unknown",
    "components": {
      // For citation_type="case":
      "case_name":           <string|null>,
      "volume":              <int|null>,
      "reporter":            <string|null>,           // canonical Bluebook abbrev
      "first_page":          <int|null>,
      "pin_cite":            <string|null>,           // page or range, e.g. "495", "495-97"
      "court_parenthetical": <string|null>,           // e.g. "2d Cir. 2019"; null if none
      "year":                <int|null>,
      "signal":              <string|null>            // "See", "See also", "Cf.", etc.

      // For citation_type="statute":
      // "title":   <int|string|null>, "code": <string|null>, "section": <string|null>, "year": <int|null>

      // For citation_type="regulation":
      // "title":   <int|null>, "code": "C.F.R."|null, "section": <string|null>, "year": <int|null>

      // For citation_type="constitutional":
      // "jurisdiction": <string|null>, "article_or_amendment": <string|null>, "section": <string|null>

      // For citation_type="short_form_id":
      // "pin_cite": <string|null>

      // For citation_type="short_form_supra":
      // "referent_name": <string|null>, "note": <int|null>, "pin_cite": <string|null>

      // For citation_type="short_form_case":
      // "case_short": <string|null>, "volume": <int|null>, "reporter": <string|null>, "pin_cite": <string|null>
    },
    "governing_rule":  <string>,                       // e.g. "BB R. 10" or "BB R. 12.3"
    "governing_table": <string|null>                   // e.g. "T1; T6; T7"
  }
]

CANDIDATES (JSON):
${JSON.stringify(candidatesJson, null, 2)}`;

  return [{ type: 'text', text: prompt }];
}
