/**
 * Citation Verifier — CourtListener API client (Pass 2.5).
 *
 * Per BUILD_SPEC §9: existence-check every classified case citation
 * against CourtListener's public search API. Pure code, no LLM.
 *
 * Constraints (BUILD_SPEC §16):
 *   - 5,000 calls/day free tier — once we trip an HTTP 429 or a 5xx
 *     "daily limit reached" we MUST fail soft: every remaining
 *     existence-check returns "existence_uncertain" with a "manual
 *     verification recommended" note. The run still completes.
 *   - 15s per-call timeout (CourtListener can be slow).
 *   - Concurrency cap of 3 — we don't want to be rate-limited even when
 *     processing a 200-citation brief.
 *   - The API key (`COURTLISTENER_API_KEY`) is server-side only. NEVER
 *     return it to the browser, NEVER include it in error messages.
 *
 * Banned phrases: same rules as the rest of the verifier. The strongest
 * permitted user-facing language is "could not be located in
 * CourtListener — please verify before filing." See skill-prompt.js for
 * the sanitizer.
 */

const COURTLISTENER_BASE = 'https://www.courtlistener.com';
const SEARCH_PATH = '/api/rest/v3/search/';
// Human-browsable search path — what we surface in user-visible
// comments. The user clicks this and gets a real search results page,
// not raw JSON from the API.
const HUMAN_SEARCH_PATH = '/';

/**
 * Build the human-facing CourtListener search URL surfaced to users.
 * Different from the API search URL we hit from the function.
 */
function humanSearchUrl(query) {
  return `${COURTLISTENER_BASE}${HUMAN_SEARCH_PATH}?type=o&q=${encodeURIComponent(query)}`;
}
// citation-lookup is a v4 endpoint that takes a free-form citation
// string and returns the matching opinion clusters directly. Far less
// fuzzy than search — when a real case is in CourtListener, this
// returns it; when it isn't, the response is unambiguously empty.
// Reduces the "uncertain" flag noise that drowned out the real
// "this case doesn't exist" signals in the v3 search-based approach.
const CITATION_LOOKUP_PATH = '/api/rest/v4/citation-lookup/';
const PER_CALL_TIMEOUT_MS = 15_000;
const CONCURRENCY_CAP = 3;

/**
 * Module-level state. The orchestrator instantiates ONE Verifier per run
 * (so the cache and rate-limit flag don't bleed across users).
 */
export class CourtListenerClient {
  constructor({ apiKey, fetchImpl = globalThis.fetch } = {}) {
    this.apiKey = apiKey || process.env.COURTLISTENER_API_KEY || '';
    this.fetch = fetchImpl;
    // Per-run cache: key = "<volume>|<reporter>|<first_page>"
    this.cache = new Map();
    // Once tripped, every subsequent lookup short-circuits to uncertain.
    this.dailyLimitTripped = false;
    // For observability — total HTTP calls made by this run.
    this.callCount = 0;
  }

  /**
   * Existence-check a single classified case citation.
   *
   * @param {ClassifiedCitation} c
   * @returns {Promise<ExistenceResult>}
   *
   * ExistenceResult shape (round 6: four-state classifier per spec):
   *   {
   *     status: 'existence_verified'         // VERIFIED — cite + name match
   *           | 'name_mismatch'              // NAME_MISMATCH — cite matches, name differs (HIGHEST VALUE)
   *           | 'existence_not_found'        // UNRESOLVED — no hit at this cite
   *           | 'existence_uncertain'        // ambiguous (rate limit, parse failure, partial match)
   *           | 'not_applicable',            // not a case citation, or non-US reporter
   *     opinion_id?:        string,
   *     url?:               string,
   *     search_url?:        string,
   *     case_name?:         string,         // canonical case name from CourtListener
   *     cited_name?:        string,         // case name as it appears in the brief
   *     note?:              string,
   *   }
   */
  async checkExistence(c) {
    if (!c || c.citation_type !== 'case') {
      return { status: 'not_applicable' };
    }
    const comp = c.components || {};
    const { volume, reporter, first_page } = comp;
    if (!volume || !reporter || !first_page) {
      // Pass 2 didn't fully parse the cite; nothing to query against.
      // Treat as UNRESOLVED — the orchestrator's suppression rule will
      // silence the comment if Pipeline A flagged anything on this
      // citation (which is the typical reason for incomplete parsing).
      return { status: 'existence_not_found', _reason: 'components_incomplete' };
    }

    // CourtListener's index does NOT cover:
    //   • English Reports / pre-1900 English cases (Hadley v. Baxendale, etc.)
    //   • Westlaw / LEXIS unreported decisions (those exist in CL only
    //     when CL has imported the actual opinion, which is rare for
    //     state trial-court WL cites)
    //   • Foreign jurisdictions
    //
    // Returning "existence_uncertain" on these created the false-flag
    // noise the user complained about. Mark them not_applicable so
    // they neither verify nor flag.
    const NON_US_OR_UNREPORTED = new Set([
      'Ex.', 'Eng. Rep.', 'Ch.', 'K.B.', 'Q.B.', 'A.C.', 'WLR',
      'WL', 'LEXIS', 'U.S. App. LEXIS',
    ]);
    if (NON_US_OR_UNREPORTED.has(reporter)) {
      return { status: 'not_applicable' };
    }

    const cacheKey = `${volume}|${reporter}|${first_page}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    // FIX #2 — Quota and infrastructure messages NEVER reach the user
    // as per-citation comments. When the daily limit is tripped, the
    // verifier silently disables itself for the rest of the run by
    // marking every subsequent lookup `not_applicable`. The orchestrator
    // can optionally surface a single end-of-run summary (see
    // getRunSummary() below); per-citation comments are forbidden.
    if (this.dailyLimitTripped) {
      this.quotaExhaustedSkips = (this.quotaExhaustedSkips || 0) + 1;
      const result = { status: 'not_applicable', _silent_reason: 'quota_exhausted' };
      this.cache.set(cacheKey, result);
      return result;
    }

    // Try the citation-lookup endpoint first — this is a v4 endpoint
    // that resolves citations from free-form prose to opinion clusters.
    // Round 9 — include the case name in the query when we have one.
    // CL's v4 endpoint is a citation EXTRACTOR (designed to pull cites
    // out of prose); a bare "573 U.S. 258" sometimes returns zero
    // clusters because the parser treats short fragments differently.
    // Sending the full citation string as it appears in the brief
    // (case name + volume + reporter + page) gives the parser the
    // context it expects and dramatically improves recall.
    const targetCite = comp.case_name
      ? `${comp.case_name}, ${volume} ${reporter} ${first_page}`
      : `${volume} ${reporter} ${first_page}`;
    const lookupResult = await this._tryCitationLookup(targetCite, comp);
    if (lookupResult !== null) {
      this.cache.set(cacheKey, lookupResult);
      return lookupResult;
    }
    // Fall through to v3 search if lookup is unavailable or returned
    // ambiguous results — preserves backwards compatibility while
    // capturing the noise reduction wherever lookup works.

    const query = [
      comp.case_name,
      String(volume),
      reporter,
      String(first_page),
    ].filter(Boolean).join(' ');

    const searchUrl = `${COURTLISTENER_BASE}${SEARCH_PATH}?type=o&q=${encodeURIComponent(query)}`;
    // The user-facing URL for "CourtListener search:" trailers — points
    // at the website's search page, not the JSON API endpoint.
    const humanUrl = humanSearchUrl(query);

    let response;
    try {
      this.callCount++;
      response = await this.fetch(searchUrl, {
        headers: this.apiKey ? { 'Authorization': `Token ${this.apiKey}` } : {},
        signal: AbortSignal.timeout(PER_CALL_TIMEOUT_MS),
      });
    } catch (err) {
      // FIX #2 — network / abort / DNS errors are infrastructure
      // failures. Silent skip; per-citation comment is forbidden.
      this.apiErrorCount = (this.apiErrorCount || 0) + 1;
      const result = { status: 'not_applicable', _silent_reason: 'api_error' };
      this.cache.set(cacheKey, result);
      return result;
    }

    // Daily-limit detection. CourtListener returns 429 when over-rate.
    // Some hosts also return 503 with a body indicating throttling.
    // FIX #2 — flip dailyLimitTripped, silently skip THIS citation, and
    // every subsequent lookup short-circuits silently too.
    if (response.status === 429 || (response.status === 503 && this.callCount > 100)) {
      this.dailyLimitTripped = true;
      this.quotaExhaustedSkips = (this.quotaExhaustedSkips || 0) + 1;
      const result = { status: 'not_applicable', _silent_reason: 'quota_exhausted' };
      this.cache.set(cacheKey, result);
      return result;
    }

    if (!response.ok) {
      // FIX #2 — any other HTTP error is infrastructure. Silent.
      this.apiErrorCount = (this.apiErrorCount || 0) + 1;
      const result = { status: 'not_applicable', _silent_reason: 'api_error' };
      this.cache.set(cacheKey, result);
      return result;
    }

    let data;
    try {
      data = await response.json();
    } catch (err) {
      // FIX #2 — bad JSON is infrastructure. Silent.
      this.apiErrorCount = (this.apiErrorCount || 0) + 1;
      const result = { status: 'not_applicable', _silent_reason: 'api_error' };
      this.cache.set(cacheKey, result);
      return result;
    }

    if (!data || data.count === 0) {
      const result = {
        status: 'existence_not_found',
        search_url: humanUrl,
      };
      this.cache.set(cacheKey, result);
      return result;
    }

    // Match the top hit by reporter + volume + page. Also scan ALL
    // returned results, not just the first — when case_name was absent
    // from the query, CourtListener may rank a different opinion at
    // position 0 even though one of the lower hits is the correct match.
    const allResults = Array.isArray(data.results) ? data.results : [];
    let matchedHit = null;
    for (const hit of allResults) {
      if (matchesComponents(hit, comp)) {
        matchedHit = hit;
        break;
      }
    }

    if (matchedHit) {
      const result = {
        status: 'existence_verified',
        opinion_id: String(matchedHit.id),
        url: matchedHit.absolute_url ? `${COURTLISTENER_BASE}${matchedHit.absolute_url}` : null,
        search_url: humanUrl,
        // Round-trip the canonical case name so the orchestrator can
        // back-fill components.case_name when Pass 2 missed it.
        case_name: matchedHit.caseName || matchedHit.case_name || null,
      };
      this.cache.set(cacheKey, result);
      return result;
    }

    // If no exact match but at least one result came back AND we lacked
    // a case_name in the query, accept the top hit as a "soft match"
    // when its citations array contains the cited reporter/volume/page
    // (loose substring check). This recovers from poorly-scored search
    // results when the query was imprecise.
    if (allResults.length > 0 && !comp.case_name) {
      const top = allResults[0];
      const cites = Array.isArray(top.citation) ? top.citation : (typeof top.citation === 'string' ? [top.citation] : []);
      const targetVolPage = `${volume}` + ' ' + reporter + ' ' + first_page;
      const looseHit = cites.some((c) => normalizeForLooseMatch(c).includes(normalizeForLooseMatch(targetVolPage)));
      if (looseHit) {
        const result = {
          status: 'existence_verified',
          opinion_id: String(top.id),
          url: top.absolute_url ? `${COURTLISTENER_BASE}${top.absolute_url}` : null,
          search_url: humanUrl,
          case_name: top.caseName || top.case_name || null,
          note: 'Verified by loose volume/reporter/page match; case name was missing from the parsed citation.',
        };
        this.cache.set(cacheKey, result);
        return result;
      }
    }

    // No exact match found at the cited volume/reporter/page. This is
    // UNRESOLVED per the spec — same flag treatment as "no result at
    // all," and the orchestrator's suppression rule (any Pipeline A
    // flag → no UNRESOLVED comment) applies.
    const result = {
      status: 'existence_not_found',
      search_url: searchUrl,
    };
    this.cache.set(cacheKey, result);
    return result;
  }

  /**
   * Try the v4 citation-lookup endpoint. Returns:
   *   - { status: 'existence_verified', ... } on a confident match
   *   - { status: 'existence_not_found', ... } on an empty result
   *   - null on any error / ambiguous response (caller falls back to search)
   *
   * Per CourtListener docs, citation-lookup accepts a `text` param
   * containing one or more citation strings and returns parsed cite
   * objects with cluster/opinion IDs when found. We send a minimal
   * "<vol> <reporter> <page>" string and inspect the response.
   */
  async _tryCitationLookup(targetCite, comp) {
    const url = `${COURTLISTENER_BASE}${CITATION_LOOKUP_PATH}`;
    let response;
    try {
      this.callCount++;
      response = await this.fetch(url, {
        method: 'POST',
        headers: {
          ...(this.apiKey ? { 'Authorization': `Token ${this.apiKey}` } : {}),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `text=${encodeURIComponent(targetCite)}`,
        signal: AbortSignal.timeout(PER_CALL_TIMEOUT_MS),
      });
    } catch (err) {
      // Network or timeout — let the caller fall back to v3 search
      // so we don't pessimistically mark "uncertain" on transient
      // hiccups.
      return null;
    }

    // 429 — daily limit. FIX #2: silent skip. No per-citation comment.
    if (response.status === 429) {
      this.dailyLimitTripped = true;
      this.quotaExhaustedSkips = (this.quotaExhaustedSkips || 0) + 1;
      return { status: 'not_applicable', _silent_reason: 'quota_exhausted' };
    }
    // 4xx other than 429: probably the v4 endpoint isn't available on
    // this account / region. Fall back. Round 9 — log so we can see
    // when v4 is silently being bypassed.
    if (response.status >= 400 && response.status !== 429) {
      console.error(`[cl-v4-fallthrough] HTTP ${response.status} for cite "${targetCite}" — falling through to v3 search`);
      return null;
    }
    if (!response.ok) {
      console.error(`[cl-v4-fallthrough] response not ok (${response.status}) for cite "${targetCite}"`);
      return null;
    }

    let data;
    try { data = await response.json(); }
    catch { return null; }

    // Response shape per CL v4 citation-lookup: an array of objects with
    // { citation, normalized_citations, status, error_message,
    //   start_index, end_index, clusters: [...] }.
    const entries = Array.isArray(data) ? data : (data?.results || []);
    if (entries.length === 0) return null;

    const first = entries[0];
    const clusters = Array.isArray(first?.clusters) ? first.clusters : [];

    // Confident "not found" — citation parsed but no clusters matched.
    // CL distinguishes "we parsed your cite and got nothing" from
    // "we couldn't parse your cite" via the status code on the entry.
    if (clusters.length === 0 && (first?.status === 200 || first?.status === 404)) {
      // Round 9 instrumentation — log when v4 returns zero clusters
      // for a citation we expected to resolve. Includes the cited
      // text and CL's parsed normalization so we can tell whether
      // the parser misread our query or CL just doesn't have it.
      console.error(
        '[cl-v4-no-clusters] ' +
        JSON.stringify({
          cited_text: targetCite,
          cited_components: { volume: comp.volume, reporter: comp.reporter, first_page: comp.first_page },
          parsed_citation: first?.citation,
          normalized: first?.normalized_citations,
          entry_status: first?.status,
          error_message: first?.error_message,
        })
      );
      return {
        status: 'existence_not_found',
        search_url: humanSearchUrl(targetCite),
      };
    }

    if (clusters.length > 0) {
      const cluster = clusters[0];
      const clCaseName = cluster.case_name || cluster.caseName || cluster.case_name_short || null;
      const clYear = cluster.date_filed ? String(cluster.date_filed).slice(0, 4) : null;
      const citedText = `${comp.volume} ${comp.reporter} ${comp.first_page}`;
      const baseResult = {
        opinion_id: String(cluster.id ?? cluster.cluster_id ?? ''),
        url: cluster.absolute_url ? `${COURTLISTENER_BASE}${cluster.absolute_url}` : null,
        case_name: clCaseName,
        actual_case_name: clCaseName,                  // for existenceResultToFlag
        actual_year: clYear,
        cited_name: comp.case_name || null,
        cited_text: citedText,                         // for existenceResultToFlag message
        search_url: url,
      };

      // Round 6.x — name-tolerance comparison. If the brief's case
      // name is missing (Pass 2 didn't extract it) OR CourtListener
      // didn't return a name, we can't judge a mismatch → VERIFIED.
      // Otherwise compare with 70% token-overlap threshold.
      if (!comp.case_name || !clCaseName) {
        return { status: 'existence_verified', ...baseResult };
      }
      const overlap = caseNameOverlap(comp.case_name, clCaseName);
      if (overlap >= 0.50) {
        return { status: 'existence_verified', ...baseResult, name_overlap: overlap };
      }
      // Round 8 — instrument every rejection so the function logs
      // expose name-comparison misses. The user can paste the
      // `[name-mismatch-reject]` line back to me and I'll see
      // exactly which token-handling rule needs widening. Includes:
      //   - both names verbatim (so I see CL's exact stored form)
      //   - both normalized forms (so I see what tokens survive)
      //   - the overlap score
      //   - the cited (vol/rep/page) anchor for cross-reference
      console.error(
        '[name-mismatch-reject] ' +
        JSON.stringify({
          cited_text: `${comp.volume} ${comp.reporter} ${comp.first_page}`,
          cited_name: comp.case_name,
          cl_name: clCaseName,
          cited_normalized: normalizeCaseName(comp.case_name),
          cl_normalized: normalizeCaseName(clCaseName),
          overlap,
          threshold: 0.50,
        })
      );
      return {
        status: 'existence_name_mismatch',
        ...baseResult,
        name_overlap: overlap,
      };
    }

    // Anything else — unclear, let the caller fall back.
    return null;
  }

  /**
   * Existence-check an array of classified citations with a concurrency
   * cap. Order of results matches the input array.
   */
  async checkAll(citations) {
    const results = new Array(citations.length);
    let next = 0;

    const workers = Array.from({ length: CONCURRENCY_CAP }, async () => {
      while (true) {
        const idx = next++;
        if (idx >= citations.length) break;
        try {
          results[idx] = await this.checkExistence(citations[idx]);
        } catch (err) {
          // FIX #2 — unexpected exception is infrastructure. Silent skip.
          this.apiErrorCount = (this.apiErrorCount || 0) + 1;
          console.error('[court-listener] checkExistence threw:', err);
          results[idx] = { status: 'not_applicable', _silent_reason: 'api_error' };
        }
      }
    });

    await Promise.all(workers);
    return results;
  }

  /**
   * FIX #2 — run-level summary the orchestrator can optionally surface
   * as a single end-of-run notice. NEVER per-citation. The summary
   * reports counts only — no per-citation noise.
   *
   * Returns null if everything went smoothly (no quota / api errors).
   */
  getRunSummary() {
    const quotaSkips = this.quotaExhaustedSkips || 0;
    const apiErrors = this.apiErrorCount || 0;
    if (quotaSkips === 0 && apiErrors === 0) return null;
    return {
      total_calls: this.callCount,
      quota_exhausted_skips: quotaSkips,
      api_error_count: apiErrors,
      message: this.dailyLimitTripped
        ? 'CourtListener daily quota was reached during this run; some case existence checks were skipped. The format checks below are still complete.'
        : (apiErrors > 0
            ? 'CourtListener was temporarily unreachable for some citations; existence checks for those were skipped. The format checks below are still complete.'
            : null),
    };
  }
}

/**
 * Match a CourtListener search result against parsed citation
 * components. We accept a result as a verified match when the cited
 * reporter + volume + first-page appear in any of the result's citation
 * strings. CourtListener returns parallel citations as an array of
 * strings under `citation`.
 */
export function matchesComponents(result, components) {
  if (!result || !components) return false;
  const { volume, reporter, first_page } = components;
  if (!volume || !reporter || !first_page) return false;

  const targetCite = `${volume} ${reporter} ${first_page}`;
  const cites = Array.isArray(result.citation)
    ? result.citation
    : (typeof result.citation === 'string' ? [result.citation] : []);

  // Exact substring (handles canonical Bluebook spacing).
  if (cites.some((c) => normalizeCite(c) === normalizeCite(targetCite))) {
    return true;
  }

  // Looser fallback: same volume + same first-page integer + reporter
  // string appears anywhere in the cite (handles "F.3d" vs "F. 3d" minor variations).
  return cites.some((c) => {
    const norm = normalizeCite(c);
    return norm.includes(`${volume} `) &&
           norm.includes(` ${first_page}`) &&
           reporterMatches(norm, reporter);
  });
}

function normalizeCite(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

// Stricter normalization for the loose-match fallback: collapse all
// whitespace and lowercase. "326  U.S.   310" → "326u.s.310"
function normalizeForLooseMatch(s) {
  return String(s).replace(/\s+/g, '').toLowerCase();
}

/**
 * Round 6.x — case-name tolerance.
 *
 * Normalize a case name for token-overlap comparison. Handles:
 *   • Punctuation (commas, periods, quotes) stripped
 *   • Versus marker — "v.", "v", "vs.", "vs" all collapse to "v"
 *   • Entity-suffix expansion in BOTH directions:
 *       Co./Company → "co"; Corp./Corporation → "corp";
 *       Inc./Incorporated → "inc"; Ltd./Limited → "ltd";
 *       Bros./Brothers → "bros"; Ass'n/Association → "assn";
 *       Comm'n/Commission → "commn"; Dep't/Department → "dept";
 *       Int'l/International → "intl"; Indus./Industries → "indus";
 *       Bd./Board → "bd"; Educ./Education → "educ"
 *   • Middle initials stripped (one-letter words like "J." or "A")
 *   • Common low-information tokens removed (the, of, a, an, &, and)
 */
const ENTITY_EXPANSIONS = [
  [/\b(co|company)\b/g, 'co'],
  [/\b(corp|corporation)\b/g, 'corp'],
  [/\b(inc|incorporated)\b/g, 'inc'],
  [/\b(ltd|limited)\b/g, 'ltd'],
  [/\b(bros|brothers)\b/g, 'bros'],
  [/\b(assn|association)\b/g, 'assn'],
  [/\b(commn|commission)\b/g, 'commn'],
  [/\b(dept|department)\b/g, 'dept'],
  [/\b(intl|international)\b/g, 'intl'],
  [/\b(indus|industries|industry)\b/g, 'indus'],
  [/\b(bd|board)\b/g, 'bd'],
  [/\b(educ|education)\b/g, 'educ'],
  [/\b(univ|university)\b/g, 'univ'],
  [/\b(servs|services|service)\b/g, 'servs'],
  [/\b(mfg|manufacturing)\b/g, 'mfg'],
  [/\b(mach|machinery)\b/g, 'mach'],
  [/\b(natl|national)\b/g, 'natl'],
  [/\b(sec|securities|security)\b/g, 'sec'],
  [/\b(fed|federal)\b/g, 'fed'],
  [/\b(gov|government)\b/g, 'gov'],
];

// Round 7 — per spec, drop "et" and "al" so "Conley v. Gibson, et al."
// matches "Conley v. Gibson" cleanly.
const STOPWORDS = new Set([
  'the', 'of', 'a', 'an', 'and', '&', 'in', 'for', 'on', 'to',
  'et', 'al',
]);

export function normalizeCaseName(name) {
  if (!name) return '';
  let s = String(name).toLowerCase();
  // Versus marker — collapse to "v"
  s = s.replace(/\b(vs?\.?|versus)\b/g, 'v');
  // Strip apostrophes inside abbreviations (Ass'n → Assn) BEFORE punctuation strip
  s = s.replace(/(\w)'(\w)/g, '$1$2');
  // Strip leading articles ("In re X" → "X" for fairer matching)
  s = s.replace(/^\s*in\s+re\s+/, '');
  s = s.replace(/^\s*ex\s+(?:parte|rel\.?)\s+/, '');
  // Strip punctuation
  s = s.replace(/[.,;:'"`]/g, ' ');
  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  // Apply entity expansions to canonical short forms
  for (const [re, replacement] of ENTITY_EXPANSIONS) {
    s = s.replace(re, replacement);
  }
  return s;
}

/**
 * Token-overlap match between two case names. Returns 0–1.
 *
 * Algorithm (per Round-7 spec):
 *   1. Normalize both names (entity expansion, punctuation strip, etc.)
 *   2. Tokenize on whitespace into Sets.
 *   3. Strip stopwords + single-letter tokens (middle initials, "v").
 *   4. Compute |intersection| / |smaller set|.
 *
 * Denominator change: was `max` (longer-party threshold), now `min`
 * (smaller-party fully contained). The smaller-set denominator is more
 * permissive and handles "Conley v. Gibson" vs "Conley v. Gibson, et
 * al." correctly: the smaller set is fully contained in the larger,
 * so overlap = 1.0 even when the larger has extra "et", "al" tokens.
 *
 * Threshold (Round 8): 0.50 (was 0.60). Below → NAME_MISMATCH.
 */
export function caseNameOverlap(citedName, courtListenerName) {
  if (!citedName || !courtListenerName) return 0;
  const a = normalizeCaseName(citedName);
  const b = normalizeCaseName(courtListenerName);
  if (!a || !b) return 0;

  const tokenize = (s) => new Set(
    s.split(' ').filter((t) => t.length > 1 && !STOPWORDS.has(t))
  );
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  const intersection = new Set([...tokensA].filter((t) => tokensB.has(t)));
  const smallerSize = Math.min(tokensA.size, tokensB.size);
  return intersection.size / smallerSize;
}

/**
 * Convenience boolean — does the cited case name match the
 * CourtListener case name within tolerance?
 *
 * Default threshold 0.50 (Round 8 — dropped from 0.60 because real-
 * world CL responses sometimes carry trailing posture text or
 * abbreviation differences that drove the overlap below 0.60 even on
 * obvious matches like Halliburton). At 0.50, the smaller-set
 * denominator means any 2-of-4-token party-name overlap counts as
 * a match, which is the right floor for "this is plausibly the same
 * case." Wrong matches at 0.50 are filtered by the cite-equality
 * gate that runs first (volume/reporter/page must match exactly).
 */
export function caseNameMatches(citedName, courtListenerName, threshold = 0.50) {
  return caseNameOverlap(citedName, courtListenerName) >= threshold;
}

function reporterMatches(haystack, reporter) {
  // Strip spaces inside the reporter for comparison: "F. 3d" === "F.3d".
  const a = haystack.replace(/\s+/g, '').toLowerCase();
  const b = String(reporter).replace(/\s+/g, '').toLowerCase();
  return a.includes(b);
}

/**
 * Round 6.10 — CourtListener 4-state classification per the user's spec:
 *
 *   VERIFIED            — exact volume/reporter/page hit, name matches.
 *                         Silent. No flag. (No comment in output.)
 *   NAME_MISMATCH       — exact cite hit, but the case name doesn't match
 *                         the cited name. Highest-value finding —
 *                         indicates the wrong case may be cited.
 *   LOCATION_MISMATCH   — case name returns hits, but not at the cited
 *                         volume/page. The case exists, the cite is wrong.
 *   UNRESOLVED          — no match returned. Suppress if Pass 3 already
 *                         flagged a format error on the same citation
 *                         (the format error itself may be the reason
 *                         CL couldn't resolve). Otherwise emit once.
 *   API_ERROR/RATE_LIMIT — never surfaced to the user.
 *
 * @param {object} result   — output of CourtListenerClient.checkExistence()
 * @param {object} [opts]
 * @param {boolean} [opts.hasFormatError] — true if Pass 3 already flagged
 *                                          a format error on this citation.
 *                                          When true, UNRESOLVED is
 *                                          suppressed (silent).
 */
export function existenceResultToFlag(result, opts = {}) {
  if (!result) return null;
  const hasFormatError = !!opts.hasFormatError;

  // VERIFIED + NOT_APPLICABLE: silent.
  if (result.status === 'existence_verified' || result.status === 'not_applicable') {
    return null;
  }

  // NAME_MISMATCH: cite resolved but to a different case.
  if (result.status === 'existence_name_mismatch') {
    return {
      severity: 'review',
      category: 'existence',
      rule_cite: 'BB R. 10',
      table_cite: null,
      message:
        `CourtListener returns ${result.cited_text || 'this citation'} as ` +
        `"${result.actual_case_name || 'a different case'}"` +
        (result.actual_year ? ` (${result.actual_year})` : '') + '. ' +
        'The cited case name does not match. Verify the citation.' +
        (result.url ? ` See: ${result.url}` : ''),
      suggested_fix: null,
    };
  }

  // LOCATION_MISMATCH: case name matches but at a different cite.
  if (result.status === 'existence_location_mismatch') {
    return {
      severity: 'review',
      category: 'existence',
      rule_cite: 'BB R. 10',
      table_cite: null,
      message:
        `CourtListener returns this case at ${result.actual_citation || 'a different citation'}, ` +
        `not the cited ${result.cited_text || 'location'}. Verify the volume and page.` +
        (result.url ? ` See: ${result.url}` : ''),
      suggested_fix: null,
    };
  }

  // UNRESOLVED — existence_not_found OR existence_uncertain.
  // Per spec: SUPPRESS if Pass 3 already flagged a format error on the
  // same citation. The format error itself may be why CL couldn't
  // resolve, and a "could not be located" comment on top of a "missing
  // period after v" comment is just noise.
  if (
    result.status === 'existence_not_found' ||
    result.status === 'existence_uncertain'
  ) {
    if (hasFormatError) return null;
    return {
      severity: 'review',
      category: 'existence',
      rule_cite: 'BB R. 10',
      table_cite: null,
      message:
        'Not found in CourtListener. Note: CourtListener does not include ' +
        'every state opinion, recent or unreported decision, foreign case, ' +
        'or sealed matter. Inability to locate is not evidence of ' +
        'nonexistence; verify against the case file or Westlaw/Lexis.',
      suggested_fix: null,
    };
  }

  return null;
}
