/**
 * Citation Verifier — Pass 1 deterministic patterns.
 *
 * Per BUILD_SPEC §7 (Pass 1: extraction):
 *   "Find anything that looks like a citation. High recall, low precision is OK.
 *    Pass 2 (LLM) does the actual classification."
 *
 * This module exports a small set of broad regex matchers that scan plain
 * text and return raw "candidate" objects. A candidate is a span of text
 * (with offsets) that the classifier should look at — it is NOT yet
 * classified as case / statute / regulation / etc. That is Pass 2's job.
 *
 * NEVER expand a regex to "be smart" about what's inside parentheses or
 * commas. Pass 1 is intentionally dumb. If we miss a candidate at Pass 1
 * we LOSE the citation entirely, so when in doubt, flag it.
 *
 * Design notes
 * ------------
 *   • All patterns are global (/g) so we can iterate matches with offsets.
 *   • All patterns are case-sensitive — a lowercase "id" inside a normal
 *     word is not the short form "Id." Citation short forms are
 *     orthography-specific.
 *   • We return char_start / char_end as half-open ranges relative to the
 *     input text (Bluebook tables and PDF page maps use the same ranges).
 *   • We DO NOT dedupe overlapping matches here — Pass 2's classifier
 *     resolves overlaps with full context.
 */

// ---------------------------------------------------------------------------
// Reporter abbreviations — Bluebook T1 + T1.3 (federal) and selected regional
// reporters from T1.3. NOT exhaustive (state-specific reporters are added
// as we encounter them in the test corpus). The pattern is escaped for
// inclusion in a regex character class — note the `\\.` escapes.
//
// IMPORTANT: ordering matters. Longer patterns must precede shorter ones
// in the alternation so "F. Supp. 2d" wins over "F. Supp." Also, "Cal."
// before "Cal" prevents partial matches.
// ---------------------------------------------------------------------------
// Reporter alternation. Includes both canonical Bluebook forms AND
// common malformed variants (e.g., "US" without periods). Pass 1 needs
// to detect malformed cites at all so Pass 3 can flag the form error;
// if the regex required perfect form, malformed citations would slip
// past the entire pipeline silently.
const REPORTERS = [
  // --- Federal: Supreme Court (canonical first; malformed last)
  'U\\.S\\.',
  'S\\. ?Ct\\.',
  'L\\. ?Ed\\. ?2d',
  'L\\. ?Ed\\.',
  // --- Federal: courts of appeals
  'F\\.4th',
  'F\\.3d',
  'F\\.2d',
  'F\\.',
  "Fed\\. ?App\\'?x\\.",
  // --- Federal: district / specialty
  'F\\. ?Supp\\. ?3d',
  'F\\. ?Supp\\. ?2d',
  'F\\. ?Supp\\.',
  'F\\.R\\.D\\.',
  'B\\.R\\.',
  'Bankr\\.',
  'T\\.C\\.',
  // --- Regional reporters
  'A\\.3d', 'A\\.2d', 'A\\.',
  'P\\.3d', 'P\\.2d', 'P\\.',
  'N\\.E\\.3d', 'N\\.E\\.2d', 'N\\.E\\.',
  'N\\.W\\.3d', 'N\\.W\\.2d', 'N\\.W\\.',
  'S\\.E\\.2d', 'S\\.E\\.',
  'S\\.W\\.3d', 'S\\.W\\.2d', 'S\\.W\\.',
  'So\\. ?3d', 'So\\. ?2d', 'So\\.',
  // --- California
  'Cal\\. ?Rptr\\. ?3d', 'Cal\\. ?Rptr\\. ?2d', 'Cal\\. ?Rptr\\.',
  'Cal\\. ?App\\. ?5th', 'Cal\\. ?App\\. ?4th',
  'Cal\\. ?App\\. ?3d', 'Cal\\. ?App\\. ?2d', 'Cal\\. ?App\\.',
  'Cal\\. ?5th', 'Cal\\. ?4th', 'Cal\\. ?3d', 'Cal\\. ?2d', 'Cal\\.',
  // --- New York
  'N\\.Y\\.3d', 'N\\.Y\\.2d', 'N\\.Y\\.',
  'A\\.D\\.3d', 'A\\.D\\.2d', 'A\\.D\\.',
  'N\\.Y\\.S\\.3d', 'N\\.Y\\.S\\.2d', 'N\\.Y\\.S\\.',
  'Misc\\. ?3d', 'Misc\\. ?2d', 'Misc\\.',
  // --- Texas
  'Tex\\.',
  // --- Illinois
  'Ill\\. ?2d', 'Ill\\. ?App\\. ?3d', 'Ill\\.',
  // --- Massachusetts
  'Mass\\. ?App\\. ?Ct\\.', 'Mass\\.',
  // --- Foreign / parallel reporters (per BB R. 21 / T2)
  'Eng\\. ?Rep\\.',
  'Ex\\.',  // English Exchequer Reports — appears in old common-law cites like "9 Ex. 341"
  // --- MALFORMED variants (last in alternation so canonical wins).
  // These let Pass 1 detect period-omitting citations like "556 US 662"
  // and "466 U.S 408" (one trailing period missing) so Pass 3 can flag
  // the form error. Without these, a non-conforming citation slips
  // past the entire pipeline.
  'U\\.S(?!\\.)',             // "U.S" with NO trailing period (helicopteros 466 U.S 408)
  'US',                       // for "U.S." with both periods dropped (Skinner 562 US 521)
  'F\\.?\\s?2d', 'F\\.?\\s?3d', 'F\\.?\\s?4th', // tolerates "F 3d" / "F3d" spacing variants
];

// Reporter alternation — longer abbreviations first (already ordered above).
const REPORTERS_ALT = REPORTERS.join('|');

// ---------------------------------------------------------------------------
// PATTERN 1 — Volume Reporter Page (the bread-and-butter case cite)
//
// Matches anything that looks like:   123 F.3d 456    410 U.S. 113    100 Cal. App. 4th 12
//
// Captures only the volume/reporter/page span. Pass 2 will reach backward
// for the case name and forward for the parenthetical (court, year).
// ---------------------------------------------------------------------------
// Round 14 — page-pin span allows MULTIPLE comma/dash/en-dash separators
// so the candidate captures both "317, 322-23" AND lone "322-23". Without
// the trailing repeat, REPORTER_PATTERN truncated "317, 322-23" at "317, 322"
// (the "-23" was left out of candidate_text), causing R. 3.2(a) en-dash
// validator to silently miss the hyphen.
// Round 24 — accept em dash (U+2014) in addition to hyphen and en dash.
// Word auto-correct produces em dash from "--", and real briefs frequently
// contain em-dash pin ranges where en dashes belong. Without em dash in
// the page-pin character class, Pass 1 truncated candidates at the em
// dash and the R. 3.2(a) validator never saw the violation.
export const REPORTER_PATTERN = new RegExp(
  `\\b(\\d{1,4})\\s+(${REPORTERS_ALT})\\s+(\\d{1,5}(?:[\\-\\u2013\\u2014,]\\s*\\d{1,5})*)`,
  'g'
);

// ---------------------------------------------------------------------------
// PATTERN 2 — Statute (federal U.S.C. + state codes)
//
// Matches:
//   42 U.S.C. § 1983
//   29 U.S.C. §§ 201-219
//   Cal. Penal Code § 187
//   N.Y. Educ. Law § 3001
// ---------------------------------------------------------------------------
export const USC_PATTERN = new RegExp(
  // Accept canonical "U.S.C." OR malformed "USC" (no periods). Section
  // symbol is OPTIONAL because the user's draft may be missing it
  // entirely — e.g., "28 USC 1331" — and we want Pass 3 to flag the
  // omission rather than slip past Pass 1 detection.
  `\\b(\\d{1,3})\\s+(?:U\\.S\\.C\\.|USC)\\s+(?:§{1,2}\\s?)?[\\d\\-\\(\\)\\.a-zA-Z]+`,
  'g'
);

// State statute pattern is loose by design — lots of variation across
// states. We anchor on "Code", "Stat.", "Laws", "Ann." plus "§".
export const STATE_STATUTE_PATTERN = new RegExp(
  `\\b(?:Cal\\.|N\\.Y\\.|Tex\\.|Fla\\.|Mass\\.|Ill\\.|Ohio|Pa\\.|Va\\.|Mich\\.|Ga\\.|N\\.C\\.|N\\.J\\.|Conn\\.|Md\\.|Wash\\.|Or\\.|Colo\\.|Ariz\\.|Ind\\.|Tenn\\.|Mo\\.|Wis\\.|Minn\\.) +[A-Z][a-zA-Z\\.]+(?: +[A-Z][a-zA-Z\\.]+)? +(?:Code|Stat\\.|Law|Laws|Ann\\.)(?: +Ann\\.)? +§{1,2} ?[\\d\\-\\(\\)\\.a-zA-Z]+`,
  'g'
);

// ---------------------------------------------------------------------------
// PATTERN 3 — Regulation (C.F.R.)
//
// Matches:   29 C.F.R. § 1630.2(g)
// ---------------------------------------------------------------------------
export const CFR_PATTERN = new RegExp(
  // Same tolerance as USC_PATTERN — accepts "C.F.R." or "CFR".
  `\\b(\\d{1,3})\\s+(?:C\\.F\\.R\\.|CFR)\\s+(?:§{1,2}\\s?)?[\\d\\-\\(\\)\\.a-zA-Z]+`,
  'g'
);

// ---------------------------------------------------------------------------
// PATTERN 4 — Constitutional citations
//
// Matches:
//   U.S. Const. art. I, § 8, cl. 3
//   U.S. Const. amend. XIV
//   Cal. Const. art. I, § 13
// ---------------------------------------------------------------------------
export const CONST_PATTERN = new RegExp(
  `\\b(?:U\\.S\\.|[A-Z][a-z]+\\.) +Const\\.(?: +(?:art\\.|amend\\.) +[IVXLCDM\\d]+)?(?:,? +§ ?\\d+)?(?:,? +cl\\. ?\\d+)?`,
  'g'
);

// ---------------------------------------------------------------------------
// PATTERN 5 — Short form: Id.
//
// Matches:   Id.    Id. at 123    Id. at 456-57
// We do NOT match lower-case "id" — that's not a Bluebook short form.
// ---------------------------------------------------------------------------
// Round 24 — accept en dash (U+2013) and em dash (U+2014) in addition to
// ASCII hyphen, so "Id. at 49—50" / "Id. at 740-41" candidates capture the
// full pin range and the R. 3.2(a) validator can flag the dash variant.
export const ID_PATTERN = /\bId\.(?: +at +\d{1,5}(?:[\-–—,]\s*\d{1,5})?)?/g;

// ---------------------------------------------------------------------------
// PATTERN 6 — Short form: supra
//
// Matches:   <Name>, supra note 5    <Name>, supra
// We capture a backward window of up to ~80 chars to give Pass 2 enough
// context to identify which earlier citation `supra` refers to.
// ---------------------------------------------------------------------------
// Round 14 — capture the lead-in case-name BEFORE "supra" so the candidate
// has enough text for markup-docx to anchor (8-char minimum). Pattern matches:
//   Iqbal, supra, at 679
//   Iqbal, supra
//   supra note 5
//   supra at 679
//
// Round 18 — extend lead-in to include treatise patterns like
//   "5B Wright & Miller, supra, § 1357"
//   "Burbank, supra, at 115"
// Lead-in now allows: optional volume number + first cap word + multiple
// (cap-word | & | "of" | "the" | "and") connectors.
export const SUPRA_PATTERN = new RegExp(
  '(?:\\b(?:\\d{1,4}[A-Z]?\\s+)?[A-Z][A-Za-z\'\\.\\-]+' +
    '(?:\\s+(?:[A-Z][A-Za-z\'\\.\\-]+|&|of|the|and)){0,5},\\s+)?' +              // optional lead-in (case OR treatise/article)
  '\\bsupra' +
  '(?:\\s+note\\s+\\d{1,4})?' +                                                  // " note 5"
  '(?:[,\\s]+at\\s+\\d{1,5}(?:[\\-\\u2013,]\\s*\\d{1,5})*)?',                    // ", at 679" / " at 679-80"
  'g'
);

// ---------------------------------------------------------------------------
// PATTERN 6.5 — Federal Rules of Civil/Criminal/Appellate Procedure +
//                Federal Rules of Evidence
//
// Matches:
//   Fed. R. Civ. P. 12(b)(2)
//   Fed. R. Crim. P. 41
//   Fed. R. Evid. 403
//   Fed. R. App. P. 4(a)
//   FRCP 12(b)(6)         — non-conforming shorthand, but we MUST detect
//                           it so Pass 3 can flag the form error.
//   F.R.C.P. 12(b)(2)     — another non-conforming variant
// ---------------------------------------------------------------------------
// Federal Rules pattern. Accepts the canonical "Fed. R. Civ. P.", the
// no-periods "Fed R Civ P", malformed "F.R.Civ.P.", and the four-letter
// shorthands FRCP/FRCrP/FRAP/FRE. Pass 3's validator is the source of
// truth for which forms are flagged; Pass 1's job is just to detect.
//
// Round 6.3 fix: the previous regex required periods after Fed./R./P.
// — "Fed R Civ P 8(a)(2)" slipped through Pass 1 entirely. Periods
// are now optional via `\\.?`.
export const RULES_PATTERN = new RegExp(
  '\\b(?:' +
    'Fed\\.?\\s*R\\.?\\s*(?:Civ|Crim|App|Evid)\\.?\\s*P\\.?|' +  // periods OPTIONAL — Pass 3 flags missing
    'F\\.R\\.(?:Civ|Crim|App|Evid)\\.P\\.|' +
    'FRCP|FRCrP|FRAP|FRE' +
  ')\\s*\\d+(?:\\([a-z0-9]+\\))*',
  'g'
);

// ---------------------------------------------------------------------------
// PATTERN 6.6 — Restatement (Rule 12.9.5)
//
// Matches:
//   Restatement (Second) of Contracts § 351 (Am. L. Inst. 1981)
//   Restatement 2d Contracts §351                — non-conforming
//   Restatement (Third) of Torts: Phys. & Emot. Harm § 9
// ---------------------------------------------------------------------------
// Restatement pattern. Round 6.11 fix: the "of" was incorrectly listed
// as an alternative in the SERIES group, which meant "Restatement of
// Restitution..." would consume " of" as the series, then the next
// "(?:\\s+of\\s+\\w+...)" group couldn't match because there's no
// second "of" — and Pass 1 cut the candidate off at just "Restatement
// of" (~14 chars), causing Pass 3 to see no publisher/year and fire a
// false-positive flag.
//
// New layout: SERIES is only the parenthesized form OR "2d/3d/4th"
// (no "of"). The "of <subject>" group handles "of" exclusively. This
// makes "Restatement of Restitution and Unjust Enrichment § 1
// (Am. L. Inst. 2011)" capture in full so Pass 3 can correctly see
// the (Am. L. Inst. 2011) parenthetical.
// Round 11 — restructured to capture more variants:
//   • Subject "of" is now optional ("Restatement 2d Contracts §351"
//     in Acme — the brief wrote it WITHOUT "of"). Previously the
//     regex required "of" and truncated the candidate at "Restatement
//     2d", which dropped the "§351" out of candidate_text and caused
//     validateCitationForm's § spacing check to silently miss the
//     "§351 should be § 351" violation. That was the eighth Acme
//     catch the user flagged as regressed.
//   • § may be preceded by zero spaces (`\s*§` instead of `\s+§`)
//     in case the subject group consumed all trailing whitespace.
// Round 28 — anchor the Restatement extractor on one of THREE structural
// markers so prose / news headlines containing the word "Restatement"
// don't produce bogus candidates:
//
//   (A) canonical series designator:    "Restatement (First|Second|Third|Fourth)"
//   (B) short-form series:              "Restatement 2d|3d|4th"
//   (C) "of <Subject> § <num>" form:    "Restatement of Restitution § 1"
//                                       (preserves the legitimate R. 12.9.5
//                                        catch on series-LACKING Restatement
//                                        citations that include § + subject)
//
// Without any of these anchors the candidate is just a bare-word match
// and we silently skip it. This eliminates the WSJ-headline false
// positive ("Reserve Restatement, Wall St. J.") while keeping every
// legitimate Restatement citation form — including the non-conforming
// ones (anchor C) that the validator must still flag.
//
// Round 28 — also extend the post-section tail to consume comment/
// illustration/note pinpoints AND the publisher parenthetical. The old
// pattern stopped at the subject's first non-`\w&` character (e.g., the
// `:` in "Restatement (Third) of Torts: Liab. for Econ. Harm § 9 cmt. b
// (Am. L. Inst. 2020)"), which truncated candidate_text to 28 chars and
// hid the (Am. L. Inst. 2020) parenthetical from validateRestatementForm
// — causing the validator to falsely flag a properly-formatted citation
// as missing its publisher.
export const RESTATEMENT_PATTERN = new RegExp(
  '\\bRestatement\\s+(?:' +
    // Anchor A: canonical "(First|Second|Third|Fourth)"
    '\\((?:First|Second|Third|Fourth)\\)' +
    // OR Anchor B: short series "2d|3d|4th"
    '|(?:2d|3d|4th)\\b' +
    // OR Anchor C: "of <Subject> § <num>" without series — the
    // subject+section combination is structural enough to confirm a
    // real Restatement citation (and the validator will fire R. 12.9.5
    // for the missing series).
    '|of\\s+[A-Z][\\w&\\-]*(?:\\s+[\\w&.\\-]+)*?\\s*§{1,2}\\s?\\d' +
  ')' +
  '(?:\\s+(?:of\\s+)?[A-Z][\\w&\\-]*(?:[:,]?\\s+[\\w&.\\-]+)*)?' +    // subject incl. ":Liab. for Econ. Harm"
  '(?:\\s*§{1,2}\\s?\\d+(?:[a-z]|\\.\\d+)?)?' +                       // "§ 351" / "§351" / "§ 9.04"
  '(?:\\s+(?:cmt\\.?|illus\\.?|n\\.|note)\\s+[a-z\\d]+)?' +            // "cmt. b" / "illus. 4" / "n. 12"
  '(?:\\s+\\([^)]{0,80}\\))?',                                         // "(Am. L. Inst. 2020)"
  'g'
);

// ---------------------------------------------------------------------------
// PATTERN 6.7 — Unreported / Westlaw cases (Rule 10.8.1)
//
// Matches: 2019 WL 4567321
//          2020 LEXIS 5678
// Pass 2 flags missing pinpoint + decision date per R. 10.8.1.
// ---------------------------------------------------------------------------
export const UNREPORTED_PATTERN = new RegExp(
  '\\b(\\d{4})\\s+(?:WL|U\\.S\\. App\\. LEXIS|LEXIS)\\s+\\d+(?:,\\s+at\\s+\\*\\d+)?',
  'g'
);

// ---------------------------------------------------------------------------
// PATTERN 7 — Short-form case (e.g.,  Brown, 347 U.S. at 495)
//
// Matches a name followed by ", <volume> <reporter> at <page>"
// This will overlap with REPORTER_PATTERN; Pass 2 reconciles.
// ---------------------------------------------------------------------------
export const SHORT_CASE_PATTERN = new RegExp(
  `\\b[A-Z][A-Za-z\\-']+(?:,?\\s+[A-Z][A-Za-z\\-']+){0,3},\\s+(\\d{1,4})\\s+(${REPORTERS_ALT})\\s+at\\s+(\\d{1,5}(?:[\\-,]\\s*\\d{1,5})?)`,
  'g'
);

// ---------------------------------------------------------------------------
// All patterns, with the citation_type they map to. Pass 1 outputs only
// `provisional_type` here — Pass 2 issues the final citation_type after
// reading the full surrounding sentence.
// ---------------------------------------------------------------------------
const PATTERN_REGISTRY = [
  { name: 'reporter',         regex: REPORTER_PATTERN,      provisional_type: 'case' },
  { name: 'unreported',       regex: UNREPORTED_PATTERN,    provisional_type: 'case' },
  { name: 'short_case',       regex: SHORT_CASE_PATTERN,    provisional_type: 'short_form_case' },
  { name: 'usc',              regex: USC_PATTERN,           provisional_type: 'statute' },
  { name: 'state_statute',    regex: STATE_STATUTE_PATTERN, provisional_type: 'statute' },
  { name: 'cfr',              regex: CFR_PATTERN,           provisional_type: 'regulation' },
  { name: 'constitutional',   regex: CONST_PATTERN,         provisional_type: 'constitutional' },
  { name: 'rules',            regex: RULES_PATTERN,         provisional_type: 'court_document' },
  { name: 'restatement',      regex: RESTATEMENT_PATTERN,   provisional_type: 'book' },
  { name: 'id',               regex: ID_PATTERN,            provisional_type: 'short_form_id' },
  { name: 'supra',            regex: SUPRA_PATTERN,         provisional_type: 'short_form_supra' },
];

/**
 * Reach backward from a citation's char_start to capture the case-name span
 * that immediately precedes "v.". Returns the expanded char_start, or the
 * original char_start if no "v." was found within the look-back window.
 *
 * Examples (input → returned span):
 *   "Brown v. Board, 347 U.S. 483"  →  starts at "B" of Brown
 *   "as held in 410 U.S. 113"       →  starts at "4" (original)
 *
 * This helps Pass 2 by giving it the case name in the candidate_text up
 * front. We DO NOT try to parse the case name here — Pass 2's prompt is
 * trained on exactly that.
 */
// Known Bluebook abbreviations whose trailing period is NOT a sentence
// boundary. Includes the versus marker "v" and one-letter initials so
// "Cohens v. Virginia" / "U.S." / "P. Smith" don't get mis-split.
const ABBREV_WORDS = new Set([
  // Versus + initials
  'v', 'vs',
  // Round 28 — relator markers. "Starr ex rel. Estate of Sampson v.
  // Georgeson Shareholder, Inc." — the period after "rel." is NOT a
  // sentence boundary; it's the abbreviation of "relatione". Without
  // this entry, findLatestSentenceBoundary skipped past "ex rel. " and
  // the case-name walk-back lost "Starr ex rel." from the candidate.
  'rel', 'ex',
  'A','B','C','D','E','F','G','H','I','J','K','L','M',
  'N','O','P','Q','R','S','T','U','V','W','X','Y','Z',
  // Common entity-name abbreviations (Bluebook T6)
  'Co', 'Inc', 'Corp', 'Ltd', 'Bros', 'Cir', 'Mfg', 'Mfr', 'Univ',
  'Bd', 'Educ', 'Hosp', 'St', 'Jr', 'Sr', 'Mr', 'Mrs', 'Ms', 'Dr',
  "Ass'n", "Comm'n", "Dep't", 'Indus', 'Indem', 'Mach', 'Servs',
  'Tech', 'Sec', 'Ins', 'Inv', 'Med', 'Pharm', 'Loc',
  'Cnty', 'Mun', 'Cal', 'Fla', 'Tex', 'Mass', 'Ill', 'Wash',
  'Va', 'Pa', 'Md', 'Conn', 'Mich', 'Wisc', 'Wis', 'Minn',
  'Mo', 'Ky', 'Tenn', 'Ga', 'Ala', 'Miss', 'La', 'Ark',
  'Okla', 'Kan', 'Neb', 'Iowa', 'Idaho', 'Mont', 'Wyo',
  'Colo', 'Ariz', 'Nev', 'Or', 'Vt', 'Me', 'Del', 'Haw',
  'Conf', 'Cong', 'Const', 'Const\'l', 'Crim', 'Civ', 'App',
  'Evid', 'Stat', 'Ann', 'Rev', 'Reg', 'No', 'Nos',
  // Reporters / cite-internal abbreviations
  'F', 'Supp', 'Ct', 'Ed', 'Wheat', 'Cranch', 'Pet', 'Dall',
  'How', 'Black', 'Wall', 'Cl', 'Cls',
  // Round 22 — additional T6 case-name abbreviations whose terminating
  // period was being treated as a sentence boundary. Specifically `Ry.`
  // (Railway) caused "Burlington N. & Santa Fe Ry. Co. v. White" to lose
  // its plaintiff portion in suggested-fix output. Rather than handle
  // each as it surfaces, enumerate the full T6 abbreviation set.
  'Acad', 'Accid', 'Acct', 'Acquis', 'Actuar', 'Adjust', 'Admin', 'Adver',
  'Agric', 'Alt', 'Am', 'Assoc', 'Atl', 'Auth', 'Auto', 'Ave',
  'Bankr', 'Bhd', 'Bus', 'Cas', 'Cent', 'Chem', 'Cmty', 'Coal',
  'Coll', 'Comm', 'Comp', 'Condo', 'Consol', 'Constr', 'Coop', 'Cos',
  'Ctr', 'Def', 'Det', 'Dev', 'Dir', 'Disc', 'Dist', 'Distrib', 'Div',
  'Econ', 'Elec', 'Emp', 'Enter', 'Envtl', 'Equal', 'Equip', 'Equit',
  'Equiv', 'Exch', 'Exec', 'Fed', 'Fid', 'Fin', 'Found', 'Gen',
  'Grad', 'Grp', 'Guar', 'Hous', 'Imp', 'Info', 'Inst',
  'Liab', 'Litig', 'Mag', 'Maint', 'Mech', 'Merch', 'Metro', 'Mgmt',
  'Mkt', 'Mktg', 'Mortg', 'Mut', 'Nat', 'Ne', 'Nw', 'Org', 'Pac',
  'Pers', 'Petrol', 'Pl', 'Pro', 'Prob', 'Proc', 'Prod', 'Prop',
  'Prot', 'Pub', 'Rd', 'Reins', 'Reprod', 'Res', 'Reserv', 'Rest',
  'Ret', 'Ry', 'Sav', 'Sch', 'Sci', 'Se', 'Soc', 'Subcomm', 'Sur',
  'Sw', 'Sys', 'Tel', 'Tele', 'Telecomm', 'Transcon', 'Transp',
  'Twp', 'Util', 'Vill', 'Broad',
]);

/**
 * Find the LATEST genuine sentence boundary in the window — i.e., the
 * latest "<period|semicolon><whitespace>" or "<newline>" that's NOT
 * an abbreviation period (Co., Inc., v., U.S., etc.).
 *
 * Returns the offset (within the window) just past the boundary, or 0
 * if no boundary exists.
 */
function findLatestSentenceBoundary(window) {
  let lastEnd = 0;
  // Match every period or semicolon followed by whitespace, plus bare
  // newlines. Filter out periods that follow a known abbreviation word.
  // This catches sentence ends like "Rule 12(b)(6). " (where ")" before
  // the period is not a letter) without false-positiving on "Co. " or
  // "v." inside case names.
  const re = /[.;]\s+|\n+/g;
  let m;
  while ((m = re.exec(window)) !== null) {
    if (m[0].startsWith('\n')) {
      lastEnd = m.index + m[0].length;
      continue;
    }
    // Extract the alphanumeric/apostrophe-bearing word ending right
    // before the period. If that word is in the abbreviation set,
    // this isn't a real sentence boundary — skip.
    const before = window.slice(Math.max(0, m.index - 12), m.index);
    const wordMatch = before.match(/([A-Za-z][A-Za-z']*)$/);
    const word = wordMatch ? wordMatch[1] : '';
    if (word && ABBREV_WORDS.has(word)) continue;
    // Round 27 — dotted multi-letter abbreviations (d.b.a., f.k.a.,
    // n.k.a., a.k.a., and similar). The trailing `.` looks like a
    // sentence boundary but it's actually the last dot of a multi-dot
    // case-name marker. If the 12-char lookback ends with a
    // letter-dot-letter-dot-letter pattern, the period is part of an
    // abbreviation, not a sentence terminator.
    if (/[A-Za-z]\.[A-Za-z]\.[A-Za-z]$/i.test(before)) continue;
    lastEnd = m.index + m[0].length;
  }
  return lastEnd;
}

function reachBackForCaseName(text, charStart) {
  const LOOKBACK = 250;
  const windowStart = Math.max(0, charStart - LOOKBACK);
  const window = text.slice(windowStart, charStart);

  // Round 6.13 — find LATEST boundary, but skip abbreviation periods.
  // Without this filter, " v. " inside a case name was treated as a
  // sentence boundary, anchoring reach-back AFTER the case name (e.g.,
  // for "Cohens v. Virginia, 19 U.S. 264", reach-back stopped at
  // "Virginia," and the candidate ended up just "19 U.S. 264 (1821)"
  // with no case name). Same for "Co.", "Inc.", "U.S." inside cites.
  let cursor = findLatestSentenceBoundary(window);

  // 2. Optionally consume a leading signal. Round 15 — case-insensitive
  //    so mixed-case mistakes (e.g., "but Cf.", "With", "contra") still
  //    get stripped from candidate_text, leaving them in pre_context where
  //    validateSignalCapitalization can flag them per R. 1.2.
  const sigRe = /^(?:see also|see, e\.g\.|see|but see|but cf|cf|contra|compare|accord|e\.g\.|with|and)\.?,?\s+/i;
  const post = window.slice(cursor);
  const sigMatch = post.match(sigRe);
  if (sigMatch) cursor += sigMatch[0].length;

  const remaining = window.slice(cursor);

  // 3. Round 14 — try " v. " case-name reach-back FIRST, then fall back to
  //    "In re X" / "Ex parte X" / "Matter of X" patterns (which have no
  //    versus marker but are still valid case names).
  const vMatch = remaining.match(/\s+(?:v\.|v\b|vs\.|vs\b)\s+/);
  if (vMatch) {
    // 3a. Refine: walk back from " v. " through capitalized words +
    //     connectors only, so candidate_text doesn't include lead-in
    //     prose like "The complaint must be dismissed under...".
    const refinedOffset = refineCaseNameStartFromV(remaining, vMatch.index);
    if (refinedOffset == null) return charStart;
    return windowStart + cursor + refinedOffset;
  }

  // 3b. "In re X" / "Ex parte X" / "Matter of X" — no versus marker.
  //     These are valid case names. Find the LAST occurrence in the window
  //     so reach-back lands on the citation's case name (not an earlier one
  //     that may also appear in the lookback window). Allow periods in the
  //     case name because abbreviations like "Inc." or "Sec." commonly
  //     appear (e.g., "In re Charter Communications, Inc., Sec. Litig.").
  const inReRe = /\b(?:In re|Ex parte|In the Matter of|Matter of|Petition of|Application of|Estate of)\b\s+[A-Z]/g;
  let lastInRe = null;
  let _m;
  while ((_m = inReRe.exec(remaining)) !== null) lastInRe = _m;
  if (lastInRe) {
    return windowStart + cursor + lastInRe.index;
  }

  return charStart;
}

/**
 * Round 14 — refine the case-name START by walking backward from " v. "
 * through capitalized words and case-name connectors only.
 *
 * Connectors (of, the, and, &, in, for, to, on, by) are part of a case
 * name only when SURROUNDED by capitalized words. A standalone lowercase
 * "in" preceded by a regular sentence word is not a case-name connector.
 *
 * Returns the offset of the case-name START within `remaining`, or null
 * if no plausible case-name span found.
 *
 * Examples:
 *   remaining = "The complaint must be dismissed under the standard
 *                articulated in Bell Atlantic Corp. v. Twombly, 550..."
 *   vIdx = position of " v. "
 *   Walk back through "Corp.", "Atlantic", "Bell" (all cap) — include.
 *   Hit "in" (lowercase connector) — peek prev word "articulated" (lowercase
 *     non-connector) — NOT a case-name connector — stop.
 *   Return offset of "Bell".
 */
function refineCaseNameStartFromV(remaining, vIdx) {
  const beforeV = remaining.slice(0, vIdx);
  // Tokenize into words with offsets.
  const tokens = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(beforeV)) !== null) {
    tokens.push({ word: m[0], start: m.index });
  }
  if (tokens.length === 0) return null;

  const CONNECTORS = new Set(['of', 'the', 'and', '&', 'in', 'for', 'to', 'on', 'by', 'de', 'la', 'el', 'du', 'des']);

  // Round 27 — case-name internal markers that legitimately appear between
  // two capitalized party names. Walk-back must not stop on these even
  // though they're lowercase. The classic failure case is the d/b/a
  // ("doing business as") form: "Robertson, Inc., d/b/a Robertson
  // Industries v. Cromwell" — without this set, the walk stops at the
  // lowercase "d/b/a" and the candidate text is truncated to "Robertson
  // Industries v. Cromwell". Includes other commonly-used name aliases
  // (f/k/a, n/k/a, a/k/a) and their dotted/dotless variants.
  const PARTY_INTERNAL_MARKERS = new Set([
    'd/b/a', 'd.b.a.', 'd.b.a', 'dba',
    'f/k/a', 'f.k.a.', 'f.k.a', 'fka',
    'n/k/a', 'n.k.a.', 'n.k.a', 'nka',
    'a/k/a', 'a.k.a.', 'a.k.a', 'aka',
    // Round 28 — relator / on-behalf-of / petitioner forms. These are
    // standard caption phrases that appear as a lowercase pair between
    // two capitalized parties: "Starr ex rel. Estate of Sampson v.
    // Georgeson Shareholder, Inc.". Walk-back must not stop at "ex rel."
    // or it truncates the case name to "Estate of Sampson v. Georgeson
    // Shareholder, Inc." and downstream validators emit suggested fixes
    // missing the relator's name.
    'ex', 'rel.', 'rel', 'parte',
  ]);

  let nameStartIdx = tokens.length; // "no case-name word found" sentinel

  // Round 14 — sentence-end punctuation that's NOT followed by case-name
  // tokens. e.g., 'State."' (period + smart-close-quote), 'standard."'
  // (period + ASCII close-quote), 'home.”' (period + smart-close-quote
  // U+201D). Any token ending in this pattern is the END of a previous
  // sentence — stop the case-name walk before reaching it.
  const SENTENCE_END_RE = /[.!?][")”’»]/;

  // Round 15 — signal tokens (R. 1.2) precede a case name but are not
  // part of it. Stop the walk if we encounter one so candidate_text begins
  // at the actual case name and the signal stays in pre_context where
  // validateSignalCapitalization can flag mis-capitalisation.
  const SIGNAL_TOKENS_LOWER = new Set([
    'see', 'cf.', 'cf', 'contra', 'compare', 'accord', 'e.g.',
    'with', 'and', 'but',
  ]);

  for (let i = tokens.length - 1; i >= 0; i--) {
    const w = tokens[i].word;
    // Stop if this token ends a quoted sentence — there's no case-name
    // word that legitimately ends in `.\"` or `."`.
    if (SENTENCE_END_RE.test(w)) break;
    const stripped = w.replace(/[,;:]+$/, '');
    // Stop at any Bluebook R. 1.2 signal (case-insensitive). Signals are
    // bookkeeping in front of the case name, not name words.
    if (SIGNAL_TOKENS_LOWER.has(stripped.toLowerCase())) break;
    if (/^[A-Z]/.test(stripped)) {
      // Capitalized word — case-name word, include.
      nameStartIdx = i;
      continue;
    }
    if (CONNECTORS.has(stripped.toLowerCase())) {
      // Connector — include ONLY if the previous-back word is capitalized
      // (i.e., the connector is between two case-name words).
      const prevTok = tokens[i - 1];
      if (prevTok) {
        const prevStripped = prevTok.word.replace(/[,;:]+$/, '');
        if (/^[A-Z]/.test(prevStripped)) {
          nameStartIdx = i;
          continue;
        }
      }
      // Connector but not between cap words — stop here.
      break;
    }
    // Round 27 — party-internal name markers (d/b/a, f/k/a, n/k/a, a/k/a).
    // These ALWAYS appear between two capitalized party names in a case
    // caption. Don't update nameStartIdx (the marker itself isn't where the
    // case name begins) — just walk past it so the loop can include the
    // capitalized predecessor on the next iteration.
    if (PARTY_INTERNAL_MARKERS.has(stripped.toLowerCase())) {
      continue;
    }
    // Non-connector lowercase word — stop.
    break;
  }

  if (nameStartIdx >= tokens.length) return null;
  return tokens[nameStartIdx].start;
}

/**
 * Reach forward from a citation's char_end to capture the closing
 * parenthetical that contains court + year, e.g. "(2d Cir. 2019)" or
 * "(1954)".
 *
 * Returns expanded char_end, or original if no parenthetical follows.
 */
function reachForwardForParenthetical(text, charEnd) {
  const LOOKAHEAD = 100;
  const window = text.slice(charEnd, charEnd + LOOKAHEAD);

  // Match a parenthetical that starts within whitespace of charEnd and
  // contains at least a 4-digit year somewhere inside.
  //
  // Round 28 — also accept an OPTIONAL footnote pinpoint between the
  // page and the year-parenthetical: "412 F.3d 103, 109 n.5 (2d Cir.
  // 2005)". Without this, candidate text terminated at "109" and the
  // court parenthetical was lost — downstream validators then misfired
  // on what looked like a missing court parenthetical, and Pass 2's
  // year extraction silently lost the decision year.
  const parenMatch = window.match(/^(?:\s+n\.\s*\d+[a-z]?)?\s*\([^)]{0,80}\d{4}[^)]{0,40}\)/);
  if (!parenMatch) return charEnd;
  return charEnd + parenMatch[0].length;
}

/**
 * Extract candidate citations from a plain-text body.
 *
 * @param {string} text — canonical plain text (already extracted from .docx/.pdf)
 * @param {object} [opts]
 * @param {boolean} [opts.expandCaseName=true] — reach backward for case names
 * @param {boolean} [opts.expandParenthetical=true] — reach forward for "(2d Cir. 2019)"
 * @returns {Array<Candidate>} — one entry per detected citation candidate
 *
 * Candidate shape:
 *   {
 *     pattern_name:     string,                      // which regex hit
 *     provisional_type: 'case'|'statute'|...|'short_form_id'|'short_form_supra',
 *     candidate_text:   string,                      // the span text
 *     char_start:       int,                         // half-open range
 *     char_end:         int,
 *     pre_context:      string,                      // ~120 chars before
 *     post_context:     string,                      // ~120 chars after
 *   }
 */
export function findCitationCandidates(text, opts = {}) {
  const expandCaseName = opts.expandCaseName !== false;
  const expandParen = opts.expandParenthetical !== false;

  const candidates = [];

  for (const { name, regex, provisional_type } of PATTERN_REGISTRY) {
    // Each loop must reset lastIndex — sharing /g regex state between
    // iterations is a footgun.
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(text)) !== null) {
      let charStart = m.index;
      let charEnd = m.index + m[0].length;

      if (provisional_type === 'case' && expandCaseName) {
        charStart = reachBackForCaseName(text, charStart);
      }
      if ((provisional_type === 'case' || provisional_type === 'short_form_case') && expandParen) {
        charEnd = reachForwardForParenthetical(text, charEnd);
      }

      const candidateText = text.slice(charStart, charEnd);

      candidates.push({
        pattern_name: name,
        provisional_type,
        candidate_text: candidateText,
        char_start: charStart,
        char_end: charEnd,
        // Wider context windows give Pass 2 a full sentence (or two) of
        // surrounding text. Pass 2 uses these to (a) confirm the case
        // name, (b) detect signals that should be stripped, and (c)
        // identify the citation's role in a string cite. 300 chars is
        // enough for ~50 words on each side, which covers any realistic
        // legal sentence.
        pre_context: text.slice(Math.max(0, charStart - 300), charStart),
        post_context: text.slice(charEnd, Math.min(text.length, charEnd + 300)),
      });
    }
  }

  // Sort by start offset, then by length descending (longer wins on tie).
  candidates.sort((a, b) => {
    if (a.char_start !== b.char_start) return a.char_start - b.char_start;
    return (b.char_end - b.char_start) - (a.char_end - a.char_start);
  });

  return candidates;
}

/**
 * Drop candidates whose span is fully contained inside another candidate's
 * span. Helps reduce duplicate work for Pass 2 — the longer span will have
 * more context anyway.
 *
 * NOTE: we do NOT drop overlapping spans; only fully-contained ones. Two
 * adjacent citations sharing an "and" word (string cites) must both survive.
 */
export function dropContainedDuplicates(candidates) {
  if (candidates.length === 0) return candidates;
  const out = [];
  for (const c of candidates) {
    const containedBy = out.find(
      (other) => other.char_start <= c.char_start && other.char_end >= c.char_end
                 && !(other.char_start === c.char_start && other.char_end === c.char_end)
    );
    if (!containedBy) out.push(c);
  }
  return out;
}
