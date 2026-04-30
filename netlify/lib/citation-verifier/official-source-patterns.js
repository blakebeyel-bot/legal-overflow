/**
 * Citation Verifier — official-source candidate extractor.
 *
 * Constitutional (R. 11), legislative (R. 13), and administrative (R. 14)
 * citations all have shapes the case extractor in citation-patterns.js
 * doesn't recognize. They share the structure:
 *
 *   <Source designator> <number/article> [, § N] [, cl. N] [(year)]
 *
 * Examples:
 *   U.S. Const. art. I, § 8, cl. 3
 *   U.S. Const. amend. XIV, § 1
 *   Cal. const. art. I, § 7
 *   H.R. Rep. No. 117-456, at 23 (2022)
 *   S. 510 (2009)
 *   H.R. 4173, 111th Cong. § 1031 (2010)
 *   163 Cong. Rec. 12,345 (2017)
 *   88 Fed. Reg. 56,789 (Aug. 17, 2023)
 *   Exec. Order No. 14,028, 86 Fed. Reg. 26,633 (May 12, 2021)
 *
 * Each pattern below emits candidates with a provisional_type that maps
 * straight to citation_type so Pass 3 validators can branch on it.
 */

import { sha256Hex } from './extract.js';

// --------------------------------------------------------------------------
// CONSTITUTIONAL (R. 11)
//
//   U.S. Const. art. I, § 8, cl. 3       → canonical
//   U.S. Const. amend. XIV, § 1          → canonical
//   U.S. Const. amend. 14, § 5           → wrong (Arabic, should be Roman)
//   U.S. Const. art III, § 2             → wrong (no period after "art")
//   Cal. const. art. I, § 7              → wrong (lowercase "const.")
// --------------------------------------------------------------------------
const CONST_RE = new RegExp(
  '(?:U\\.S\\.|[A-Z][a-z]+\\.)\\s+[Cc]onst\\.\\s+' +     // "<US|State>. const."
  '(?:art\\.?|amend\\.?)\\s+' +                          // article or amendment marker (period optional)
  '[IVXLCDM\\d]+' +                                      // Roman or Arabic numeral
  '(?:,\\s*§\\s*\\d+(?:\\(\\w+\\))?)?' +                 // optional ", § N"
  '(?:,\\s*cl\\.\\s*\\d+)?',                             // optional ", cl. N"
  'g'
);

// --------------------------------------------------------------------------
// LEGISLATIVE (R. 13)
// --------------------------------------------------------------------------
// Bills: "S. 510" / "H.R. 4173" — followed by either "(YEAR)" or
// ", NNNth Cong. ..." form.
//
// Lookbehind `(?<![A-Za-z.])` prevents matches inside multi-letter
// abbreviations like "U.S. 544" (the "S." here is part of "U.S.", not
// a bill prefix). Without this guard, every "<vol> U.S. <page>" case
// citation would trigger a spurious R. 13.2 flag.
//
// Match REQUIRES either a Cong. session designator OR a year-parenthetical
// at the end so we don't capture every "S. <digit>" sequence in random
// prose. The validator will flag a bill that has the year but no Cong.
const BILL_RE = /(?<![A-Za-z.])(?:H\.\s*R\.|S\.|H\.R\.)\s*\d{1,5}(?:,\s*\d+(?:st|nd|rd|th)\s*Cong\.[^.]*?(?:\s*§\s*\d+(?:\(\w+\))*)?(?:\s+\(\d{4}\))?|\s+\(\d{4}\))/g;

// Reports: "H.R. Rep. No. NNN-NNNN, at NN (YYYY)" or malformed
//          "H.R. Rep. No. NNNN, at NN (YYYY)" (no congressional prefix)
const REPORT_RE = /(?<![A-Za-z.])(?:H\.\s*R\.|S\.|H\.R\.)\s*Rep\.\s*No\.\s*\d+(?:-\d+)?(?:,\s*at\s+\d+)?(?:\s*\(\d{4}\))?/g;

// Congressional Record: "<vol> Cong. Rec. <page>"
const CONG_REC_RE = /\d{1,4}\s+Cong\.\s*Rec\.\s+[\d,]+/g;

// Hearings: long pattern, recognized by "Hearing Before" + "Cong."
const HEARING_RE = /[A-Z][^.]{5,200}?:\s+Hearing\s+Before\s+[^.]{0,300}?\d+(?:st|nd|rd|th)\s+Cong\.\s+\d+\s*\(\d{4}\)(?:\s*\([^)]{0,100}\))?/g;

// --------------------------------------------------------------------------
// ADMINISTRATIVE (R. 14)
// --------------------------------------------------------------------------
// Federal Register: "<vol> Fed. Reg. <page>" optionally with "(<date>)" or
// "(proposed <date>)" or "(to be codified at ...)" parenthetical.
const FED_REG_RE = /(?:\d{1,4}\s+)?Fed\.\s*Reg\.\s+[\d,]+(?:\s*\([^)]{0,200}\))?/g;

// Executive Orders
const EXEC_ORDER_RE = /Exec\.\s+Order\s+No\.\s*\d+(?:,\d{3})*(?:,\s*\d{1,4}\s+Fed\.\s*Reg\.\s+[\d,]+)?(?:\s*\([^)]{0,100}\))?/g;

// --------------------------------------------------------------------------
// Walk-back helper (mirrors secondary-source-patterns approach)
// --------------------------------------------------------------------------
const ABBREV = new Set([
  'v', 'vs', 'Co', 'Inc', 'Corp', 'Ltd', 'Bros', 'Cir', 'Mfg', 'Univ',
  'Ed', 'Rev', 'Bull', 'Mag',
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N',
  'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
  'Mr', 'Mrs', 'Ms', 'Dr', 'Hon', 'Prof', 'Pa', 'Va', 'Tex', 'Cal', 'Fla',
  'Mass', 'Mich', 'Wash', 'St', 'Jr', 'Sr', 'No', 'Nos',
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Sep', 'Oct', 'Nov', 'Dec',
  'ed', 'rev', 'eds', 'art', 'amend', 'cl', 'pt',
]);

function walkBackToStart(text, endStart) {
  const LOOKBACK = 400;
  const windowStart = Math.max(0, endStart - LOOKBACK);
  const window = text.slice(windowStart, endStart);
  let lastBoundary = 0;
  const re = /[.;!?]\s+|\n\s*\n/g;
  let m;
  while ((m = re.exec(window)) !== null) {
    if (m[0].startsWith('\n')) { lastBoundary = m.index + m[0].length; continue; }
    const before = window.slice(Math.max(0, m.index - 12), m.index);
    const wordMatch = before.match(/([A-Za-z][A-Za-z']*)$/);
    const word = wordMatch ? wordMatch[1] : '';
    if (word && ABBREV.has(word)) continue;
    lastBoundary = m.index + m[0].length;
  }
  // Strip optional signal
  const sigRe = /^(?:see also|see, e\.g\.|see|but see|but cf|cf|contra|compare|accord|e\.g\.)\.?,?\s+/i;
  const post = window.slice(lastBoundary);
  const sigMatch = post.match(sigRe);
  if (sigMatch) lastBoundary += sigMatch[0].length;
  return windowStart + lastBoundary;
}

function walkForwardThroughTrailers(text, charEnd) {
  let pos = charEnd;
  while (pos < text.length) {
    const m = text.slice(pos).match(/^[,\s]*\(([^)]{0,300})\)/);
    if (!m) break;
    pos += m[0].length;
  }
  return pos;
}

// --------------------------------------------------------------------------
// Main entry point.
// --------------------------------------------------------------------------
export function findOfficialSourceCandidates(text) {
  if (!text || typeof text !== 'string') return [];
  const candidates = [];

  function emit(type, m, opts = {}) {
    const start = opts.start ?? walkBackToStart(text, m.index);
    const end = opts.end ?? walkForwardThroughTrailers(text, m.index + m[0].length);
    if (overlaps(candidates, start, end)) return;
    const candText = text.slice(start, end);
    candidates.push({
      pattern_name: type,
      provisional_type: opts.provisional_type || type,
      candidate_text: candText,
      char_start: start,
      char_end: end,
      pre_context: text.slice(Math.max(0, start - 200), start),
      post_context: text.slice(end, Math.min(text.length, end + 200)),
      in_footnote: false,
      footnote_num: null,
      candidate_text_hash: 'official:' + sha256Hex(Buffer.from(candText + '|' + start, 'utf8')).slice(0, 16),
    });
  }

  // Constitutional first (longest-match wins)
  CONST_RE.lastIndex = 0;
  let m;
  while ((m = CONST_RE.exec(text)) !== null) emit('constitutional', m);

  // Reports before bills (so we don't capture "H.R. Rep" as just a bill)
  REPORT_RE.lastIndex = 0;
  while ((m = REPORT_RE.exec(text)) !== null) emit('legislative_report', m, { provisional_type: 'legislative_report' });

  // Hearings
  HEARING_RE.lastIndex = 0;
  while ((m = HEARING_RE.exec(text)) !== null) emit('legislative_hearing', m, { provisional_type: 'legislative_hearing' });

  // Congressional Record
  CONG_REC_RE.lastIndex = 0;
  while ((m = CONG_REC_RE.exec(text)) !== null) emit('cong_rec', m, { provisional_type: 'cong_rec' });

  // Bills
  BILL_RE.lastIndex = 0;
  while ((m = BILL_RE.exec(text)) !== null) {
    // Skip if this overlaps a report (already captured).
    const start = walkBackToStart(text, m.index);
    const end = walkForwardThroughTrailers(text, m.index + m[0].length);
    if (overlaps(candidates, start, end)) continue;
    // Reject if the match is too short to be a real bill (e.g., just "H.R.")
    const t = text.slice(start, end);
    if (!/\b(?:H\.?R\.?|S\.)\s*\d/.test(t)) continue;
    emit('bill', m, { provisional_type: 'bill', start, end });
  }

  // Executive Orders before Federal Register (more specific)
  EXEC_ORDER_RE.lastIndex = 0;
  while ((m = EXEC_ORDER_RE.exec(text)) !== null) emit('exec_order', m, { provisional_type: 'exec_order' });

  // Federal Register
  FED_REG_RE.lastIndex = 0;
  while ((m = FED_REG_RE.exec(text)) !== null) emit('fed_reg', m, { provisional_type: 'fed_reg' });

  return dedupe(candidates);
}

function overlaps(existing, start, end) {
  for (const c of existing) {
    if (start < c.char_end && end > c.char_start) return true;
  }
  return false;
}

function dedupe(candidates) {
  candidates.sort((a, b) => {
    if (a.char_start !== b.char_start) return a.char_start - b.char_start;
    return (b.char_end - b.char_start) - (a.char_end - a.char_start);
  });
  const out = [];
  for (const c of candidates) {
    const dup = out.find(
      (o) => o.char_start <= c.char_start && o.char_end >= c.char_end
    );
    if (!dup) out.push(c);
  }
  return out;
}
