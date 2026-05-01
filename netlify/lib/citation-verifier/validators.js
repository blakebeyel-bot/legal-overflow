/**
 * Citation Verifier — Pass 3 table validators.
 *
 * Per BUILD_SPEC §10: pure code, no LLM. Each validator takes the
 * already-classified citation (output of Pass 2) and returns zero or
 * more Flag objects matching the `flags` table schema in the migration.
 *
 * Flag shape (matches DB):
 *   {
 *     severity:      'conforming' | 'review' | 'non_conforming',
 *     category:      string,                    // see migration §10.3 list
 *     rule_cite:     string|null,               // e.g. 'BB R. 10.2.2'
 *     table_cite:    string|null,               // e.g. 'T6'
 *     message:       string,                    // human-readable
 *     suggested_fix: string|null,               // ready-to-paste replacement
 *   }
 *
 * Banned-phrase rule (BUILD_SPEC §16): NEVER write 'fake', 'fictitious',
 * 'hallucinated', 'incorrect', 'wrong', or 'this case does not exist' in
 * any message string. Strongest permitted language for an existence-check
 * miss is 'could not be located in CourtListener — please verify before
 * filing'. The ban applies here too — pre-commit grep checks this dir.
 */

import { T1, T6, T7, T10, T13, reporterCurrency } from './tables/index.js';
import { applyStaticFixes } from './compose-fixes.js';
import { sha256Hex } from './extract.js';

// ---------------------------------------------------------------------------
// 1. validateCaseAbbreviations
//
//    Per BB R. 10.2.2 / T6 — case-name words MUST be abbreviated when they
//    appear inside a citation's case name (and MUST NOT be abbreviated as
//    the FIRST word of a party's name, per R. 10.2.1(c)).
//
//    Input is the raw case-name string the classifier extracted, e.g.
//    "Brown v. Board of Education".
// ---------------------------------------------------------------------------
export function validateCaseAbbreviations(caseName, fullCandidateText = null) {
  if (!caseName || typeof caseName !== 'string') return [];

  // Sanity guard — accept either a versus-style case name OR an
  // "In re X" / "Ex parte X" / "Matter of X" form. Reject anything else
  // (catches upstream classification mistakes where the case_name is
  // a sentence prefix like "Second, this Court has personal jurisdiction
  // over Defendant. See World-Wide Volkswagen Corp.").
  const isVersus = /\s+(?:v\.|v\b|vs\.|vs\b)\s+/.test(caseName);
  const isInRe = /^(?:In re|Ex parte|In the Matter of|Matter of|Petition of|Application of|Estate of)\b/.test(caseName);
  if (!isVersus && !isInRe) return [];

  const flags = [];
  const t6 = T6();
  const abbreviations = t6.abbreviations || {};

  // Split case name into "parties" so we can skip the FIRST WORD of each
  // (per R. 10.2.1(c)). For " v. " cases, parties are plaintiff and
  // defendant. For "In re X" cases, the entire case name is one party
  // and the leading "In re " (or "Ex parte ", etc.) prefix is stripped
  // because its words are not subject to T6 abbreviation.
  let parties;
  if (isVersus) {
    parties = caseName.split(/\s+v\.\s+/);
  } else {
    // Strip the "In re " / "Ex parte " / etc. prefix; treat what remains
    // as one party. The prefix words ("In", "re", "Ex", "parte", etc.)
    // are bookkeeping, not case-name words.
    const stripped = caseName.replace(/^(?:In re|Ex parte|In the Matter of|Matter of|Petition of|Application of|Estate of)\s+/, '');
    parties = [stripped];
  }

  parties.forEach((party, partyIndex) => {
    const words = party.trim().split(/\s+/);
    words.forEach((word, wordIndex) => {
      // Strip trailing punctuation for lookup, but remember it.
      const trailingPunct = word.match(/[.,;]+$/)?.[0] || '';
      const bareWord = trailingPunct ? word.slice(0, -trailingPunct.length) : word;

      // R. 10.2.1(c) — skip the first word of each party,
      // EXCEPT a small set of entity-prefix words that are universally
      // abbreviated even when they begin a party's name (Department,
      // Bureau, Office, Commission, Authority, Government, Administration,
      // Federation). For these, the Bluebook treats the abbreviation as
      // the canonical form regardless of position.
      //
      // Round 24 — added this carve-out after the user reported that
      // "Department of Homeland Security" was producing only the
      // Security→Sec. flag, not Department→Dep't. The first-word skip
      // is correct for words like "International" (International Shoe)
      // or "Bell" (Bell Atlantic) but wrong for entity-prefix words.
      const ALWAYS_ABBREV_FIRST_WORD = new Set([
        'Department', 'Departments', 'Bureau', 'Bureaus',
        'Commission', 'Commissions', 'Authority', 'Authorities',
        'Government', 'Governments', 'Administration', 'Administrations',
        'Federation', 'Federations', 'Office', 'Offices',
      ]);
      if (wordIndex === 0 && !ALWAYS_ABBREV_FIRST_WORD.has(bareWord)) return;

      // Direct lookup
      const expected = lookupT6(bareWord, abbreviations);
      if (!expected) return; // word not in T6

      // Already abbreviated correctly?
      if (bareWord === expected) return;

      // Word is the unabbreviated long form → emit at REVIEW severity.
      // Per the round-6 spec: T6 word abbreviations are "matters of strict
      // reading vs. accepted practice" — strictly required by Bluebook
      // R. 10.2.2 / T6, but many federal briefs spell out words like
      // "International" or "Industries" without consequence. Frame as
      // advisory so attorneys decide; reserve hard-error language for
      // unambiguous violations (missing v. period, vs. usage, etc.).
      const haystack = fullCandidateText || caseName;
      const suggested_fix = haystack.replace(new RegExp(`\\b${bareWord}\\b`), expected);
      flags.push({
        severity: 'review',
        category: 'abbreviations',
        rule_cite: 'BB R. 10.2.2',
        table_cite: 'T6',
        message: `T6 lists "${bareWord}" → "${expected}" as a required case-name abbreviation under R. 10.2.2. Strictly required by the Bluebook; many federal practitioners spell it out. Verify against the practice norms of your court.`,
        suggested_fix,
      });
    });
  });

  return flags;
}

/**
 * Look up a word in T6, with simple plural handling. Returns the
 * canonical abbreviation or null if not in the table.
 */
function lookupT6(word, abbreviations) {
  if (abbreviations[word]) return abbreviations[word];

  // Trailing 's' — e.g. "Brothers" → "Bros." is in T6 directly, but
  // "Companies" → "Cos." derives from "Company" → "Co.". If the singular
  // is in the table and the plural isn't, return abbrev + 's'.
  if (word.endsWith('s')) {
    const singular = word.slice(0, -1);
    if (abbreviations[singular]) {
      return abbreviations[singular].replace(/\.$/, 's.');
    }
  }
  return null;
}

function replaceWordInCaseName(caseName, oldWord, newWord) {
  return caseName.replace(new RegExp(`\\b${oldWord}\\b`), newWord);
}

// ---------------------------------------------------------------------------
// 2. validateReporterCurrency
//
//    Per BB R. 10.3 — make sure the year is inside the reporter's coverage
//    range. Catches errors like "100 F.3d 200 (2022)" (F.3d ended in 2021).
// ---------------------------------------------------------------------------
// Reporters for which year-range currency checks DO NOT apply:
//   • English Reports (Eng. Rep., Ex., Ch., K.B., Q.B., etc.) — see R. 21
//   • Westlaw / LEXIS unreported databases — R. 10.8.1
//   • Anything we recognize but don't have currency data for; flagging
//     them as "unknown reporter" was producing noise on every old
//     English case and every unreported Westlaw cite.
const SKIP_CURRENCY_CHECK = new Set([
  'Ex.', 'Eng. Rep.', 'Ch.', 'K.B.', 'Q.B.', 'A.C.', 'WLR',
  'WL', 'LEXIS', 'U.S. App. LEXIS',
]);

export function validateReporterCurrency(reporter, year) {
  if (!reporter || !year) return [];
  if (SKIP_CURRENCY_CHECK.has(reporter)) return [];
  const yearNum = typeof year === 'number' ? year : parseInt(year, 10);
  if (!Number.isFinite(yearNum)) return [];

  const rc = reporterCurrency();
  const entry = rc.reporters?.[reporter];
  if (!entry) {
    // Unknown reporter — silent. Flagging "please verify" on every
    // reporter we don't recognize creates noise on legitimate cites
    // (English Exchequer, foreign reporters, niche state reporters
    // not yet in our table). Pass 4 + the attorney's own review
    // catch genuinely malformed reporters.
    return [];
  }

  const { start, end } = entry;
  if (yearNum < start) {
    return [{
      severity: 'non_conforming',
      category: 'reporter',
      rule_cite: 'BB R. 10.3',
      table_cite: 'T1',
      message: `Reporter "${reporter}" began in ${start}; the cited year ${yearNum} predates the reporter.`,
      suggested_fix: null,
    }];
  }
  if (end !== null && yearNum > end) {
    return [{
      severity: 'non_conforming',
      category: 'reporter',
      rule_cite: 'BB R. 10.3',
      table_cite: 'T1',
      message: `Reporter "${reporter}" ended in ${end}; the cited year ${yearNum} is outside its range.`,
      suggested_fix: null,
    }];
  }
  return [];
}

// ---------------------------------------------------------------------------
// 3. validateCourtParenthetical
//
//    Per BB R. 10.4 — the parenthetical at the end of a citation must
//    identify the deciding court when the reporter alone doesn't. The
//    common errors are "2nd Cir." (should be "2d Cir."), missing
//    parenthetical entirely, or wrong jurisdictional designator.
// ---------------------------------------------------------------------------
export function validateCourtParenthetical(reporter, parenthetical) {
  const flags = [];
  const t7 = T7();

  // U.S. Supreme Court reporter — no court parenthetical required.
  if (reporter === 'U.S.' || reporter === 'S. Ct.' || reporter === 'L. Ed.' || reporter === 'L. Ed. 2d' || reporter === 'T.C.') {
    if (parenthetical && /\b(?:Cir\.|D\.[A-Z]\.|U\.S\.)/.test(parenthetical)) {
      flags.push({
        severity: 'review',
        category: 'form_components',
        rule_cite: 'BB R. 10.4',
        table_cite: 'T1',
        message: `Reporter "${reporter}" implies the court; an explicit court designator in the parenthetical may be redundant.`,
        suggested_fix: null,
      });
    }
    return flags;
  }

  // F./F.2d/F.3d/F.4th require a circuit court designator.
  const requiresCircuit = ['F.', 'F.2d', 'F.3d', 'F.4th'];
  if (requiresCircuit.includes(reporter)) {
    if (!parenthetical) {
      flags.push({
        severity: 'non_conforming',
        category: 'form_components',
        rule_cite: 'BB R. 10.4',
        table_cite: 'T7',
        message: `Reporter "${reporter}" requires a court parenthetical (e.g. "(2d Cir. 2019)"). None found.`,
        suggested_fix: null,
      });
      return flags;
    }
    // Check for common misuses (T7).
    const misuses = t7.common_misuses || {};
    for (const [bad, good] of Object.entries(misuses)) {
      if (parenthetical.includes(bad)) {
        flags.push({
          severity: 'non_conforming',
          category: 'form_components',
          rule_cite: 'BB R. 10.4',
          table_cite: 'T7',
          message: `Court abbreviation "${bad}" is non-standard; use "${good}" per T7.`,
          suggested_fix: parenthetical.replace(bad, good),
        });
      }
    }
    return flags;
  }

  // F. Supp. / F. Supp. 2d/3d / F.R.D. — district court designator required.
  const requiresDistrict = ['F. Supp.', 'F. Supp. 2d', 'F. Supp. 3d', 'F.R.D.', 'B.R.'];
  if (requiresDistrict.includes(reporter)) {
    if (!parenthetical) {
      flags.push({
        severity: 'non_conforming',
        category: 'form_components',
        rule_cite: 'BB R. 10.4',
        table_cite: 'T7',
        message: `Reporter "${reporter}" requires a district-court parenthetical (e.g. "(S.D.N.Y. 2015)"). None found.`,
        suggested_fix: null,
      });
    }
    return flags;
  }

  return flags;
}

// ---------------------------------------------------------------------------
// 4. validateGeographicalAbbreviations
//
//    Per BB R. 10.2.2 / T10 — state names in case names and statute cites
//    must use the canonical T10 abbreviation. Catches "Calif." → "Cal.",
//    "Penn." → "Pa.", postal-code-only abbreviations, etc.
// ---------------------------------------------------------------------------
export function validateGeographicalAbbreviations(text) {
  if (!text || typeof text !== 'string') return [];
  const flags = [];
  const t10 = T10();
  const misuses = t10.common_misuses || {};

  for (const [bad, good] of Object.entries(misuses)) {
    // Word-boundary match so "Calif." doesn't false-match inside "California".
    //
    // Round 21 — also exclude `.` from the negative lookahead. Without this,
    // T10 entries like "Tenn" → "Tenn." fire on text that ALREADY has the
    // period, e.g., "(Tenn. 1992)" — match consumes "Tenn", lookahead sees
    // "." (not in [A-Za-z]) → succeeds → flag fires → suggested fix
    // produces "(Tenn.. 1992)" (double period). The fix is to widen the
    // lookahead to reject period as well, so "Tenn." doesn't match.
    const re = new RegExp(`\\b${escapeRegex(bad)}(?![A-Za-z.])`, 'g');
    if (re.test(text)) {
      flags.push({
        severity: 'non_conforming',
        category: 'abbreviations',
        rule_cite: 'BB R. 10.2.2',
        table_cite: 'T10',
        message: `Geographical abbreviation "${bad}" is non-standard; use "${good}" per T10.`,
        suggested_fix: text.replace(re, good),
      });
    }
  }
  return flags;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// 5. validatePeriodicalAbbreviation
//
//    Per BB R. 16 / T13 — periodicals must use the canonical T13
//    abbreviation. Validator returns review-level flags if the periodical
//    name doesn't appear in T13 at all (we can't verify), and
//    non_conforming if a known journal is written out in full when its
//    canonical abbreviation is shorter.
// ---------------------------------------------------------------------------
export function validatePeriodicalAbbreviation(periodical) {
  if (!periodical || typeof periodical !== 'string') return [];
  const flags = [];
  const t13 = T13();
  const periodicals = t13.periodicals || {};

  // Direct match — is the long form being used when an abbreviation exists?
  if (periodicals[periodical]) {
    flags.push({
      severity: 'non_conforming',
      category: 'abbreviations',
      rule_cite: 'BB R. 16',
      table_cite: 'T13',
      message: `Periodical "${periodical}" must be abbreviated as "${periodicals[periodical]}" per T13.`,
      suggested_fix: periodicals[periodical],
    });
    return flags;
  }

  // Already-abbreviated form? Check membership in the values set.
  const knownAbbrevs = new Set(Object.values(periodicals));
  if (knownAbbrevs.has(periodical)) {
    return flags; // canonical abbrev — pass.
  }

  // Unknown periodical — defer to human review.
  flags.push({
    severity: 'review',
    category: 'abbreviations',
    rule_cite: 'BB R. 16',
    table_cite: 'T13',
    message: `Periodical "${periodical}" is not in the reference table. Please verify the abbreviation against Bluebook T13.`,
    suggested_fix: null,
  });
  return flags;
}

// ---------------------------------------------------------------------------
// 6. validateCitationForm — text-level form errors that aren't tied to
//    the parsed components. Runs against the verbatim candidate_text.
//
//    Catches:
//      • "v Iqbal"  → missing period after v (R. 10.2.1)
//      • "vs."      → wrong abbrev (R. 10.2.1 / T6 — should be "v.")
//      • "US"       → missing periods in U.S. (R. 6.1)
//      • "USC"      → missing periods in U.S.C. (R. 6.1)
//      • "FRCP"     → improper short form (R. 12.9.3)
//      • "§ X" w/o space → R. 6.2 — section symbol followed by space
//      • "So.3d" / "So.2d" without space (R. 10.3.1 / T1)
//      • "Fla. 4th DCA, 2021" — stray comma before year in court paren
//      • "Fl." in court parenthetical → "Fla." (T10)
// ---------------------------------------------------------------------------
export function validateCitationForm(candidateText) {
  if (!candidateText || typeof candidateText !== 'string') return [];
  const flags = [];

  // ---- Missing period after "v" between two capitalized parties ----
  // Match: <Cap-word>... v <Cap-word>  but NOT v. (look-ahead negates).
  // We also accept "vs." / "vs" as separate flags below.
  const vNoPeriod = /\b[A-Z][A-Za-z\-'\.]+\s+v(?!\.|s\.|s\b)\s+[A-Z]/;
  if (vNoPeriod.test(candidateText)) {
    flags.push({
      severity: 'non_conforming',
      category: 'form_components',
      rule_cite: 'BB R. 10.2.1',
      table_cite: null,
      message: 'Case-name "v" must be followed by a period: "v.".',
      suggested_fix: candidateText.replace(/\b(v)(\s+[A-Z])/, 'v.$2'),
    });
  }

  // ---- "vs." or "vs" instead of "v." ----
  if (/\bvs\.?\s+[A-Z]/.test(candidateText)) {
    flags.push({
      severity: 'non_conforming',
      category: 'form_components',
      rule_cite: 'BB R. 10.2.1',
      table_cite: null,
      message: 'Use "v." (not "vs." / "vs") between party names.',
      suggested_fix: candidateText.replace(/\bvs\.?(\s+[A-Z])/, 'v.$1'),
    });
  }

  // ---- "US" or "U.S" missing one or both periods (used as a reporter) ----
  // Round 6.4 fix: previously only caught "US" with both periods missing.
  // The Helicopteros / 466 U.S 408 case has only the trailing period
  // missing — caught here too. Detection is unified: match any pattern
  // with insufficient periods, suggest the canonical "U.S.".
  const usReporterMissingPeriod = /\b\d{1,4}\s+U\.S\s+\d|\b\d{1,4}\s+US\s+\d/.test(candidateText);
  const usReporterCanonical = /\b\d{1,4}\s+U\.S\.\s+\d/.test(candidateText);
  if (usReporterMissingPeriod && !usReporterCanonical) {
    flags.push({
      severity: 'non_conforming',
      category: 'abbreviations',
      rule_cite: 'BB R. 6.1',
      table_cite: 'T1.1',
      message: 'Reporter "U.S." requires periods after both letters per R. 6.1.',
      suggested_fix: candidateText
        .replace(/\b(\d{1,4}\s+)U\.S(\s+\d)/, '$1U.S.$2')   // single period missing
        .replace(/\b(\d{1,4}\s+)US(\s+\d)/, '$1U.S.$2'),     // both periods missing
    });
  }

  // ---- "USC" without periods (in a statute citation) ----
  // Compose two fixes: add the periods AND insert the missing "§" if
  // the section number follows directly without it. Bluebook R. 6.2
  // requires the section symbol; users who drop "USC" periods often
  // also drop the symbol entirely.
  if (/\b\d{1,3}\s+USC\b/.test(candidateText)) {
    let fix = candidateText.replace(/\b(\d{1,3}\s+)USC\s+(\d)/, '$1U.S.C. § $2'); // insert §
    if (fix === candidateText) fix = candidateText.replace(/\b(\d{1,3}\s+)USC\b/, '$1U.S.C.'); // fallback
    flags.push({
      severity: 'non_conforming',
      category: 'abbreviations',
      rule_cite: 'BB R. 6.1',
      table_cite: 'T1.1',
      message: 'Code abbreviation "USC" must be cited as "U.S.C." with periods per R. 6.1; section symbol "§" inserted if absent (R. 6.2).',
      suggested_fix: fix,
    });
  }

  // Also catch the canonical-but-§-less case: "28 U.S.C. 1331" without
  // section symbol. Separate flag so the user sees the missing symbol
  // even when the periods were correct.
  if (/\b\d{1,3}\s+U\.S\.C\.\s+\d/.test(candidateText) && !/U\.S\.C\.\s*§/.test(candidateText)) {
    flags.push({
      severity: 'non_conforming',
      category: 'form_components',
      rule_cite: 'BB R. 6.2',
      table_cite: null,
      message: 'Statute citation requires the section symbol "§" between the code abbreviation and the section number (R. 6.2).',
      suggested_fix: candidateText.replace(/(\bU\.S\.C\.)\s+(\d)/, '$1 § $2'),
    });
  }

  // ---- "CFR" without periods ----
  if (/\b\d{1,3}\s+CFR\b/.test(candidateText)) {
    let fix = candidateText.replace(/\b(\d{1,3}\s+)CFR\s+(\d)/, '$1C.F.R. § $2');
    if (fix === candidateText) fix = candidateText.replace(/\b(\d{1,3}\s+)CFR\b/, '$1C.F.R.');
    flags.push({
      severity: 'non_conforming',
      category: 'abbreviations',
      rule_cite: 'BB R. 6.1',
      table_cite: null,
      message: 'Code abbreviation "CFR" must be cited as "C.F.R." with periods per R. 6.1; section symbol "§" inserted if absent (R. 6.2).',
      suggested_fix: fix,
    });
  }

  // ---- Federal Rules: FRCP / FRE / FRAP / FRCrP shortform ----
  // R. 12.9.3 — Federal Rules must be cited in full form.
  const FED_RULE_SHORTHANDS = {
    'FRCP': 'Fed. R. Civ. P.',
    'FRCrP': 'Fed. R. Crim. P.',
    'FRAP': 'Fed. R. App. P.',
    'FRE': 'Fed. R. Evid.',
    'F.R.C.P.': 'Fed. R. Civ. P.',
    'F.R.Cr.P.': 'Fed. R. Crim. P.',
  };
  for (const [bad, good] of Object.entries(FED_RULE_SHORTHANDS)) {
    const re = new RegExp(`\\b${escapeRegex(bad)}\\b`);
    if (re.test(candidateText)) {
      flags.push({
        severity: 'non_conforming',
        category: 'form_components',
        rule_cite: 'BB R. 12.9.3',
        table_cite: null,
        message: `"${bad}" is not a Bluebook-recognized abbreviation. Federal Rules must be cited as "${good}".`,
        suggested_fix: candidateText.replace(re, good),
      });
    }
  }

  // ---- Federal Rules without periods (Round 6.3): "Fed R Civ P 8(a)(2)" ----
  // R. 12.9.3 — periods are part of the canonical form. Detect and
  // flag any cite that omits one or more periods in "Fed. R. <Type>. P."
  const fedRuleNoPeriodsRe = /\bFed\s+R\s+(Civ|Crim|App|Evid)\s+P\b|\bFed\.?\s*R\.?\s*(Civ|Crim|App|Evid)\.?\s*P\.?\s*\d/;
  const fedRuleCanonicalRe = /\bFed\. R\. (Civ|Crim|App|Evid)\. P\./;
  if (fedRuleNoPeriodsRe.test(candidateText) && !fedRuleCanonicalRe.test(candidateText)) {
    const typeMatch = candidateText.match(/\bFed\.?\s*R\.?\s*(Civ|Crim|App|Evid)\.?\s*P\.?/);
    const ruleType = typeMatch ? typeMatch[1] : 'Civ';
    flags.push({
      severity: 'non_conforming',
      category: 'form_components',
      rule_cite: 'BB R. 12.9.3',
      table_cite: null,
      message: `Federal Rules of ${ruleType === 'Civ' ? 'Civil' : ruleType === 'Crim' ? 'Criminal' : ruleType === 'App' ? 'Appellate' : 'Evidence'} Procedure must be cited with periods after each letter: "Fed. R. ${ruleType}. P." (R. 12.9.3).`,
      suggested_fix: candidateText.replace(
        /\bFed\.?\s*R\.?\s*(Civ|Crim|App|Evid)\.?\s*P\.?(\s)/,
        'Fed. R. $1. P.$2'
      ),
    });
  }

  // ---- Section symbol with no space: §351 → § 351 (R. 6.2) ----
  if (/§\d/.test(candidateText)) {
    flags.push({
      severity: 'non_conforming',
      category: 'form_components',
      rule_cite: 'BB R. 6.2',
      table_cite: null,
      message: 'Section symbol "§" must be followed by a space before the section number.',
      suggested_fix: candidateText.replace(/§(\d)/g, '§ $1'),
    });
  }

  // ---- Reporter spacing: "So.3d" / "So.2d" → "So. 3d" / "So. 2d" ----
  // Bluebook spaces single-letter abbreviations from the series ordinal.
  const reporterSpacingFixes = [
    { bad: /\bSo\.(\d)d\b/g,  good: 'So. $1d' },
    { bad: /\bF\.(\d)d\b/g,   good: 'F.$1d' }, // F.3d is correct; not flagging
  ];
  if (/\bSo\.\dd\b/.test(candidateText)) {
    flags.push({
      severity: 'non_conforming',
      category: 'reporter',
      rule_cite: 'BB R. 6.1',
      table_cite: 'T1',
      message: 'Reporter "So." must be separated from series ordinal by a space (e.g., "So. 3d", not "So.3d").',
      suggested_fix: candidateText.replace(/\bSo\.(\d)d\b/g, 'So. $1d'),
    });
  }

  // ---- Stray comma before year in court parenthetical ----
  // Bluebook form: "(Fla. 4th DCA 2021)" — NO comma. Brief had "DCA, 2021".
  //
  // Round 16 — require the captured pre-comma token to look like a COURT
  // designator, not a date. Court designators contain "Cir.", "Ct.",
  // "App.", "DCA", "D.", "S.D.", "N.D." or a state abbreviation. Without
  // this guard, internet citations like "(Mar. 14, 2024)" trip the regex
  // (Mar.+digit+", year") and fire a spurious R. 10.5 flag on news cites.
  //
  // Round 27 — slip-opinion / unreported-decision date guard. Per R. 10.8.1
  // the canonical form is "(Court Mon. Day, Year)" — e.g.,
  // "(D.C. Cir. Mar. 4, 2024)". The comma between Day and Year is the
  // standard date-format comma and MUST NOT be flagged as stray. The
  // earlier `isMonthDate` check required the WHOLE pre-comma token to be a
  // month-day fragment, but for slip opinions the token is a court+date
  // composite ("D.C. Cir. Mar. 4"). We now check whether the token ENDS
  // with "<Mon.> <Day>" — if it does, the comma is date-internal and the
  // validator silently skips this citation.
  const cpMatch = candidateText.match(/\(([A-Z][A-Za-z.\s\d]+),\s*(\d{4})\)/);
  if (cpMatch) {
    const courtToken = cpMatch[1];
    const looksLikeCourt =
      /\b(?:Cir\.|Ct\.|App\.|DCA|App'x|Tex\.|N\.D\.|S\.D\.|E\.D\.|W\.D\.|D\.|Bankr\.|Fla\.|Cal\.|N\.Y\.|Tex\.|Mass\.|Mich\.|Ill\.|Pa\.|Va\.|Ohio|Ga\.|N\.C\.|N\.J\.|Conn\.|Md\.|Wash\.|Or\.|Colo\.|Ariz\.|Ind\.|Tenn\.|Mo\.|Wis\.|Minn\.|U\.S\.)\b/.test(courtToken);
    // Round 27 — accept whole-token month-day OR token ENDING in month-day.
    // "Mar. 4" → date-only (news cite). "D.C. Cir. Mar. 4" → court + date
    // composite (slip opinion). Both must skip the stray-comma flag.
    const MONTH_DAY_TAIL_RE = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\.?\s+\d{1,2}$/;
    const endsWithMonthDay = MONTH_DAY_TAIL_RE.test(courtToken);
    if (looksLikeCourt && !endsWithMonthDay) {
      flags.push({
        severity: 'non_conforming',
        category: 'form_components',
        rule_cite: 'BB R. 10.5',
        table_cite: 'T7',
        message: 'No comma before the year in the court parenthetical (e.g., "(Fla. 4th DCA 2021)" not "(Fla. 4th DCA, 2021)").',
        suggested_fix: candidateText.replace(/\(([A-Z][A-Za-z.\s\d]+),\s*(\d{4})\)/, '($1 $2)'),
      });
    }
  }

  // ---- Round 13 — Rule R. 10.7 / T8: subsequent-history phrases need
  //      periods. Most common error: "cert denied" without period after
  //      "cert". The Bluebook canonical forms are "cert. denied",
  //      "cert. granted", "aff'd", "rev'd", "vacated", "remanded".
  // ---------------------------------------------------------------------
  // Match "cert " followed by denied/granted/dismissed without a period
  // before the space. The negative lookahead `(?!\.)` ensures "cert."
  // (correct) doesn't trigger.
  const certMatch = candidateText.match(/\bcert(?!\.)\s+(denied|granted|dismissed)\b/i);
  if (certMatch) {
    flags.push({
      severity: 'non_conforming',
      category: 'history',
      rule_cite: 'BB R. 10.7',
      table_cite: 'T8',
      message: `Subsequent-history phrase "cert ${certMatch[1]}" must be cited with a period after "cert": "cert. ${certMatch[1]}" (R. 10.7 / T8).`,
      suggested_fix: candidateText.replace(/\bcert(?!\.)\s+(denied|granted|dismissed)\b/gi, 'cert. $1'),
    });
  }

  // ---- Round 13 — Rule R. 3.2(a): pin-cite ranges use an en dash, not
  //      a hyphen. "322-23" → "322–23". Common in pin-cite spans after
  //      the first page: "<vol> <reporter> <first_page>, <pin1>-<pin2>".
  //      Be careful NOT to flag hyphens inside section numbers (e.g.,
  //      "240.10b-5") or year ranges in parentheticals.
  // ---------------------------------------------------------------------
  // Round 23 — extended to also catch:
  //   • em dashes (U+2014) — Word auto-correct produces "—" from "--";
  //     Bluebook requires en dash (U+2013).
  //   • "id. at N-M" / "id. at N—M" short-form pin ranges
  //   • paragraph-range citations "¶¶ N-M" / "¶¶ N—M"
  //
  // Three patterns. Each captures a hyphen-or-em-dash range and emits a
  // single flag with a complete suggested-fix substitution.

  // Pattern 1: page-pin range "<page>, <pin1>[-—]<pin2>"
  const pinRangeMatch = candidateText.match(/,\s*(\d{1,5})([-—])(\d{1,5})\b/);
  if (pinRangeMatch) {
    const a = parseInt(pinRangeMatch[1], 10);
    const b = parseInt(pinRangeMatch[3], 10);
    const isYearRange =
      pinRangeMatch[1].length === 4 && pinRangeMatch[3].length === 4 &&
      a >= 1700 && a <= 2200 && b >= 1700 && b <= 2200;
    if (!isYearRange) {
      const dashChar = pinRangeMatch[2];
      const dashName = dashChar === '—' ? 'em dash (—)' : 'hyphen';
      flags.push({
        severity: 'non_conforming',
        category: 'form_components',
        rule_cite: 'BB R. 3.2(a)',
        table_cite: null,
        message: `Pin-cite range "${pinRangeMatch[1]}${dashChar}${pinRangeMatch[3]}" uses ${dashName}; R. 3.2(a) requires an en dash (–): "${pinRangeMatch[1]}–${pinRangeMatch[3]}".`,
        suggested_fix: candidateText.replace(/,(\s*)(\d{1,5})([-—])(\d{1,5})\b/, ',$1$2–$4'),
      });
    }
  }

  // Pattern 2: id. short-form pin range "id. at N-M" or "Id. at N—M"
  const idPinMatch = candidateText.match(/\b(?:id\.|Id\.)\s+at\s+(\d{1,5})([-—])(\d{1,5})\b/);
  if (idPinMatch) {
    const dashChar = idPinMatch[2];
    const dashName = dashChar === '—' ? 'em dash (—)' : 'hyphen';
    flags.push({
      severity: 'non_conforming',
      category: 'form_components',
      rule_cite: 'BB R. 3.2(a)',
      table_cite: null,
      message: `Id. short-form pin range "${idPinMatch[1]}${dashChar}${idPinMatch[3]}" uses ${dashName}; R. 3.2(a) requires an en dash (–): "${idPinMatch[1]}–${idPinMatch[3]}".`,
      suggested_fix: candidateText.replace(/\b((?:id|Id)\.\s+at\s+)(\d{1,5})[-—](\d{1,5})\b/, '$1$2–$3'),
    });
  }

  // Pattern 3: paragraph-range record citation "¶¶ N-M" or "¶ N—M"
  const paraRangeMatch = candidateText.match(/¶{1,2}\s*(\d{1,5})([-—])(\d{1,5})\b/);
  if (paraRangeMatch) {
    const dashChar = paraRangeMatch[2];
    const dashName = dashChar === '—' ? 'em dash (—)' : 'hyphen';
    flags.push({
      severity: 'non_conforming',
      category: 'form_components',
      rule_cite: 'BB R. 3.2(a)',
      table_cite: null,
      message: `Paragraph range "${paraRangeMatch[1]}${dashChar}${paraRangeMatch[3]}" uses ${dashName}; R. 3.2(a) requires an en dash (–): "${paraRangeMatch[1]}–${paraRangeMatch[3]}".`,
      suggested_fix: candidateText.replace(/(¶{1,2}\s*)(\d{1,5})[-—](\d{1,5})\b/, '$1$2–$3'),
    });
  }

  // Round 30 — Pattern 4: case short-form pin range "<reporter> at N-M".
  // Per the user's audit table, R. 3.2(a) MUST fire on short-form pin
  // ranges like "Anderson, 477 U.S. at 248-49" — short forms have pin
  // ranges too. Pattern 1 (page-pin "<page>, <pin1>-<pin2>") only matches
  // the full-form layout where the pin range follows a comma. The
  // short-form layout has "at" between the reporter and the pin range
  // and no comma immediately before the range, so Pattern 1 missed it.
  // Negative lookbehind on "Id." avoids double-firing with Pattern 2.
  const shortPinMatch = candidateText.match(/(?<!\b(?:[Ii]d|Id)\.)\s+at\s+(\d{1,5})([-—])(\d{1,5})\b/);
  if (shortPinMatch) {
    const dashChar = shortPinMatch[2];
    const dashName = dashChar === '—' ? 'em dash (—)' : 'hyphen';
    flags.push({
      severity: 'non_conforming',
      category: 'form_components',
      rule_cite: 'BB R. 3.2(a)',
      table_cite: null,
      message: `Short-form pin range "${shortPinMatch[1]}${dashChar}${shortPinMatch[3]}" uses ${dashName}; R. 3.2(a) requires an en dash (–): "${shortPinMatch[1]}–${shortPinMatch[3]}".`,
      suggested_fix: candidateText.replace(/(\s+at\s+)(\d{1,5})[-—](\d{1,5})\b/, '$1$2–$3'),
    });
  }

  return flags;
}

// ---------------------------------------------------------------------------
// 7. validateNominativeReporter — early SCOTUS cases (volumes 1-90 of
//    U.S. Reports) require the nominative reporter parenthetical per
//    R. 10.3.2.   Volume 5 = 1 Cranch, vol. 9 = 5 Cranch, etc.
//
//    We only flag this when the reporter is "U.S." and the volume is
//    in the early range AND the candidate_text doesn't already contain
//    a plausible parenthetical like "(1 Cranch)".
// ---------------------------------------------------------------------------
const NOMINATIVE_REPORTERS_BY_VOLUME = {
  // Volume → nominative form (volumes that need the parenthetical).
  1: '1 Dall.',  2: '2 Dall.',  3: '3 Dall.',  4: '4 Dall.',
  5: '1 Cranch', 6: '2 Cranch', 7: '3 Cranch', 8: '4 Cranch', 9: '5 Cranch',
  10: '6 Cranch', 11: '7 Cranch', 12: '8 Cranch', 13: '9 Cranch',
  14: '1 Wheat.', 15: '2 Wheat.', 16: '3 Wheat.', 17: '4 Wheat.',
  18: '5 Wheat.', 19: '6 Wheat.', 20: '7 Wheat.', 21: '8 Wheat.',
  22: '9 Wheat.', 23: '10 Wheat.', 24: '11 Wheat.', 25: '12 Wheat.',
  26: '1 Pet.', 27: '2 Pet.', 28: '3 Pet.', 29: '4 Pet.', 30: '5 Pet.',
  31: '6 Pet.', 32: '7 Pet.', 33: '8 Pet.', 34: '9 Pet.', 35: '10 Pet.',
  36: '11 Pet.', 37: '12 Pet.', 38: '13 Pet.', 39: '14 Pet.', 40: '15 Pet.',
  41: '16 Pet.', 42: '1 How.', 43: '2 How.', 44: '3 How.',
  // Truncated for brevity — volumes 45-90 follow the same pattern (Black, Wall.).
};

export function validateNominativeReporter(citation) {
  const flags = [];
  if (!citation || citation.citation_type !== 'case') return flags;
  const c = citation.components || {};
  if (c.reporter !== 'U.S.') return flags;
  const volume = parseInt(c.volume, 10);
  if (!Number.isFinite(volume) || volume < 1 || volume > 90) return flags;

  const nominative = NOMINATIVE_REPORTERS_BY_VOLUME[volume];
  if (!nominative) return flags;

  // Already has the nominative parenthetical? Skip.
  if (citation.candidate_text && /\(\d+\s+(?:Dall|Cranch|Wheat|Pet|How|Black|Wall)\.?\)/.test(citation.candidate_text)) {
    return flags;
  }

  flags.push({
    severity: 'non_conforming',
    category: 'reporter',
    rule_cite: 'BB R. 10.3.2',
    table_cite: 'T1.1',
    message: `Early Supreme Court cases require the nominative-reporter parenthetical. Volume ${volume} of U.S. Reports = "${nominative}" — must be cited as "${volume} U.S. (${nominative}) ${c.first_page || ''} (${c.year || 'YYYY'})".`,
    suggested_fix: citation.candidate_text
      ? citation.candidate_text.replace(
          new RegExp(`\\b${volume}\\s+U\\.S\\.\\s+`),
          `${volume} U.S. (${nominative}) `
        )
      : null,
  });
  return flags;
}

// ---------------------------------------------------------------------------
// 8. validateRestatementForm — R. 12.9.5
//
//    Restatements must be cited as:
//      Restatement (Second) of Contracts § 351 (Am. L. Inst. 1981)
//
//    Common errors:
//      • "Restatement 2d Contracts §351"  — wrong series form, missing
//        "of", missing publisher/year, missing § space
// ---------------------------------------------------------------------------
const RESTATEMENT_PUBLISHER_YEARS = {
  // Default Am. L. Inst. publication years for canonical Restatements.
  // Used to suggest the year when the user omitted it.
  '(First) of Contracts': '1932',
  '(Second) of Contracts': '1981',
  '(Third) of Contracts': '2025', // tentative — still in progress
  '(Second) of Torts': '1965 / 1979',
  '(Third) of Torts: Phys. & Emot. Harm': '2010',
  '(Third) of Torts: Liab. for Phys. Harm': '2010',
  '(Second) of Property: Donative Transfers': '1983',
  '(Third) of Property: Wills & Other Donative Transfers': '2003',
  '(Second) of Trusts': '1959',
  '(Third) of Trusts': '2003',
  '(Second) of Agency': '1958',
  '(Third) of Agency': '2006',
  '(Third) of Restitution and Unjust Enrichment': '2011',
  '(Third) of Foreign Relations Law': '1987',
  '(Fourth) of Foreign Relations Law': '2018',
};

export function validateRestatementForm(candidateText) {
  if (!candidateText || typeof candidateText !== 'string') return [];
  if (!/\bRestatement\b/.test(candidateText)) return [];

  // Round 16/28 — only fire on text that looks like an actual Restatement
  // CITATION, not prose mentioning "the Restatement" or news-article titles
  // that contain the word in a non-legal sense (e.g., "Reserve Restatement"
  // in a WSJ headline). The previous heuristic also accepted "of <Subject>"
  // or any year-parenthetical, which over-fired on the WSJ headline.
  //
  // Three structural anchors confirm a Restatement CITATION (matching the
  // RESTATEMENT_PATTERN extractor):
  //
  //   (A) canonical series:        "Restatement (First|Second|Third|Fourth)"
  //   (B) short series:            "Restatement 2d|3d|4th"
  //   (C) "of <Subj> § <n>" + ALI: series-less but anchored on subject +
  //       section symbol + (Am. L. Inst. YYYY) publisher parenthetical.
  //       This preserves the legitimate R. 12.9.5 missing-series catch
  //       (e.g., Titan's "Restatement of Restitution and Unjust Enrichment
  //       § 1 (Am. L. Inst. 2011)" — needs (Third)).
  const hasCanonicalSeriesCheck =
    /\bRestatement\s+\((?:First|Second|Third|Fourth)\)/.test(candidateText);
  const hasShortSeriesCheck =
    /\bRestatement\s+(?:2d|3d|4th)\b/.test(candidateText);
  const hasSubjectSectionAndPublisher =
    /\bRestatement\s+of\s+[A-Z]/.test(candidateText) &&
    /§\s*\d/.test(candidateText) &&
    /\(\s*(?:Am\.?\s*L\.?\s*Inst\.?|American\s+Law\s+Institute)/.test(candidateText);
  const looksLikeCitation =
    hasCanonicalSeriesCheck || hasShortSeriesCheck || hasSubjectSectionAndPublisher;
  if (!looksLikeCitation) return [];

  const flags = [];

  // Helper — does the citation already have the canonical series form
  // "(First|Second|Third|Fourth)" parenthetical right after Restatement?
  const hasCanonicalSeries = /\bRestatement\s+\((First|Second|Third|Fourth)\)/.test(candidateText);

  // 1. NON-canonical series form: "Restatement 2d Foo" / "Restatement 3d Foo"
  //    → must be "Restatement (Second) of Foo" / "(Third) of Foo".
  const seriesShort = candidateText.match(/\bRestatement\s+(2d|3d|4th)\s+([A-Z][A-Za-z\s&]+?)(?=\s*§|\s*$|\s+\()/);
  if (seriesShort) {
    const seriesMap = { '2d': 'Second', '3d': 'Third', '4th': 'Fourth' };
    const canonical = seriesMap[seriesShort[1]];
    const subject = seriesShort[2].trim();
    flags.push({
      severity: 'non_conforming',
      category: 'form_components',
      rule_cite: 'BB R. 12.9.5',
      table_cite: null,
      message: `Restatement series must be cited as "Restatement (${canonical}) of ${subject}" — series in parentheses, "of" between series and subject (R. 12.9.5).`,
      suggested_fix: candidateText.replace(
        /\bRestatement\s+(?:2d|3d|4th)\s+([A-Z][A-Za-z\s&]+)/,
        `Restatement (${canonical}) of $1`
      ),
    });
  }

  // 2. NEW (Round 6.2): MISSING series designation entirely.
  //    "Restatement of Restitution § 1" — no (First|Second|Third|Fourth).
  //    Must add the series. We can't infer which series without the
  //    Bluebook table, so the fix template uses "(Third)" as a default
  //    placeholder and the user picks.
  if (!hasCanonicalSeries && !seriesShort) {
    flags.push({
      severity: 'non_conforming',
      category: 'form_components',
      rule_cite: 'BB R. 12.9.5',
      table_cite: null,
      message: 'Restatement citations require a series designation in parentheses immediately after "Restatement" — one of "(First)", "(Second)", "(Third)", or "(Fourth)". (R. 12.9.5)',
      // No auto-fix: we don't know which series applies. Leave to user.
      suggested_fix: null,
    });
  }

  // 3. Missing publisher/year parenthetical.
  //    Bluebook: Restatement (Second) of Contracts § 351 (Am. L. Inst. 1981)
  //
  //    Round 6.1 fix: the original regex was correct but the Pass 1
  //    pattern was cutting off the candidate_text BEFORE the trailing
  //    parenthetical, so this check always saw "no Am. L. Inst." and
  //    flagged correct citations. RESTATEMENT_PATTERN now includes the
  //    trailing parenthetical so this check is reliable.
  //
  //    Match "(Am. L. Inst. <year>)" with flexible spacing. Also accept
  //    common alternative spelling "American Law Institute".
  const hasPublisher = /\(\s*(?:Am\.?\s*L\.?\s*Inst\.?|American\s+Law\s+Institute)\s*[\d]{4}\s*\)/.test(candidateText);
  if (!hasPublisher) {
    let yearSuggest = '<year>';
    const seriesMatch = candidateText.match(/Restatement\s+\((First|Second|Third|Fourth)\)\s+of\s+([A-Za-z\.&\s:]+?)(?=\s*§|\s*$|,)/);
    if (seriesMatch) {
      const key = `(${seriesMatch[1]}) of ${seriesMatch[2].trim()}`;
      if (RESTATEMENT_PUBLISHER_YEARS[key]) yearSuggest = RESTATEMENT_PUBLISHER_YEARS[key];
    }
    flags.push({
      severity: 'non_conforming',
      category: 'form_components',
      rule_cite: 'BB R. 12.9.5',
      table_cite: null,
      message: `Restatement citations require a publisher/year parenthetical, e.g. "(Am. L. Inst. ${yearSuggest})" (R. 12.9.5).`,
      // Append, not replace — preserves the existing citation form.
      suggested_fix: candidateText.trim().replace(/\.?\s*$/, '') + ` (Am. L. Inst. ${yearSuggest})`,
    });
  }

  return flags;
}

// ---------------------------------------------------------------------------
// 9. validateCorporateCommas — R. 10.2.1(c)
//
//    Corporate suffixes (Inc., Corp., Co., Ltd., LLC, L.L.C., LLP) must
//    be preceded by a comma in case names: "Smith, Inc." not "Smith Inc."
// ---------------------------------------------------------------------------
// Per R. 10.2.1(c), whether a comma precedes "Inc." / "Corp." / etc.
// depends on the entity's official registered name — Bluebook says
// retain the comma if it's in the official name. We can't know that
// for arbitrary entities, so this validator only fires on
// multi-word-named entities where the comma is more often expected
// (e.g., "Apex Logistics Inc.") and emits at REVIEW severity, not
// non_conforming. The drafting attorney decides whether to add it
// based on the company's actual registered name.
const CORP_SUFFIXES = ['Inc\\.', 'Ltd\\.', 'LLC', 'L\\.L\\.C\\.', 'LLP', 'L\\.L\\.P\\.', 'P\\.C\\.'];
// Match either:
//   • a hyphenated single-word entity name ("Scientific-Atlanta Inc.")
//   • OR two+ space-separated capitalized words ("Crestwood Industries Inc.")
// Followed by a corporate suffix WITHOUT a comma. Both patterns are
// strong signals that the entity name has multiple recognizable parts
// before the suffix, which is when the Bluebook comma question is
// likeliest to apply.
const HYPHENATED_CORP_RE = new RegExp(
  `\\b[A-Z][A-Za-z]+-[A-Z][A-Za-z]+(\\s+(?:${CORP_SUFFIXES.join('|')}))(?=\\s|,|\\.|$)`,
  ''
);
const MULTI_WORD_CORP_RE = new RegExp(
  `\\b[A-Z][A-Za-z]+\\s+[A-Z][A-Za-z]+(\\s+[A-Z][A-Za-z]+)?(\\s+(?:${CORP_SUFFIXES.join('|')}))(?=\\s|,|\\.|$)`,
  ''
);

export function validateCorporateCommas(candidateText) {
  if (!candidateText || typeof candidateText !== 'string') return [];
  const flags = [];

  const m = candidateText.match(MULTI_WORD_CORP_RE) || candidateText.match(HYPHENATED_CORP_RE);
  if (!m) return flags;

  const suffix = m[m.length - 1] ? m[m.length - 1].trim() : '';
  // Skip if there's already a comma before the suffix.
  const fullMatch = m[0];
  if (/,\s+(?:Inc|Ltd|LLC|L\.L\.C|LLP|L\.L\.P|P\.C)\b/.test(fullMatch)) return flags;

  flags.push({
    severity: 'review',
    category: 'form_components',
    rule_cite: 'BB R. 10.2.1(c)',
    table_cite: null,
    message: `Verify whether the entity's registered name includes a comma before "${suffix}" (e.g., "Apex Logistics, Inc."). Many corporate names retain the comma; others do not. Bluebook R. 10.2.1(c) says match the official name.`,
    suggested_fix: null, // we can't auto-fix without knowing the legal name
  });

  return flags;
}

// ---------------------------------------------------------------------------
// 10. validateUnreportedCase — R. 10.8.1
//
//     Unreported / Westlaw / LEXIS cases require BOTH a pinpoint cite
//     ("at *X") AND an exact decision date ("Sept. 18, 2019").
//     Common omission: just "2019 WL 4567321 (S.D. Fla. 2019)" with
//     neither. Flag the missing components.
// ---------------------------------------------------------------------------
export function validateUnreportedCase(candidateText) {
  if (!candidateText || typeof candidateText !== 'string') return [];
  if (!/\b\d{4}\s+(?:WL|LEXIS)\s+\d+/.test(candidateText)) return [];

  const flags = [];

  // Missing pinpoint "at *X"?
  if (!/at\s+\*\d/.test(candidateText)) {
    flags.push({
      severity: 'non_conforming',
      category: 'form_components',
      rule_cite: 'BB R. 10.8.1',
      table_cite: null,
      message: 'Unreported (Westlaw/LEXIS) cases must include a star-paginated pinpoint, e.g., ", at *4" after the database number.',
      suggested_fix: null, // can't auto-fix without the actual pin
    });
  }

  // Missing exact decision date?  Court parenthetical should look like
  // "(S.D.N.Y. Sept. 18, 2019)" — i.e., contain a month abbreviation
  // before the year.
  const monthInParen = /\([^)]*(?:Jan\.|Feb\.|Mar\.|Apr\.|May|June|July|Aug\.|Sept\.|Oct\.|Nov\.|Dec\.)\s+\d+,?\s+\d{4}\)/;
  if (!monthInParen.test(candidateText)) {
    flags.push({
      severity: 'non_conforming',
      category: 'form_components',
      rule_cite: 'BB R. 10.8.1',
      table_cite: null,
      message: 'Unreported (Westlaw/LEXIS) cases must include the exact decision date inside the court parenthetical, e.g., "(S.D.N.Y. Sept. 18, 2019)" — not just the year.',
      suggested_fix: null,
    });
  }

  return flags;
}

// ---------------------------------------------------------------------------
// Round 13 — R. 4.2: supra is NOT permitted for cases.
//
// Bluebook R. 4.2(a) says: supra may not be used to refer to ... cases ...
// (use a short form instead). When we see something like "Iqbal, supra,
// at 679", this is the misuse — the proper form is "Iqbal, 556 U.S. at
// 679" using the case short form per R. 10.9.
//
// Detection: any candidate Pass 1 tagged provisional_type='short_form_supra'
// is suspect. We can't perfectly distinguish supra-for-secondary
// (legitimate) from supra-for-case (forbidden) without per-document
// resolution, but we emit a REVIEW-severity flag so the attorney
// confirms. False positives on legitimate book/article supras are
// acceptable since briefs rarely use book supras.
// ---------------------------------------------------------------------------
export function validateSupraForCase(citation) {
  if (!citation) return [];
  // Only fires on supra short-form candidates Pass 1 detected.
  if (citation.provisional_type !== 'short_form_supra'
      && citation.citation_type !== 'short_form_supra') {
    return [];
  }
  const text = citation.candidate_text || '';
  if (!/\bsupra\b/.test(text)) return [];

  // Round 18 — skip CROSS-REFERENCE supra (R. 3.6): "see supra Part II",
  // "supra Section III", "supra § 4". These are internal document
  // cross-references, NOT citation short forms — R. 4.2 doesn't apply.
  // Detect via post_context (text immediately after "supra"):
  const post = (citation.post_context || '');
  if (/^\s*(?:Part|Section|§)\s+/i.test(post)) return [];
  // Also detect when candidate_text itself contains the cross-reference marker.
  if (/\bsupra\s+(?:Part|Section|§)\b/i.test(text)) return [];

  // Round 18 — distinguish CASE supra (forbidden) from NON-CASE supra
  // (required form for treatises, articles, hereinafter forms).
  //
  // Heuristic: case names follow the pattern "<Italicized Case>, supra"
  // where the italicized portion typically contains " v. " in the FULL
  // citation OR is a single-word case name like "Twombly" / "Iqbal".
  // Non-case authorities use:
  //   • "<Author last name>, supra"          (article: e.g., "Burbank, supra")
  //   • "<Volume Author Title>, supra"        (treatise: "5B Wright & Miller, supra")
  //   • "<Hereinafter form>, supra"           ("ABA Guide, supra")
  //
  // Brief 7 has these CONTROL forms that must NOT fire:
  //   "5B Wright & Miller, supra, § 1357"     (treatise)
  //   "Burbank, supra, at 115"                (article)
  //   "Wright & Miller, supra, § 1357, at 712"
  //
  // And this ERROR form that should fire:
  //   "Twombly, supra, at 557"                (case)
  //
  // Distinguishing signal: if the supra is preceded by SECTION (§) or PIN
  // (at NN) markers that match a TREATISE/ARTICLE pattern (volume number
  // before author, OR multi-author "& X" co-author marker), it's non-case.
  //
  // Conservative rule: a case-supra candidate has ALL of these:
  //   1. Pre_context contains a FULL CASE CITATION to the same name
  //      (e.g., "Twombly" appears earlier with " v. " or with a U.S. cite),
  //      OR the lead-in is a single capitalized name followed by ", supra".
  //   2. Not preceded by a treatise/article marker like "§" or volume number.
  //
  // For now use a simpler exclusion: skip if the lead-in includes "&"
  // (multi-author treatise like "Wright & Miller") OR a volume number prefix
  // (like "5B Wright"). These are unambiguous non-case forms.
  const leadInMatch = text.match(/^([^,]+),\s*supra\b/);
  if (leadInMatch) {
    let leadIn = leadInMatch[1].trim();
    // Round 18 — strip leading citation signals ("See", "Cf.", "But cf.",
    // etc.) that the SUPRA_PATTERN's lead-in capture greedily includes.
    // Without this, "See Burbank, supra" → leadIn "See Burbank" → no
    // volume/& match → fires R. 4.2 even though "Burbank" is an article author.
    leadIn = leadIn.replace(/^(?:See also|See, e\.g\.|See|But see|But cf|Cf|Contra|Compare|Accord|E\.g\.)\.?,?\s+/i, '');
    // 1. Volume-prefixed treatise: e.g., "5B Wright & Miller", "4 Nimmer", etc.
    if (/^\d+[A-Z]?\s+[A-Z]/.test(leadIn)) return [];
    // 2. Multi-author treatise: contains "&" (e.g., "Wright & Miller").
    if (/\s+&\s+/.test(leadIn)) return [];
    // 3. Hereinafter forms tend to include a TITLE-CASE phrase with
    //    multiple words (e.g., "ABA Guide", "Securities Litigation").
    //    Single-word lead-ins are typically case names ("Twombly", "Iqbal").
    //    Multi-word lead-ins where each word is title-cased AND the phrase
    //    doesn't contain " v. " could be either; prefer to flag as case.
    //    Skip non-case ONLY when there's clear treatise/article signal.
  }

  // Round 18 — also skip when the citation is preceded in pre_context by a
  // signal that strongly indicates non-case context: "§" symbol immediately
  // after the supra (treatise section), or "Judicature"/L. Rev./L.J./
  // journal markers in the candidate text or pre_context.
  if (/\bsupra\b[^.]*?(?:§|note\s+\d)/i.test(text)) return []; // treatise §
  // Pre_context journal marker.
  const pre = (citation.pre_context || '');
  if (/\b(?:Judicature|L\.\s*Rev\.|L\.J\.|Yale L\.J\.|Harv\. L\. Rev\.|Stan\. L\. Rev\.|Colum\. L\. Rev\.|Vand\. L\. Rev\.)\b/.test(pre)) {
    // Author published in a known journal — supra is a legitimate article ref.
    return [];
  }
  // Round 18 — document-level disambiguation: if the validator was given a
  // `documentText` field (set by the orchestrator), check whether the
  // supra's lead-in name appears earlier as an ARTICLE-AUTHOR pattern
  // ("<Author>, <Title>, <Vol> <Journal>") rather than as a CASE-NAME
  // pattern (" v. <Other>"). For single-word leadIns like "Burbank", this
  // is the only reliable way to distinguish without a full citation map.
  // Round 20 — also skip if leadIn matches a declared [hereinafter X] form
  // tracked by the citation-state-tracker. "CAT, supra" with prior
  // "[hereinafter CAT]" declaration is a legitimate non-case supra.
  if (leadInMatch && citation._state_hereinafter_registry) {
    let leadInForRegistry = leadInMatch[1].trim()
      .replace(/^(?:See also|See, e\.g\.|See|But see|But cf|Cf|Contra|Compare|Accord|E\.g\.)\.?,?\s+/i, '');
    if (citation._state_hereinafter_registry[leadInForRegistry]) return [];
  }

  if (citation.document_text && leadInMatch) {
    const docText = citation.document_text;
    let leadIn2 = leadInMatch[1].trim()
      .replace(/^(?:See also|See, e\.g\.|See|But see|But cf|Cf|Contra|Compare|Accord|E\.g\.)\.?,?\s+/i, '');
    // Take the LAST word of leadIn (typical author last name or case name).
    const tokens = leadIn2.split(/\s+/);
    const lastName = tokens[tokens.length - 1].replace(/[,.]$/, '');
    if (lastName && /^[A-Z][a-z]+$/.test(lastName)) {
      // Search for case pattern: "<lastName> v." or "v. <lastName>"
      const caseRe = new RegExp(`(?:\\b${lastName}\\s+v\\.|\\bv\\.\\s+${lastName}\\b)`);
      const isCase = caseRe.test(docText);
      // Search for article-author pattern: "<FirstName M. lastName>, <Title>, <Vol> <Journal/Cap-word> <Page>"
      const articleRe = new RegExp(
        `\\b[A-Z][\\w'.\\-]+(?:\\s+[A-Z][\\w'.\\-]*\\.?)*\\s+${lastName}\\s*,\\s+[A-Z][^,]{5,200}?,\\s+\\d{1,4}\\s+[A-Z]`
      );
      const isArticleAuthor = articleRe.test(docText);
      if (isArticleAuthor && !isCase) return [];
    }
  }

  return [{
    severity: 'review',
    category: 'short_form',
    rule_cite: 'BB R. 4.2',
    table_cite: null,
    message: 'If this "supra" reference is to a case, supra is not permitted for cases (R. 4.2). Use the case short form instead, e.g., "Iqbal, 556 U.S. at 679".',
    suggested_fix: null,
  }];
}

// ---------------------------------------------------------------------------
// Round 13 — R. 6.1 / T6: short-form abbreviations need their period.
//
// Brief 3 had "Bell Atl, 550 U.S. at 555" — using "Atl" (the T6
// abbreviation for "Atlantic") WITHOUT the trailing period. The
// previous tooling flagged this as a R. 10.9(a) short-form-mismatch
// issue, but the actual rule is R. 6.1 / T6: T6 abbreviations carry
// a trailing period as part of the canonical form.
//
// Detection: scan candidate_text for any T6 abbreviation token that
// appears WITHOUT a trailing period (and isn't followed by another
// letter, which would mean it's a substring of a longer word).
// ---------------------------------------------------------------------------
export function validateShortFormAbbreviationPeriods(candidateText) {
  if (!candidateText || typeof candidateText !== 'string') return [];
  const flags = [];
  const t6 = T6();
  const abbrs = t6.abbreviations || {};

  // Build a set of distinct abbreviation values that end in "." — these
  // are the canonical T6 abbreviations like "Atl.", "Co.", "Educ.",
  // "Indus.", etc. Strip the trailing period to get the bare form, then
  // look for occurrences in candidate_text WITHOUT the period.
  //
  // Round 14 — exclude bare forms that overlap with REPORTER tokens so
  // the R. 6.1/T6 case-name validator doesn't double-fire on the same
  // span as the R. 6.1/T1.1 reporter validator. "U.S" is a T6 case-name
  // abbreviation for "United States" AND a reporter; the reporter
  // validator already handles missing-period reporter flags (and provides
  // a more accurate message for that context). Same for the few other
  // T6 entries whose bare form looks like a reporter.
  const REPORTER_OVERLAP = new Set(['U.S', 'F.R', 'B.R']);
  const bareForms = new Set();
  for (const v of Object.values(abbrs)) {
    if (typeof v === 'string' && v.endsWith('.') && v.length > 1) {
      const bare = v.slice(0, -1); // "Atl." -> "Atl"
      // Skip single-character bare forms (would over-match common words).
      if (bare.length < 2) continue;
      if (REPORTER_OVERLAP.has(bare)) continue;
      bareForms.add(bare);
    }
  }

  // Avoid duplicate flags for the same bare form within one citation.
  const seen = new Set();
  for (const bare of bareForms) {
    // Skip if the canonical form (with period) appears — that's correct.
    // Match: the bare form as a standalone token, NOT followed by "." or
    // another letter. E.g., "Bell Atl, 550 U.S." → "Atl" matches; "Atlantic"
    // does NOT (because "l" is followed by "a"); "Atl." does NOT (followed
    // by "."). Also: avoid first-word-of-party rule (R. 10.2.1(c)) by only
    // flagging when bare form is preceded by ", " or " " inside a span
    // that already looks like a case-name-then-cite structure.
    //
    // Round 18 — also exclude `'` (apostrophe) from the negative lookahead.
    // Without that, "Nat'l" matches as bare form "Nat" because `'` is
    // neither letter nor period. Same with "Auto" inside "Auto Racing"
    // (where "Auto" is a real word, not the "Automobile" abbreviation).
    // Apostrophe is the canonical contraction marker for words like
    // "Nat'l", "Ass'n", "Comm'n" — these are correct as-is.
    const re = new RegExp(`\\b${escapeRegex(bare)}(?![A-Za-z.'])`, 'g');
    if (!re.test(candidateText)) continue;
    if (seen.has(bare)) continue;
    seen.add(bare);
    // Round 18 — additional FP guard: skip when the bare form is followed
    // by another known noun (e.g., "Auto Racing" — "Auto" here is a real
    // word, not an abbreviation for "Automobile"). Heuristic: if the bare
    // form is followed by " <Cap-word>" that's NOT a citation-structure
    // word (volume/page/year/comma), it's likely a real word.
    //
    // Use a fresh regex (lastIndex 0) for matchAll — `re.test()` above
    // advanced lastIndex past the first match, so reusing `re` would skip it.
    const reFresh = new RegExp(re.source, 'g');
    const matchPositions = [...candidateText.matchAll(reFresh)];
    let isInRealWordContext = false;
    for (const m of matchPositions) {
      const after = candidateText.slice(m.index + m[0].length, m.index + m[0].length + 25);
      if (/^\s+[A-Z][a-z]/.test(after)) {
        isInRealWordContext = true;
        break;
      }
    }
    if (isInRealWordContext) continue;

    flags.push({
      severity: 'non_conforming',
      category: 'abbreviations',
      rule_cite: 'BB R. 6.1',
      table_cite: 'T6',
      message: `Case-name abbreviation "${bare}" must include a trailing period: "${bare}." per R. 6.1 / T6.`,
      suggested_fix: candidateText.replace(re, `${bare}.`),
    });
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Round 15 — R. 1.2 signal capitalization
//
//    Per Bluebook R. 1.2 — signals (See, Cf., But see, Compare, Accord,
//    Contra, E.g., etc.) are capitalized when they begin a citation
//    SENTENCE and lowercased when they appear MID-string-cite (after a
//    semicolon) or in embedded contexts like "Compare X, with Y".
//
//    Detection: look at the citation's pre_context. Find the signal
//    immediately preceding the citation. Determine context from the
//    punctuation BEFORE the signal:
//       • Period / exclamation / question + space → sentence start (capitalize)
//       • Semicolon + space → mid-string-cite (lowercase)
//       • Comma + space → embedded clause like "Compare X, with Y" (lowercase)
//
//    Conservative bias: when context is ambiguous (no clear punctuation
//    boundary visible in pre_context), DO NOT flag — silence beats noise.
// ---------------------------------------------------------------------------

// Recognised Bluebook signals. Keyed by canonical lowercase form so we can
// look up case-correctness without re-typing. Multi-word signals (e.g.,
// "see also", "but see", "but cf.") MUST come before their single-word
// prefixes ("see", "but") in the pattern alternation to avoid greedy mis-match.
const SIGNAL_LIST = [
  'see also', 'see, e.g.', 'but see', 'but cf.', 'but cf',
  'see', 'cf.', 'cf', 'contra', 'compare', 'accord', 'e.g.',
];
// "with" and "and" only appear inside a Compare/with or Compare/and
// construction. They MUST be lowercase per R. 1.2; capitalizing them
// is always wrong in the citation context.
const COMPARE_INNER = new Set(['with', 'and']);

const SIGNAL_ALT = SIGNAL_LIST.map(escapeRegex).join('|');
// Capture: optional leading punctuation context, then the signal token
// (case-insensitive). Anchored to END of the pre_context so we know it's
// the signal IMMEDIATELY preceding the citation.
const SIGNAL_AT_END_RE = new RegExp(
  `(^|[.!?;,])\\s+(${SIGNAL_ALT}|with|and)\\s*$`,
  'i'
);

function expectedSignalCase(precedingPunct) {
  // First-on-line / paragraph start = sentence start
  if (precedingPunct === '' || precedingPunct === '.' || precedingPunct === '!' || precedingPunct === '?') {
    return 'capitalize';
  }
  if (precedingPunct === ';' || precedingPunct === ',') {
    return 'lowercase';
  }
  return null; // ambiguous — don't flag
}

function canonicalLowercase(signalAsWritten) {
  return signalAsWritten.toLowerCase();
}

function canonicalCapitalized(signalAsWritten) {
  // Bluebook capitalization: only the first letter is capitalised.
  // "see" -> "See", "see also" -> "See also", "cf." -> "Cf.",
  // "but see" -> "But see", "but cf." -> "But cf.", "e.g." -> "E.g."
  const lower = signalAsWritten.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function validateSignalCapitalization(citation) {
  if (!citation) return [];
  const type = citation.citation_type || citation.provisional_type;
  if (type !== 'case' && type !== 'short_form_case') return [];

  const pre = citation.pre_context || '';
  if (!pre) return [];

  // Trim trailing whitespace so the signal can be at the very end.
  const trimmed = pre.replace(/\s+$/, '');
  const m = trimmed.match(SIGNAL_AT_END_RE);
  if (!m) return [];

  const precedingPunct = (m[1] || '').trim(); // either '', '.', ';', ',', '!', '?'
  const signalAsWritten = m[2];
  const signalLower = signalAsWritten.toLowerCase();
  const isCompareInner = COMPARE_INNER.has(signalLower);

  const flags = [];

  if (isCompareInner) {
    // "with" / "and" inside Compare/...with or Compare/...and constructions
    // must be lowercase always. R. 1.2 — these are not standalone signals.
    if (signalAsWritten !== signalLower) {
      flags.push({
        severity: 'non_conforming',
        category: 'signal',
        rule_cite: 'BB R. 1.2',
        table_cite: null,
        message: `Signal "${signalAsWritten}" inside a Compare/${signalLower} construction must be lowercase per R. 1.2.`,
        suggested_fix: null,
      });
    }
    return flags;
  }

  const expected = expectedSignalCase(precedingPunct);
  if (expected === null) return [];

  // Round 15 — compare the full signal form (not just the first letter)
  // so multi-word signals like "but cf." get caught when EITHER word is
  // miscased. "but Cf." (lowercase but, capitalized Cf.) is wrong because
  // mid-string-cite expects all-lowercase "but cf.".
  if (expected === 'capitalize') {
    const canonical = canonicalCapitalized(signalAsWritten);
    if (signalAsWritten !== canonical) {
      flags.push({
        severity: 'non_conforming',
        category: 'signal',
        rule_cite: 'BB R. 1.2',
        table_cite: null,
        message: `Signal "${signalAsWritten}" begins a citation sentence (after "${precedingPunct || 'paragraph start'}") and must be capitalized: "${canonical}" per R. 1.2.`,
        suggested_fix: null,
      });
    }
  } else if (expected === 'lowercase') {
    const canonical = canonicalLowercase(signalAsWritten);
    if (signalAsWritten !== canonical) {
      flags.push({
        severity: 'non_conforming',
        category: 'signal',
        rule_cite: 'BB R. 1.2',
        table_cite: null,
        message: `Signal "${signalAsWritten}" appears mid-string-cite (after "${precedingPunct}") and must be lowercase: "${canonical}" per R. 1.2.`,
        suggested_fix: null,
      });
    }
  }

  return flags;
}

// ---------------------------------------------------------------------------
// Round 16 — Secondary-source validators (R. 15 books, R. 16 articles,
// R. 17 manuscripts/forthcoming, R. 18 internet).
//
// These run on candidates emitted by secondary-source-patterns.js, which
// classifies them by provisional_type ('book' / 'article' / 'manuscript' /
// 'forthcoming' / 'internet'). The validators read candidate_text directly
// (no Pass 2 component parse needed for this category — the structural
// markers are simple enough to detect with regex).
// ---------------------------------------------------------------------------

// Known multi-volume treatises that REQUIRE a leading volume number per
// R. 15.1 / R. 3.5. The list is conservative; add entries as the corpus
// grows. Each entry is the canonical short title that appears in the
// citation.
const MULTI_VOLUME_TREATISES = [
  'Nimmer on Copyright',
  'Patry on Copyright',
  'Federal Practice and Procedure',  // Wright & Miller
  'Goldstein on Copyright',
  'Witkin',                          // Witkin's California legal treatises
  'Williston on Contracts',
  'Corbin on Contracts',
  "Wigmore on Evidence",
  'McCormick on Evidence',
  'Couch on Insurance',
  'Restatement',                     // generic — handled separately by R. 12.9.5
  'Mertens',
  'Moore\'s Federal Practice',
  'Powell on Real Property',
  'Collier on Bankruptcy',
];

/**
 * R. 15 — Book / treatise validator.
 *
 * Checks:
 *   • Multi-volume treatise must have a leading volume number (R. 15.1 / R. 3.5)
 *   • Edition designation in the parenthetical (R. 15.4) — at minimum a
 *     digit-or-roman ed/rev/Bender/etc indicator
 *   • Italicized title (R. 15.3) — handled separately by italics validator
 *     when format info is available; otherwise silent.
 */
export function validateBookCitation(citation) {
  if (!citation || citation.citation_type !== 'book') return [];
  const text = citation.candidate_text || '';
  if (!text) return [];

  // Round 18 — guard: skip when the candidate looks like a LAW-REVIEW
  // ARTICLE that the article extractor missed (typically a journal whose
  // T13 abbreviation lacks "Rev." / "L.J." / "Journal" — e.g., "Judicature").
  // Article shape: "<Vol> <Journal> <Page>(, <Pin>)? (YEAR)". Books don't
  // fit this shape.
  const looksLikeArticle = /,\s*\d{1,3}\s+[A-Z][\w.\s]+\s+\d{1,5}(?:,\s*\d{1,5})?\s+\(\d{4}\)/.test(text);
  if (looksLikeArticle) return [];

  const flags = [];

  // R. 15.1 — multi-volume work must lead with a volume number.
  for (const treatise of MULTI_VOLUME_TREATISES) {
    if (!text.includes(treatise)) continue;
    if (treatise === 'Restatement') continue; // skip — handled by R. 12.9.5
    // Volume prefix pattern: optional leading digit(s) + optional letter, then a space, before the author/title.
    // We expect VOLUME at the very START of the candidate (after any leading
    // signal which Pass 1 has already stripped).
    const stripped = text.replace(/^\s+/, '');
    const hasVolume = /^\d{1,4}[A-Z]?\s+[A-Z]/.test(stripped);
    if (!hasVolume) {
      flags.push({
        severity: 'non_conforming',
        category: 'form_components',
        rule_cite: 'BB R. 15.1',
        table_cite: null,
        message: `Multi-volume treatise "${treatise}" must include a volume number at the start of the citation per R. 15.1 / R. 3.5 (e.g., "8 ${treatise} ...").`,
        suggested_fix: null,
      });
    }
    break; // one volume flag per citation is enough
  }

  // R. 15.4 — edition designation. The parenthetical at the end of a
  // book cite should indicate edition. Conservative version: only flag
  // when title looks like a known treatise/textbook AND the parenthetical
  // has only a year. Skip Restatements (R. 12.9.5 handles those) and
  // skip when a multi-volume R. 15.1 flag will already fire (don't
  // double-flag the same citation).
  if (/\bRestatement\b/.test(text)) {
    // Skip — Restatements are handled by R. 12.9.5
  } else if (flags.some((f) => f.rule_cite === 'BB R. 15.1')) {
    // Skip — R. 15.1 already firing on this citation; don't pile on.
  } else {
    const parenMatch = text.match(/\(([^)]*?)\)\s*$/);
    if (parenMatch) {
      const inside = parenMatch[1];
      const hasEdition = /\bed\.|\brev\.|\bcum\. supp\.|edition\b/i.test(inside);
      const hasYear = /\b\d{4}\b/.test(inside);
      if (hasYear && !hasEdition) {
        const titleLikely = /\b(?:Practice|Procedure|Treatise|Textbook|Handbook|Property|Contracts|Evidence|Copyright|Patents|Patent Law|Trademark|Antitrust|Securities|Corporations|Bankruptcy|Tax|Family Law|Criminal Law|Constitutional|Administrative|Insurance|Employment|Restitution|Torts|Civil|Federal|Intellectual)\b/.test(text);
        if (titleLikely) {
          flags.push({
            severity: 'non_conforming',
            category: 'form_components',
            rule_cite: 'BB R. 15.4',
            table_cite: null,
            message: `Treatise citation should include an edition designation (e.g., "(3d ed. 2024)") per R. 15.4. The parenthetical contains only a year.`,
            suggested_fix: null,
          });
        }
      }
    }
  }

  return flags;
}

/**
 * R. 16 — Law-review article validator.
 *
 * Checks:
 *   • Volume number present before journal (R. 16.4)
 *   • Journal name canonically abbreviated (R. 16.4 / T13)
 *   • Student work has "Note," / "Comment," designation (R. 16.6.1)
 *   • Italicized title (R. 16.4) — handled by italics validator
 */
export function validateArticleCitation(citation) {
  if (!citation || citation.citation_type !== 'article') return [];
  const text = citation.candidate_text || '';
  if (!text) return [];
  const flags = [];

  // R. 16.4 — Journal abbreviation. Look for any T13 long-form name in the
  // text. If found, flag with the canonical abbreviation.
  const t13 = T13();
  const periodicals = t13.periodicals || {};
  for (const [longName, abbrev] of Object.entries(periodicals)) {
    if (longName.startsWith('_')) continue; // skip section markers
    if (text.includes(longName)) {
      flags.push({
        severity: 'non_conforming',
        category: 'abbreviations',
        rule_cite: 'BB R. 16.4',
        table_cite: 'T13',
        message: `Journal "${longName}" must be abbreviated "${abbrev}" per R. 16.4 / T13.`,
        suggested_fix: text.replace(longName, abbrev),
      });
      break; // one journal-abbrev flag per article
    }
  }

  // R. 16.4 — Volume must precede the journal abbreviation. Detection:
  // find a recognized journal abbreviation token in the text. The text
  // immediately before the abbreviation should be a 1-4 digit volume number.
  // If we see "Colum. L. Rev. <page>" without a volume, flag.
  const journalAbbrevs = [
    'Harv. L. Rev.', 'Yale L.J.', 'Stan. L. Rev.', 'Colum. L. Rev.',
    'U. Pa. L. Rev.', 'U. Chi. L. Rev.', 'Mich. L. Rev.', 'Va. L. Rev.',
    'Cornell L. Rev.', 'Tex. L. Rev.', 'Geo. L.J.', 'Cal. L. Rev.',
    'Duke L.J.', 'N.Y.U. L. Rev.', 'UCLA L. Rev.', 'Vand. L. Rev.',
    'Wash. L. Rev.', 'Tul. L. Rev.', 'Notre Dame L. Rev.',
  ];
  for (const ja of journalAbbrevs) {
    const idx = text.indexOf(ja);
    if (idx === -1) continue;
    // Look at the text immediately before the abbreviation.
    const before = text.slice(Math.max(0, idx - 8), idx).trimEnd();
    // Volume should be a digit sequence + space.
    const hasVolume = /\d+\s*$/.test(before);
    if (!hasVolume) {
      flags.push({
        severity: 'non_conforming',
        category: 'form_components',
        rule_cite: 'BB R. 16.4',
        table_cite: null,
        message: `Article citation is missing the volume number before "${ja}". R. 16.4 requires the volume to precede the journal abbreviation.`,
        suggested_fix: null,
      });
      break;
    }
  }

  // R. 16.6.1 — Student-authored work. The Bluebook requires "Note," or
  // "Comment," (or "Recent Development," etc.) between the author name
  // and the title. Detection: hard. A heuristic is that articles in the
  // brief 5 corpus are seeded with "Sarah Mitchell, Note, ..." (correct)
  // and "Daniel Reyes, ..." (missing Note). Without student-vs-faculty
  // metadata, we cannot deterministically flag this. SKIP for now — too
  // prone to false positives on faculty articles. Will revisit when we
  // have author metadata or law-school-affiliation cues.

  return flags;
}

/**
 * R. 17.1 — Unpublished manuscript validator.
 *
 * Checks:
 *   • "(unpublished manuscript)" parenthetical present
 *
 * Detection: the secondary-source extractor emitted this as type
 * 'manuscript' because either "(unpublished manuscript)" or "(on file
 * with...)" appeared. If only "(on file...)" appeared (no
 * "(unpublished manuscript)"), flag.
 */
export function validateManuscriptCitation(citation) {
  if (!citation || citation.citation_type !== 'manuscript') return [];
  const text = citation.candidate_text || '';
  if (!text) return [];
  const flags = [];

  const hasUnpublished = /\(unpublished\s+manuscript\)/i.test(text);
  if (!hasUnpublished) {
    flags.push({
      severity: 'non_conforming',
      category: 'form_components',
      rule_cite: 'BB R. 17.1',
      table_cite: null,
      message: `Unpublished manuscript citation requires "(unpublished manuscript)" parenthetical before any "(on file with ...)" tag per R. 17.1.`,
      suggested_fix: null,
    });
  }

  return flags;
}

/**
 * R. 17.2 — Forthcoming-article validator.
 *
 * Checks:
 *   • Forthcoming article should include a volume number when known.
 */
export function validateForthcomingCitation(citation) {
  if (!citation || citation.citation_type !== 'forthcoming') return [];
  const text = citation.candidate_text || '';
  if (!text) return [];
  const flags = [];

  // Find the journal abbreviation. Volume must precede it.
  const journalAbbrevs = [
    'Harv. L. Rev.', 'Yale L.J.', 'Stan. L. Rev.', 'Colum. L. Rev.',
    'U. Pa. L. Rev.', 'U. Chi. L. Rev.', 'Mich. L. Rev.', 'Va. L. Rev.',
    'Cornell L. Rev.', 'Tex. L. Rev.', 'Geo. L.J.', 'Cal. L. Rev.',
    'Duke L.J.', 'N.Y.U. L. Rev.', 'UCLA L. Rev.',
  ];
  for (const ja of journalAbbrevs) {
    const idx = text.indexOf(ja);
    if (idx === -1) continue;
    const before = text.slice(Math.max(0, idx - 8), idx).trimEnd();
    const hasVolume = /\d+\s*$/.test(before);
    if (!hasVolume) {
      flags.push({
        severity: 'non_conforming',
        category: 'form_components',
        rule_cite: 'BB R. 17.2',
        table_cite: null,
        message: `Forthcoming article should include the volume number before "${ja}" per R. 17.2 / R. 16.4 (e.g., "138 Harv. L. Rev. (forthcoming 2025)").`,
        suggested_fix: null,
      });
      break;
    }
  }

  return flags;
}

/**
 * R. 18 — Internet source validator.
 *
 * Checks:
 *   • R. 18.2.1 — Prefer https over http when the site supports it.
 *     Flag any http:// URL as review-level (we don't probe the site).
 *   • R. 18.2.3 — Dynamic content (homepages, search pages, agency
 *     guidance pages without a static path component) should include
 *     "(last visited DATE)".
 */
export function validateInternetCitation(citation) {
  if (!citation || citation.citation_type !== 'internet') return [];
  const text = citation.candidate_text || '';
  if (!text) return [];
  const flags = [];

  // R. 18.2.1 — http vs. https
  const httpMatch = text.match(/\bhttp:\/\/([^\s)]+)/);
  if (httpMatch) {
    flags.push({
      severity: 'review',
      category: 'form_components',
      rule_cite: 'BB R. 18.2.1',
      table_cite: null,
      message: `URL uses "http://" — R. 18.2.1 directs preference for "https://" when the site supports it. Verify and update to https if available.`,
      suggested_fix: text.replace(/http:\/\//, 'https://'),
    });
  }

  // R. 18.2.3 — Dynamic content needs "(last visited DATE)".
  // Heuristic: URLs whose path looks like a top-level guidance/search/
  // homepage page (one or two short path segments, no article-style
  // segments, no date in the URL) are dynamic. Flag them when no
  // "(last visited ...)" parenthetical is present.
  const urlMatch = text.match(/https?:\/\/[^\s)]+/);
  const hasLastVisited = /\(last\s+visited[^)]*\)/i.test(text);
  if (urlMatch && !hasLastVisited) {
    const url = urlMatch[0].replace(/[.,]+$/, '');
    // Strip protocol + host, look at path
    const pathMatch = url.match(/^https?:\/\/[^/]+(\/.*)?$/);
    const path = pathMatch ? (pathMatch[1] || '') : '';
    // Dynamic heuristic: empty path, or just one short segment (no slashes
    // in the meaningful portion), or path looks like a guidance / homepage
    // (no date pattern, no extension). Static articles typically have
    // year/month/slug paths or .html/.pdf extensions.
    const segments = path.split('/').filter(Boolean);
    const hasDateInPath = /\/\d{4}\b/.test(path);
    const hasFileExt = /\.(?:html?|pdf|aspx?|jsp)\b/i.test(path);
    const looksDynamic = !hasDateInPath && !hasFileExt;
    // Round 16 — only flag truly homepage-y URLs (≤1 path segment, e.g.,
    // "https://copyright.gov/registration/" → 1 segment "registration").
    // 2+ segments suggests a meaningful path that's likely static.
    if (looksDynamic && segments.length <= 1) {
      flags.push({
        severity: 'non_conforming',
        category: 'form_components',
        rule_cite: 'BB R. 18.2.3',
        table_cite: null,
        message: `Internet citation to dynamic content (homepage / guidance page) requires a "(last visited DATE)" parenthetical per R. 18.2.3. None found.`,
        suggested_fix: null,
      });
    }
  }

  return flags;
}

/**
 * R. 18.2 — Internet news article missing URL.
 *
 * Detects news/journal-like citations that should have a URL but don't.
 * Heuristic: a citation that mentions a known publication outlet
 * (N.Y. Times / Bloomberg / Hollywood Reporter / Wall St. J. / Wash.
 * Post / etc.) and has a date parenthetical but no URL.
 */
const NEWS_OUTLETS = [
  'N.Y. Times', 'New York Times', 'Wall St. J.', 'Wall Street Journal',
  'Wash. Post', 'Washington Post', 'L.A. Times', 'Los Angeles Times',
  'USA Today', 'Bloomberg', 'Reuters', 'Associated Press',
  'Hollywood Reporter', 'Variety', 'TechCrunch', 'Politico',
  'Axios', 'The Atlantic', 'New Yorker', 'Vox', 'Slate', 'BuzzFeed',
  'Time', 'Newsweek', 'Forbes', 'Fortune',
  'CNN', 'NBC', 'CBS', 'ABC', 'Fox News', 'NPR', 'BBC',
  'Boston Globe', 'Chicago Tribune', 'San Francisco Chronicle',
  'Miami Herald', 'Atlanta Journal',
];

export function validateNewsArticleNeedsUrl(citation) {
  // Only fire on internet-typed candidates that DON'T have a URL.
  // The secondary-source extractor only emits 'internet' for cites that
  // actually have URLs — so news-cites without URLs won't be classified
  // as 'internet'. Catch them via a separate check at any citation:
  if (!citation) return [];
  const text = citation.candidate_text || '';
  if (!text) return [];
  // Skip if URL already present
  if (/https?:\/\//.test(text)) return [];
  // Skip if it doesn't look like a news article (no outlet name)
  const outletMatch = NEWS_OUTLETS.find((o) => text.includes(o));
  if (!outletMatch) return [];
  // Skip if it doesn't have a date parenthetical
  if (!/\([A-Z][a-z]{2,5}\.?\s+\d{1,2},\s+\d{4}\)/.test(text) && !/\([A-Z][a-z]{2,5}\.?\s+\d{4}\)/.test(text)) return [];
  return [{
    severity: 'non_conforming',
    category: 'form_components',
    rule_cite: 'BB R. 18.2',
    table_cite: null,
    message: `News article cite to "${outletMatch}" should include a URL per R. 18.2. None found.`,
    suggested_fix: null,
  }];
}

// ---------------------------------------------------------------------------
// Round 19 — State-aware validators (require attachCitationState before run).
// ---------------------------------------------------------------------------

/**
 * R. 4.1 — Id. antecedent mismatch.
 *
 * Fires when an Id. citation's previous_citation is to a DIFFERENT case
 * than the surrounding paragraph discusses. Per R. 4.1, Id. always refers
 * to the immediately preceding cited authority — but if the writer
 * intended a different case (the one mentioned in the surrounding text),
 * Id. is wrong.
 *
 * Detection: scan the paragraph for italicized case-name tokens (or any
 * case-name word matching a known antecedent). If the text BETWEEN the
 * previous_citation and the Id. mentions a case OTHER than the
 * previous_citation's case, fire.
 */
export function validateIdAntecedent(citation) {
  if (!citation) return [];
  const type = citation.citation_type || citation.provisional_type;
  if (type !== 'short_form_id') return [];

  const prev = citation._state_previous;
  if (!prev || !prev.case_short_name) return [];

  // Look at pre_context for ALL distinct case-name tokens. Catch BOTH
  // full-form case names ("<Name> v.") AND short-form citations
  // ("<Name>, <Vol> <Reporter>"). If more than one distinct case appears
  // in the surrounding paragraph and prev_citation isn't the only one,
  // the Id. is structurally ambiguous — fire as a review-severity flag.
  //
  // Round 19 — when extracting from short-form pattern, skip names that
  // are actually DEFENDANTS in a "<Plaintiff> v. <Defendant>, <Vol>" span
  // (e.g., "Anderson v. Liberty Lobby, 477 U.S. ..." — "Lobby" is the
  // defendant party of Anderson, not a separate case).
  const pre = citation.pre_context || '';
  const caseSet = new Set();
  // Full form: "<Name> v." → captures plaintiff name only.
  for (const m of pre.matchAll(/\b([A-Z][\w'.\-]+)\s+v\./g)) {
    caseSet.add(m[1]);
  }
  // Short form: "<Name>, <Vol> <Reporter>" — but EXCLUDE defendants in v.-spans.
  for (const m of pre.matchAll(/\b([A-Z][\w'.\-]+),\s*\d{1,4}\s+[A-Z]/g)) {
    // Look back up to 60 chars for " v. " — if found, this is the defendant
    // of a multi-party case, not a separate citation.
    const lookback = pre.slice(Math.max(0, m.index - 60), m.index);
    if (/\s+v\.\s+(?:[A-Z][\w'.\-]+(?:\s+[A-Z][\w'.\-]+)*\s*)?$/.test(lookback)) continue;
    caseSet.add(m[1]);
  }
  if (caseSet.size === 0) return [];

  // Remove prev_citation's case from the set — what remains is the OTHER
  // cases mentioned in pre_context.
  caseSet.delete(prev.case_short_name);
  if (caseSet.size === 0) return []; // only prev's case mentioned — Id. is unambiguous

  // Pick the most-recent OTHER case as the likely intended antecedent.
  // We use the LAST occurrence in pre_context for the message.
  let mostRecentOther = null;
  let mostRecentPos = -1;
  for (const otherCase of caseSet) {
    const positions = [];
    const reFull = new RegExp(`\\b${otherCase}\\s+v\\.`, 'g');
    const reShort = new RegExp(`\\b${otherCase},\\s*\\d{1,4}\\s+[A-Z]`, 'g');
    let m;
    while ((m = reFull.exec(pre)) !== null) positions.push(m.index);
    while ((m = reShort.exec(pre)) !== null) positions.push(m.index);
    const lastPos = Math.max(...positions, -1);
    if (lastPos > mostRecentPos) {
      mostRecentPos = lastPos;
      mostRecentOther = otherCase;
    }
  }
  if (!mostRecentOther) return [];

  return [{
    severity: 'review',
    category: 'short_form',
    rule_cite: 'BB R. 4.1',
    table_cite: null,
    message: `"Id." references the immediately preceding citation (${prev.case_short_name}), but the surrounding paragraph also discusses ${mostRecentOther}. R. 4.1 requires Id. to refer ONLY to the immediately preceding cited authority — if you intended ${mostRecentOther}, use the case short form (e.g., "${mostRecentOther}, [reporter] at [page]") to avoid ambiguity.`,
    suggested_fix: null,
  }];
}

/**
 * R. 10.9 — Short form after multiple intervening citations.
 *
 * Per R. 10.9, a case short form may be used when the full citation
 * appears earlier in the same general discussion. Practical guideline:
 * after roughly 5 intervening citations, repeat the full citation.
 *
 * Fires as ADVISORY when intervening_count >= 6. Conservative bias:
 * we don't fire as non_conforming because the 5-cite rule is heuristic.
 */
export function validateShortFormGap(citation) {
  if (!citation) return [];
  const type = citation.citation_type || citation.provisional_type;
  if (type !== 'short_form_case') return [];

  const cs = citation._state_case_state;
  if (!cs) return [];
  // Skip if no full cite was tracked (i.e., this short form has no
  // recorded antecedent in the document state).
  if (cs.last_full_cite_index < 0) return [];

  // Round 19 — fire only ONCE per case+gap combination to avoid noise on
  // briefs where a central case (e.g., Anderson v. Liberty Lobby) is
  // referenced repeatedly. After we fire the first warning, subsequent
  // short forms with the same gap are silenced until a full-cite refresh.
  if (cs.intervening_count >= 6 && !cs.gap_warning_fired) {
    cs.gap_warning_fired = true;
    const caseName = citation._state_case_short_name || 'this case';
    return [{
      severity: 'review',
      category: 'short_form',
      rule_cite: 'BB R. 10.9',
      table_cite: null,
      message: `Short form to ${caseName} appears after ${cs.intervening_count} intervening citations to other authorities since the last full citation. R. 10.9 — practical guideline is to repeat the full citation after roughly five intervening sources to avoid losing the antecedent.`,
      suggested_fix: null,
    }];
  }
  return [];
}

/**
 * R. 4.2(b) — Hereinafter undeclared.
 *
 * Per R. 4.2(b), a shortened-form reference (e.g., "Exchange Act",
 * "ABA Guide") used in subsequent text must have been declared on first
 * citation via "[hereinafter X]". If a brief uses a phrase like "The
 * Investors Act" as if it were a hereinafter form but no [hereinafter
 * Investors Act] appeared at the introducing citation, fire.
 *
 * Detection scope: this is a DOCUMENT-LEVEL check. We scan the document
 * text for "The <Title-Case Phrase> Act" patterns and check whether each
 * is in the hereinafter_registry. If not, AND the underlying full statute
 * name (e.g., "Investment Advisers Act of 1940") appears earlier without
 * the [hereinafter X] declaration, fire.
 *
 * Implementation runs as a document-level scanner that emits synthetic
 * candidates with pre-attached flags (matching scan-document-issues style).
 */
export function scanHereinafterUndeclared(text) {
  if (!text) return [];
  const flags = [];
  const registry = {};

  // Build the registry from the document.
  const hRe = /\[\s*hereinafter\s+([^\]]{1,80})\s*\]/gi;
  let m;
  while ((m = hRe.exec(text)) !== null) {
    registry[m[1].trim()] = m.index;
  }

  // Scan for "The <Title> Act" subsequent references. Skip when followed
  // by "of YYYY" — that's the FULL citation form ("The X Act of 1940"),
  // not a shortened reference.
  const refRe = /\bThe\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\s+Act\b(?!\s+of\s+\d{4})/g;
  while ((m = refRe.exec(text)) !== null) {
    const ref = `The ${m[1]} Act`;
    const refKey = `${m[1]} Act`;

    // Round 28 — skip when the captured name is 3+ words. Hereinafter
    // shortenings are typically 1-2 words ("Investors Act", "Exchange
    // Act"); 3+-word names are full statutory titles, not abbreviations.
    // Concretely: "The Private Securities Litigation Reform Act" is the
    // CANONICAL FULL NAME (4 words before "Act"), not a hereinafter
    // shortening. Treating it as undeclared produced a false positive on
    // the long-document brief.
    const refWordCount = m[1].split(/\s+/).filter(Boolean).length;
    if (refWordCount >= 3) continue;

    // If "The <X> Act" is registered as a hereinafter form, skip.
    if (registry[refKey] || registry[ref]) continue;

    // Check whether the FULL act name (e.g., "Investment Advisers Act of
    // 1940") appears in the document — that's the original full citation
    // the writer presumably intended this short ref to point to.
    const fullActRe = new RegExp(`\\b[A-Z][a-z]+\\s+(?:[A-Z][a-z]+\\s+){0,4}Act\\s+of\\s+\\d{4}\\b`, 'g');
    let fullMatch;
    let foundFullAct = false;
    while ((fullMatch = fullActRe.exec(text)) !== null) {
      // Skip if the full act name already contains the same word as our ref
      // (i.e., "The Investors Act" subsequently after "Investment Advisers
      // Act of 1940" — the writer has SOME Act earlier but didn't declare
      // a hereinafter form for it). Fire.
      foundFullAct = true;
      break;
    }
    // Also confirm: there's NO matching [hereinafter X] anywhere whose
    // identifying name (first token before " Act") matches our ref's name.
    // E.g., "Exchange Act" declared and "Investors Act" used — different
    // names, so the Investors-Act ref is undeclared.
    let registered = false;
    const refFirstWord = m[1].split(/\s+/)[0]; // "Investors"
    for (const declared of Object.keys(registry)) {
      const declaredName = declared.replace(/\s+Act\b.*$/, '').trim();
      const declaredFirstWord = declaredName.split(/\s+/)[0]; // e.g., "Exchange"
      if (declaredFirstWord === refFirstWord) {
        registered = true;
        break;
      }
    }
    if (registered) continue;

    if (foundFullAct) {
      const start = m.index;
      const end = m.index + m[0].length;
      flags.push({
        pattern_name: 'doc-issue-hereinafter-undeclared',
        provisional_type: 'document_annotation',
        citation_type: 'document_annotation',
        candidate_text: m[0],
        char_start: start,
        char_end: end,
        pre_context: text.slice(Math.max(0, start - 200), start),
        post_context: text.slice(end, Math.min(text.length, end + 200)),
        in_footnote: false,
        footnote_num: null,
        components: {},
        existence: { status: 'not_applicable' },
        flags: [{
          severity: 'non_conforming',
          category: 'short_form',
          rule_cite: 'BB R. 4.2',
          table_cite: null,
          message: `"${ref}" appears to be a shortened-form reference but no "[hereinafter ${m[1]} Act]" designation was declared at the first full citation. R. 4.2(b) requires the shortened form to be declared on first reference (e.g., "The Investment Advisers Act of 1940 [hereinafter Investors Act] addresses...").`,
          suggested_fix: null,
        }],
        candidate_text_hash: 'doc-issue:' + sha256Hex(Buffer.from(m[0] + '|' + start, 'utf8')).slice(0, 16),
      });
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Round 18 — R. 4.1 Id. validators (state-aware short-form rules).
//
// Per Bluebook R. 4.1: "Id." may be used to refer to the IMMEDIATELY
// PRECEDING authority — only when:
//   (a) the immediately preceding citation is a single source (NOT a
//       string cite with multiple authorities), AND
//   (b) no other citation has intervened between the antecedent and
//       this Id.
//
// Detection (per-citation, using pre_context):
//   • If pre_context's last citation sentence (between the prior two
//     sentence boundaries) contains a `;` separator → multi-source
//     string cite → Id. is invalid (R. 4.1).
//
// Conservative bias: only fire when we have HIGH confidence that the
// preceding sentence is a multi-source citation sentence. We skip when
// pre_context doesn't have a clear sentence boundary signal.
// ---------------------------------------------------------------------------
export function validateIdAfterStringCite(citation) {
  if (!citation) return [];
  const type = citation.citation_type || citation.provisional_type;
  if (type !== 'short_form_id') return [];

  // Round 19 — first check the state tracker. If previous_citation is a
  // string cite, fire immediately regardless of pre_context punctuation.
  const prev = citation._state_previous;
  if (prev && prev.is_string_cite) {
    const prevCaseName = prev.case_short_name || 'the preceding citation';
    return [{
      severity: 'non_conforming',
      category: 'short_form',
      rule_cite: 'BB R. 4.1',
      table_cite: null,
      message: `"Id." is invalid here per R. 4.1 — the immediately preceding citation (${prevCaseName}) is part of a string cite with multiple authorities. Id. requires a single antecedent. Use the appropriate short form (e.g., "${prevCaseName}, [reporter] at [page]") instead.`,
      suggested_fix: null,
    }];
  }

  const pre = citation.pre_context || '';
  if (!pre) return [];

  // Find the sentence containing the citation that immediately precedes
  // this Id. — that's the text between the second-most-recent sentence
  // boundary and the most-recent sentence boundary in pre_context.
  //
  // ABBREV-aware boundary detection (mirrors citation-patterns reach-back).
  const ABBREV = new Set([
    'v', 'vs', 'Co', 'Inc', 'Corp', 'Ltd', 'Bros', 'Cir', 'Mfg', 'Univ',
    'Ed', 'Rev', 'Bull', 'Mag',
    'A','B','C','D','E','F','G','H','I','J','K','L','M','N',
    'O','P','Q','R','S','T','U','V','W','X','Y','Z',
    'Mr','Mrs','Ms','Dr','Hon','Prof','Pa','Va','Tex','Cal','Fla',
    'Mass','Mich','Wash','St','Jr','Sr','No','Nos',
    'Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sept','Sep','Oct','Nov','Dec',
    'ed','rev','eds','art','amend',
  ]);
  const boundaries = [];
  const re = /[.;!?]\s+|\n\s*\n/g;
  let m;
  while ((m = re.exec(pre)) !== null) {
    if (m[0].startsWith('\n')) {
      boundaries.push(m.index + m[0].length);
      continue;
    }
    // Period must NOT follow an abbreviation or end with `;` (which is a
    // string-cite separator, not a sentence terminator).
    if (m[0].startsWith(';')) continue; // semicolons are intra-string-cite, not sentence boundaries
    const before = pre.slice(Math.max(0, m.index - 12), m.index);
    const wordMatch = before.match(/([A-Za-z][A-Za-z']*)$/);
    const word = wordMatch ? wordMatch[1] : '';
    if (word && ABBREV.has(word)) continue;
    boundaries.push(m.index + m[0].length);
  }

  if (boundaries.length < 1) return [];

  // The citation sentence immediately preceding the Id. is between the
  // SECOND-most-recent boundary and the MOST-recent boundary.
  const lastBoundary = boundaries[boundaries.length - 1];
  const prevBoundary = boundaries.length >= 2 ? boundaries[boundaries.length - 2] : 0;
  const priorSentence = pre.slice(prevBoundary, lastBoundary);

  // Multi-source detection: prior sentence contains a `; ` separator
  // AND that semicolon is followed by a Cap-word + " v. " (case) or Cap-word + comma (other authority).
  const hasMultipleAuthorities = /;\s+(?:[A-Z][^,]*?\s+v\.|[A-Z][^,]*?,)/.test(priorSentence);
  if (!hasMultipleAuthorities) return [];

  return [{
    severity: 'non_conforming',
    category: 'short_form',
    rule_cite: 'BB R. 4.1',
    table_cite: null,
    message: `"Id." is invalid here per R. 4.1 — the immediately preceding citation is a string cite with multiple authorities. Id. requires a single antecedent. Use the appropriate short form (e.g., "Caseword, V Reporter at P") instead.`,
    suggested_fix: null,
  }];
}

// ---------------------------------------------------------------------------
// Round 18 — R. 4.2(b) hereinafter declaration tracking (document-level).
//
// Per R. 4.2(b): "[hereinafter X]" subsequent references must use the
// declared shortened form. If a brief uses a "The X Act" or similar
// CapName-Title pattern as if it were a hereinafter form WITHOUT having
// declared it, flag.
//
// Implementation: scan the entire document text for "[hereinafter X]"
// declarations and "The Y" subsequent statute-like references. If any
// "The Y" reference doesn't have a corresponding declared X with a
// matching shortname, flag.
//
// This is a DOCUMENT-LEVEL check — handled by scan-document-issues so it
// runs once per document, not per citation.
// ---------------------------------------------------------------------------

/**
 * R. 11 — Constitutional citations.
 *
 * Checks:
 *   • amendment numbers must be Roman ("amend. XIV" not "amend. 14")
 *   • article designation must include period ("art." not "art")
 *   • state-constitution "const." should be capitalized as "Const." per R. 11
 */
export function validateConstitutionalCitation(citation) {
  if (!citation || citation.citation_type !== 'constitutional') return [];
  const text = citation.candidate_text || '';
  if (!text) return [];
  const flags = [];

  // Arabic amendment number: "amend. 14" / "amend 14"
  const arabicAmend = text.match(/\bamend\.?\s+(\d+)\b/);
  if (arabicAmend) {
    const arabicNum = arabicAmend[1];
    const roman = arabicToRoman(parseInt(arabicNum, 10));
    flags.push({
      severity: 'non_conforming',
      category: 'form_components',
      rule_cite: 'BB R. 11',
      table_cite: null,
      message: `Constitutional amendment number "${arabicNum}" must be a Roman numeral per R. 11 (e.g., "amend. ${roman}").`,
      suggested_fix: text.replace(/\b(amend\.?)\s+\d+/, `$1 ${roman}`),
    });
  }

  // "art" or "art " with no period before a Roman numeral
  // Match "art" followed by whitespace + Roman numeral (caps), where
  // there's no period directly after "art".
  const artNoPeriod = text.match(/\bart(?!\.)\s+([IVXLCDM]+)\b/);
  if (artNoPeriod) {
    flags.push({
      severity: 'non_conforming',
      category: 'form_components',
      rule_cite: 'BB R. 11',
      table_cite: null,
      message: `Constitutional article designation "art" must include a period ("art.") per R. 11 / Bluebook abbreviation conventions.`,
      suggested_fix: text.replace(/\bart\s+([IVXLCDM]+)/, 'art. $1'),
    });
  }

  // State constitution with lowercase "const."
  // Pattern: "<State>. const." (lowercase c). U.S. version is the canonical
  // "U.S. Const." — but state cites should also capitalize "Const.".
  const lowerConst = text.match(/\b([A-Z][a-z]+)\.\s+(const\.)/);
  if (lowerConst) {
    flags.push({
      severity: 'non_conforming',
      category: 'capitalization',
      rule_cite: 'BB R. 11',
      table_cite: null,
      message: `Constitution abbreviation "const." must be capitalized as "Const." per R. 11 (e.g., "${lowerConst[1]}. Const.").`,
      suggested_fix: text.replace(/\b([A-Z][a-z]+)\.\s+const\./, '$1. Const.'),
    });
  }

  return flags;
}

function arabicToRoman(n) {
  if (!Number.isFinite(n) || n <= 0 || n > 50) return String(n);
  const map = [
    [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let r = '';
  let v = n;
  for (const [val, sym] of map) {
    while (v >= val) { r += sym; v -= val; }
  }
  return r;
}

/**
 * R. 13.2 — Bill missing congressional session.
 * "S. 510 (2009)" should be "S. 510, 111th Cong. (2009)".
 */
export function validateBillCitation(citation) {
  if (!citation || citation.citation_type !== 'bill') return [];
  const text = citation.candidate_text || '';
  if (!text) return [];
  const flags = [];

  const hasCongSession = /\b\d+(?:st|nd|rd|th)\s+Cong\./.test(text);
  if (!hasCongSession) {
    flags.push({
      severity: 'non_conforming',
      category: 'form_components',
      rule_cite: 'BB R. 13.2',
      table_cite: null,
      message: `Bill citation missing congressional session designation (e.g., "111th Cong.") per R. 13.2. Bills require both bill number and congressional session.`,
      suggested_fix: null,
    });
  }
  return flags;
}

/**
 * R. 13.4 — House/Senate Report missing congressional prefix.
 * "H.R. Rep. No. 1234" should be "H.R. Rep. No. 105-1234" (XXth-NNNN).
 */
export function validateLegislativeReport(citation) {
  if (!citation || citation.citation_type !== 'legislative_report') return [];
  const text = citation.candidate_text || '';
  if (!text) return [];
  const flags = [];

  const reportMatch = text.match(/\b(?:H\.\s*R\.|S\.|H\.R\.)\s*Rep\.\s*No\.\s*(\d+)(?:-(\d+))?/);
  if (reportMatch && !reportMatch[2]) {
    // Only first part matched; missing the "-NNNN" congressional prefix.
    flags.push({
      severity: 'non_conforming',
      category: 'form_components',
      rule_cite: 'BB R. 13.4',
      table_cite: null,
      message: `Committee Report missing congressional session prefix per R. 13.4. Format must be "Rep. No. <Cong>-<Number>" (e.g., "Rep. No. 105-1234").`,
      suggested_fix: null,
    });
  }
  return flags;
}

/**
 * R. 6.2 — Congressional Record page numbers must use comma separators
 * for thousands (e.g., "23,456" not "23456").
 */
export function validateCongressionalRecord(citation) {
  if (!citation || citation.citation_type !== 'cong_rec') return [];
  const text = citation.candidate_text || '';
  if (!text) return [];
  const flags = [];

  const pageMatch = text.match(/Cong\.\s*Rec\.\s+(\d{4,})\b/);
  if (pageMatch) {
    const page = pageMatch[1];
    if (!/,/.test(page)) {
      const formatted = formatNumberWithCommas(page);
      flags.push({
        severity: 'non_conforming',
        category: 'form_components',
        rule_cite: 'BB R. 6.2',
        table_cite: null,
        message: `Congressional Record page number "${page}" should include a comma separator: "${formatted}" per R. 6.2.`,
        suggested_fix: text.replace(page, formatted),
      });
    }
  }
  return flags;
}

function formatNumberWithCommas(s) {
  // Add commas every 3 digits from the right.
  return String(s).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * R. 14.2 — Federal Register validators.
 *   • Page numbers ≥ 4 digits should use comma separators (R. 6.2)
 *   • Volume number must precede "Fed. Reg." per R. 14.2
 */
export function validateFederalRegister(citation) {
  if (!citation || citation.citation_type !== 'fed_reg') return [];
  const text = citation.candidate_text || '';
  if (!text) return [];
  const flags = [];

  // Volume number check: text should match "<vol> Fed. Reg. ..." NOT just "Fed. Reg. <page>".
  const fedRegMatch = text.match(/(\d{1,4})?\s*Fed\.\s*Reg\.\s+([\d,]+)/);
  if (fedRegMatch) {
    const volume = fedRegMatch[1];
    const page = fedRegMatch[2];

    if (!volume) {
      flags.push({
        severity: 'non_conforming',
        category: 'form_components',
        rule_cite: 'BB R. 14.2',
        table_cite: null,
        message: `Federal Register citation is missing the volume number per R. 14.2 (e.g., "88 Fed. Reg. ...").`,
        suggested_fix: null,
      });
    }

    // Page comma check (R. 6.2)
    const bareDigits = page.replace(/,/g, '');
    if (bareDigits.length >= 4 && !/,/.test(page)) {
      const formatted = formatNumberWithCommas(bareDigits);
      flags.push({
        severity: 'non_conforming',
        category: 'form_components',
        rule_cite: 'BB R. 6.2',
        table_cite: null,
        message: `Federal Register page "${page}" should include a comma separator: "${formatted}" per R. 6.2.`,
        suggested_fix: text.replace(page, formatted),
      });
    }
  }

  return flags;
}

// ---------------------------------------------------------------------------
// Round 20 — Foreign / treaty / international-tribunal validators (R. 20,
// R. 21, R. 21.4) and specialty federal court validators (R. 10 / T1).
// ---------------------------------------------------------------------------

/**
 * R. 20 — Foreign case missing court designator or jurisdiction tag.
 *
 * UK cases require a court designator (HL, CA, UKSC, etc.) AND a
 * jurisdiction tag (Eng., UK, Scot., etc.). Australian cases require
 * (Austl.). French cases require (Fr.). German cases require (Ger.).
 *
 * Detection: candidate is provisional_type 'foreign_case'. Inspect
 * candidate text for the relevant tags based on which sub-pattern fired.
 */
export function validateForeignCase(citation) {
  if (!citation) return [];
  if (citation.citation_type !== 'foreign_case' && citation.provisional_type !== 'foreign_case') return [];
  const text = citation.candidate_text || '';
  if (!text) return [];
  const flags = [];

  const patternName = citation.pattern_name || '';

  // UK case: bracket-year + AC/WLR/QB/Ch reporter
  if (patternName === 'foreign_case_uk' || /\[\d{4}\]\s+(?:\d+\s+)?(?:AC|WLR|QB|Ch|All ER)/.test(text)) {
    const hasCourt = /\((?:HL|CA|UKSC|PC|UKHL|Ch|QB|Crim)[^)]{0,30}\)/.test(text);
    // Round 20 — accept jurisdiction tag in either canonical form
    // "(Eng.)" / "(Scot.)" or in "(appeal taken from Scot.)" or
    // "(appeal taken from Eng.)" — both forms are valid per R. 20 / T2.
    const hasJurisdiction = /\((?:[^)]*\b(?:Eng\.|UK|Scot\.|N\.\s*Ir\.|Wales|England|Scotland|Wales|Northern Ireland)[^)]*)\)/.test(text);
    if (!hasCourt) {
      flags.push({
        severity: 'non_conforming',
        category: 'form_components',
        rule_cite: 'BB R. 20',
        table_cite: 'T2',
        message: `UK case missing court designator parenthetical (e.g., "(HL)", "(CA)", "(UKSC)") per R. 20 / Table T2.42.`,
        suggested_fix: null,
      });
    }
    if (!hasJurisdiction) {
      flags.push({
        severity: 'non_conforming',
        category: 'form_components',
        rule_cite: 'BB R. 20',
        table_cite: 'T2',
        message: `Foreign case missing jurisdiction tag (e.g., "(Eng.)") per R. 20 / Table T2.`,
        suggested_fix: null,
      });
    }
  }

  // French case: Cass. ... Bull. civ. — needs (Fr.)
  if (patternName === 'foreign_case_french' || /\bCass\.\s+(?:civ\.|crim\.|com\.|soc\.)/.test(text)) {
    if (!/\(Fr\.\)/.test(text)) {
      flags.push({
        severity: 'non_conforming',
        category: 'form_components',
        rule_cite: 'BB R. 20',
        table_cite: 'T2',
        message: `French case missing jurisdiction parenthetical "(Fr.)" per R. 20 / Table T2.16.`,
        suggested_fix: null,
      });
    }
  }

  // Australian case: parens-year + CLR — needs (Austl.)
  if (patternName === 'foreign_case_aus' || /\(\d{4}\)\s+\d+\s+CLR\b/.test(text)) {
    if (!/\(Austl\.\)/.test(text)) {
      flags.push({
        severity: 'non_conforming',
        category: 'form_components',
        rule_cite: 'BB R. 20',
        table_cite: 'T2',
        message: `Australian case missing jurisdiction parenthetical "(Austl.)" per R. 20 / Table T2.4.`,
        suggested_fix: null,
      });
    }
  }

  // German case: contains BGH or Bundesgerichtshof — needs (Ger.)
  // The German pattern already requires (Ger.) in the regex, so this is a
  // safety check for variants that may have slipped through.
  if (patternName === 'foreign_case_german') {
    if (!/\(Ger\.\)/.test(text)) {
      flags.push({
        severity: 'non_conforming',
        category: 'form_components',
        rule_cite: 'BB R. 20',
        table_cite: 'T2',
        message: `German case missing jurisdiction parenthetical "(Ger.)" per R. 20 / Table T2.18.`,
        suggested_fix: null,
      });
    }
  }

  return flags;
}

/**
 * R. 21.4 — Multilateral treaty validators.
 *
 * Multilateral treaties cite "[Treaty Name] art. X, [date], [vol] U.N.T.S.
 * [page]." The signing date is required.
 */
export function validateMultilateralTreaty(citation) {
  if (!citation) return [];
  if (citation.citation_type !== 'multilateral_treaty' && citation.provisional_type !== 'multilateral_treaty') return [];
  const text = citation.candidate_text || '';
  if (!text) return [];
  const flags = [];

  // Check for signing date in form "Mon. DD, YYYY" or "Mon. YYYY".
  const hasDate = /\b[A-Z][a-z]+\.?\s+\d{1,2},\s+\d{4}\b|\b[A-Z][a-z]+\.?\s+\d{4}\b/.test(text);
  if (!hasDate) {
    flags.push({
      severity: 'non_conforming',
      category: 'form_components',
      rule_cite: 'BB R. 21.4',
      table_cite: null,
      message: `Multilateral treaty citation missing signing date (e.g., "May 23, 1969") before the treaty-series citation per R. 21.4.`,
      suggested_fix: null,
    });
  }

  return flags;
}

/**
 * R. 21.4 — Bilateral treaty validators.
 *
 * Bilateral treaties cite "[Treaty Name], U.S.-[Country], [date], [Stat./
 * T.I.A.S./U.S.T. cite]." A treaty-series citation is required.
 */
export function validateBilateralTreaty(citation) {
  if (!citation) return [];
  if (citation.citation_type !== 'bilateral_treaty' && citation.provisional_type !== 'bilateral_treaty') return [];
  const text = citation.candidate_text || '';
  if (!text) return [];
  const flags = [];

  const hasSeriesCitation = /\b\d+\s+(?:Stat\.|T\.I\.A\.S\.|U\.S\.T\.)\s+[\d,]+/.test(text);
  if (!hasSeriesCitation) {
    flags.push({
      severity: 'non_conforming',
      category: 'form_components',
      rule_cite: 'BB R. 21.4',
      table_cite: null,
      message: `Bilateral treaty citation missing treaty-series citation (e.g., "8 Stat. 116", "12 T.I.A.S. 4567", "5 U.S.T. 100") per R. 21.4. Bilateral treaties require both a date and a series citation.`,
      suggested_fix: null,
    });
  }

  return flags;
}

/**
 * R. 21 — ICJ case validator.
 *
 * ICJ cases require a decision-date parenthetical (e.g., "(Feb. 5)") at end.
 */
export function validateIcjCase(citation) {
  if (!citation) return [];
  if (citation.citation_type !== 'icj_case' && citation.provisional_type !== 'icj_case') return [];
  const text = citation.candidate_text || '';
  if (!text) return [];
  const flags = [];

  // After the page number, an ICJ cite should have "(Mon. DD)" parenthetical.
  // Year is already part of "<year> I.C.J. <page>" — the trailing date is
  // the decision date (just month and day).
  const hasDecisionDate = /\(\s*[A-Z][a-z]+\.?\s+\d{1,2}\s*\)/.test(text);
  if (!hasDecisionDate) {
    flags.push({
      severity: 'non_conforming',
      category: 'form_components',
      rule_cite: 'BB R. 21',
      table_cite: null,
      message: `ICJ case citation missing decision-date parenthetical (e.g., "(Feb. 3)") at end per R. 21.`,
      suggested_fix: null,
    });
  }

  return flags;
}

/**
 * R. 21 — ECHR case validator.
 *
 * ECHR cases require an Application Number ("App. No. NNNNN/NN").
 */
export function validateEchrCase(citation) {
  if (!citation) return [];
  if (citation.citation_type !== 'echr_case' && citation.provisional_type !== 'echr_case') return [];
  const text = citation.candidate_text || '';
  if (!text) return [];
  const flags = [];

  if (!/\bApp\.\s+No\.\s+[\d\/]+/.test(text)) {
    flags.push({
      severity: 'non_conforming',
      category: 'form_components',
      rule_cite: 'BB R. 21',
      table_cite: null,
      message: `ECHR case citation missing Application Number (e.g., "App. No. 37201/06") per R. 21.`,
      suggested_fix: null,
    });
  }

  return flags;
}

/**
 * R. 10 / T1 — Tax Court Memorandum validator.
 *
 * T.C.M. citations require a publisher tag — either "(CCH)" or "(RIA)".
 */
export function validateTcmCase(citation) {
  if (!citation) return [];
  if (citation.citation_type !== 'tcm_case' && citation.provisional_type !== 'tcm_case') return [];
  const text = citation.candidate_text || '';
  if (!text) return [];
  const flags = [];

  if (!/\((?:CCH|RIA)\)/.test(text)) {
    flags.push({
      severity: 'non_conforming',
      category: 'form_components',
      rule_cite: 'BB R. 10',
      table_cite: 'T1',
      message: `Tax Court Memorandum citation missing publisher tag — "(CCH)" or "(RIA)" required after T.C.M. number per R. 10 / T1.`,
      suggested_fix: null,
    });
  }

  return flags;
}

// ---------------------------------------------------------------------------
// runAllValidators
//
//    Convenience entry point used by the pipeline orchestrator. Takes a
//    classified citation (output of Pass 2) and returns the aggregated
//    flag list from every applicable validator. Citation type drives
//    which validators run — short forms skip reporter/court checks, etc.
// ---------------------------------------------------------------------------
/**
 * Round 30 — short-form case citation detector. Single source of truth
 * for "this citation is a short form, validators that operate on the
 * full case-name format must not fire on it."
 *
 * Defense in depth: checks Pass 2's citation_type, the propagated
 * provisional_type (Round 30 — added to classify-citation.js output),
 * AND Pass 1's pattern_name. Any one of these signals means the
 * citation is a short form. This survives Pass 2 LLM misclassification —
 * we observed the LLM tagging "Vivendi, 838 F.3d at 247" as 'case' and
 * "See Anderson, 477 U.S. at 255" as 'case' (the leading "See" signal
 * confused the classifier), which silently bypassed the existing
 * R. 10.4 short-form gate.
 */
export function isShortFormCaseCitation(c) {
  if (!c) return false;
  if (c.citation_type === 'short_form_case') return true;
  if (c.provisional_type === 'short_form_case') return true;
  if (c.pattern_name === 'short_case') return true;
  return false;
}

export function runAllValidators(citation) {
  const flags = [];
  const c = citation || {};
  const components = c.components || {};
  const isShortForm = isShortFormCaseCitation(c);

  if (c.citation_type === 'case' || c.citation_type === 'short_form_case') {
    if (components.case_name) {
      // Round 30 — gate T6 abbreviation check on full forms only. T6
      // applies to the FULL case name (R. 10.2.2). Short forms reference
      // the case name with abbreviation already implied by the
      // antecedent; firing T6 on a short form produces a comment whose
      // "suggested fix" can't be applied (the abbreviated word isn't in
      // the short-form text). The Goldman Sachs FP in the long-document
      // brief — three T6 catches firing on "Goldman Sachs, 594 U.S. at
      // 124" — is the canonical example of this misfire.
      if (!isShortForm) {
        // Pass the full candidate_text so the validator's suggested_fix
        // covers the whole citation span — prevents the markup pipeline
        // from replacing the entire span with just the corrected case
        // name and nuking the volume/reporter/page in the process.
        flags.push(...validateCaseAbbreviations(components.case_name, c.candidate_text));
      }
    }
    if (components.reporter && components.year) {
      flags.push(...validateReporterCurrency(components.reporter, components.year));
    }
    if (components.reporter) {
      // Round 23 — short-form case citations inherit the court designator
      // from their full-cite antecedent per R. 10.9. Don't require the
      // parenthetical on short forms (e.g., "Bosch, 659 F.3d at 1153"
      // when the full cite was "Robert Bosch LLC v. Pylon Mfg. Corp.,
      // 659 F.3d 1142 (Fed. Cir. 2011)" earlier).
      // Round 30 — use the isShortFormCaseCitation helper instead of
      // the inline citation_type/provisional_type check. The previous
      // gate failed when Pass 2 misclassified short forms as 'case'
      // and provisional_type wasn't being propagated through Pass 2.
      if (!isShortForm) {
        flags.push(...validateCourtParenthetical(components.reporter, components.court_parenthetical || null));
      }
    }
  }

  if (c.candidate_text) {
    flags.push(...validateGeographicalAbbreviations(c.candidate_text));
    flags.push(...validateCitationForm(c.candidate_text));
    // Restatement-specific (Pass 1 set citation_type='book' for these).
    if (/\bRestatement\b/.test(c.candidate_text)) {
      flags.push(...validateRestatementForm(c.candidate_text));
    }
    // Corp-suffix comma — Round 6.5 fix: run on EVERY candidate, not
    // just citation_type='case'. Pass 2 sometimes misclassifies, and
    // Inc./LLC/Ltd. appearing anywhere in a citation's case-name span
    // is the trigger we care about. Restricting to 'case' type let
    // "Crestwood Industries Inc." and "Scientific-Atlanta Inc." slip
    // past in the Titan brief.
    flags.push(...validateCorporateCommas(c.candidate_text));
    // Unreported case form (R. 10.8.1).
    flags.push(...validateUnreportedCase(c.candidate_text));
    // Round 13 — short-form abbreviations missing trailing period
    // (R. 6.1 / T6). Runs on every candidate so "Bell Atl, 550 U.S.
    // at 555" gets flagged with the correct rule cite (NOT R. 10.9(a)).
    if (c.citation_type === 'case' || c.citation_type === 'short_form_case') {
      flags.push(...validateShortFormAbbreviationPeriods(c.candidate_text));
    }
  }

  if (c.citation_type === 'periodical' && components.periodical) {
    flags.push(...validatePeriodicalAbbreviation(components.periodical));
  }

  if (c.citation_type === 'case') {
    flags.push(...validateNominativeReporter(c));
  }

  // Round 13 — supra-for-cases check (R. 4.2). Runs on supra short-form
  // candidates regardless of how Pass 2 classified them.
  if (c.citation_type === 'short_form_supra' || c.provisional_type === 'short_form_supra') {
    flags.push(...validateSupraForCase(c));
  }

  // Round 15 — R. 1.2 signal capitalization. Runs on case + short-form-case
  // citations. Uses pre_context to inspect the signal that precedes this
  // citation; flags miscapitalization based on what punctuation precedes
  // the signal (period → capitalize, semicolon/comma → lowercase).
  if (c.citation_type === 'case' || c.citation_type === 'short_form_case' ||
      c.provisional_type === 'case' || c.provisional_type === 'short_form_case') {
    flags.push(...validateSignalCapitalization(c));
  }

  // Round 16 — Secondary-source validators (books, articles, manuscripts,
  // forthcoming, internet). Each only runs on its corresponding type.
  if (c.citation_type === 'book') {
    flags.push(...validateBookCitation(c));
  }
  if (c.citation_type === 'article') {
    flags.push(...validateArticleCitation(c));
  }
  if (c.citation_type === 'manuscript') {
    flags.push(...validateManuscriptCitation(c));
  }
  if (c.citation_type === 'forthcoming') {
    flags.push(...validateForthcomingCitation(c));
  }
  if (c.citation_type === 'internet') {
    flags.push(...validateInternetCitation(c));
  }
  // News-article-missing-URL: runs on ANY candidate (some news cites
  // won't be classified as internet because they lack a URL — that's
  // exactly the violation).
  flags.push(...validateNewsArticleNeedsUrl(c));

  // Round 18 — R. 4.1 Id. after string cite. Runs on short_form_id.
  if (c.citation_type === 'short_form_id' || c.provisional_type === 'short_form_id') {
    flags.push(...validateIdAfterStringCite(c));
    // Round 19 — Id. antecedent state check (R. 4.1 — fires when previous
    // citation is to a different case than the surrounding text discusses).
    flags.push(...validateIdAntecedent(c));
  }

  // Round 19 — R. 10.9 short-form-gap (advisory). Runs on case short forms.
  if (c.citation_type === 'short_form_case' || c.provisional_type === 'short_form_case') {
    flags.push(...validateShortFormGap(c));
  }

  // Round 20 — Foreign / treaty / tribunal / specialty validators
  if (c.citation_type === 'foreign_case' || c.provisional_type === 'foreign_case') {
    flags.push(...validateForeignCase(c));
  }
  if (c.citation_type === 'multilateral_treaty' || c.provisional_type === 'multilateral_treaty') {
    flags.push(...validateMultilateralTreaty(c));
  }
  if (c.citation_type === 'bilateral_treaty' || c.provisional_type === 'bilateral_treaty') {
    flags.push(...validateBilateralTreaty(c));
  }
  if (c.citation_type === 'icj_case' || c.provisional_type === 'icj_case') {
    flags.push(...validateIcjCase(c));
  }
  if (c.citation_type === 'echr_case' || c.provisional_type === 'echr_case') {
    flags.push(...validateEchrCase(c));
  }
  if (c.citation_type === 'tcm_case' || c.provisional_type === 'tcm_case') {
    flags.push(...validateTcmCase(c));
  }

  // Round 17 — Official-source validators
  if (c.citation_type === 'constitutional') {
    flags.push(...validateConstitutionalCitation(c));
  }
  if (c.citation_type === 'bill') {
    flags.push(...validateBillCitation(c));
  }
  if (c.citation_type === 'legislative_report') {
    flags.push(...validateLegislativeReport(c));
  }
  if (c.citation_type === 'cong_rec') {
    flags.push(...validateCongressionalRecord(c));
  }
  if (c.citation_type === 'fed_reg') {
    flags.push(...validateFederalRegister(c));
  }

  return flags;
}
