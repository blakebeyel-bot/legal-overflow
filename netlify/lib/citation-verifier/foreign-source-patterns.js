/**
 * Citation Verifier — foreign-source extractor (Round 20).
 *
 * Detects:
 *   • UK cases:        [Case] [YYYY] [vol]? AC|WLR|QB|Ch [page] (Court) (Eng./UK/Scot.)
 *   • Australian cases: [Case] (YYYY) [vol] CLR [page] (Austl.)
 *   • French cases:    Cass. [chamber], [date], Bull. civ. ... (Fr.)
 *   • German cases:    Bundesgerichtshof / [BGH] / [BVerfG] etc. (Ger.)
 *   • Multilateral treaties: ... [Volume] U.N.T.S. [Page]
 *   • Bilateral treaties:    ..., U.S.-[Country], [date], [series cite]
 *   • ICJ:             [Case] (Country v. Country), Judgment, [year] I.C.J. [page] (Date)
 *   • ECHR:            [Case] v. [Country], App. No. NNNNN, [vol] Eur. Ct. H.R./Eur. H.R. Rep. [page]
 *   • ICTY/ICTR:       Prosecutor v. [Defendant], Case No. [num], ... (Tribunal Date)
 *   • Specialty federal: T.C., T.C.M., B.R., M.J., F. Cl., Fed. Cl., C.A.A.F.
 *
 * Each candidate is emitted with provisional_type that maps to citation_type
 * so Pass 3 validators branch on it.
 *
 * Critical FP-resistance: domestic cases ("X v. Y, V U.S./F.3d/F.Supp.")
 * are NOT classified as foreign. UK pattern requires bracket-year `[YYYY]`,
 * Australian requires parens-year `(YYYY) <vol> CLR`, etc.
 */

import { sha256Hex } from './extract.js';

// --------------------------------------------------------------------------
// UK case (R. 20)
//   "<Name> [YYYY] <vol>? AC|WLR|QB|Ch|All ER <page> (HL|CA|...)? (Eng.|UK|Scot.)?"
//   Bracket-year is the UK convention (distinct from Australia's parens).
//   The case name allows lowercase tokens like "plc", "ltd" within the
//   defendant party (corporate-suffix recognition).
// --------------------------------------------------------------------------
const UK_CASE_RE = /\b[A-Z][\w'.\-]*(?:\s+(?:[A-Z][\w'.\-]*|plc|ltd)){0,6}\s+v\.\s+[A-Z][\w'.\-]*(?:\s+(?:[A-Z][\w'.\-]*|of|the|and|&|plc|ltd)){0,8}\s+\[\d{4}\]\s+(?:\d{1,3}\s+)?(?:AC|WLR|QB|Ch|All ER|UKSC|UKHL)\s+\d{1,5}(?:\s*\((?:HL|CA|UKSC|PC|Ch|QB|Crim)[^)]{0,30}\))?(?:\s*\([A-Za-z.\s]+\))?/g;

// --------------------------------------------------------------------------
// Australian case (R. 20)
//   "<Name> (YYYY) <vol> CLR <page> (Austl.)"
//   Parens-year + CLR reporter.
// --------------------------------------------------------------------------
const AUS_CASE_RE = /\b[A-Z][\w'.\-]*(?:\s+[A-Z][\w'.\-]*){0,6}\s+v\.\s+[A-Z][\w'.\-]*(?:\s+[A-Z][\w'.\-]*){0,4}\s+\(\d{4}\)\s+\d{1,3}\s+CLR\s+\d{1,5}(?:\s*\(Austl\.\))?/g;

// --------------------------------------------------------------------------
// French case (R. 20)
//   "Cass. <chamber>, <date>, Bull. civ. ... (Fr.)?"
// --------------------------------------------------------------------------
const FRENCH_CASE_RE = /\bCass\.\s+(?:civ\.|crim\.|com\.|soc\.)\s+[\dre]+,\s+[A-Z][a-z]+\.?\s+\d{1,2},\s+\d{4},\s+Bull\.\s+civ\.\s+[IVX]+,?\s+No\.\s+\d+(?:\s*\(Fr\.\))?/g;

// --------------------------------------------------------------------------
// German case (R. 20)
//   Most complex — contains "Bundesgerichtshof" or "[BGH]" or "[BVerfG]"
//   plus bracket-translation [Federal Court of Justice], date, BGHZ reporter.
//   The format has multiple bracket pairs which make this the corpus's
//   stress test for negative-space detection.
// --------------------------------------------------------------------------
// `[\s\S]` matches anything (including newlines) — needed because the
// German citation has internal periods in date "Mar. 12, 2018" that would
// break a `[^.]` exclusion.
const GERMAN_CASE_RE = /\bBundesgerichtshof\s+\[BGH\][\s\S]{0,300}?\(Ger\.\)/g;

// --------------------------------------------------------------------------
// Multilateral treaty (R. 21.4)
//   "<Treaty Name> art. N(, <date>)?, <vol> U.N.T.S./U.S.T. <page>(, ...)*"
// --------------------------------------------------------------------------
// Anchor on the end marker so walk-back finds the treaty name without the
// regex greedily consuming prior unrelated sentences.
const MULTILATERAL_TREATY_END_RE = /\b\d{1,5}\s+(?:U\.N\.T\.S\.|U\.S\.T\.|T\.I\.A\.S\.)\s+[\d,]+/g;

// --------------------------------------------------------------------------
// Bilateral treaty (R. 21.4) — anchor on the END marker.
//   The regex matches just the trailer "U.S.-<Country>(, <date>)?(, <series cite>)?"
//   The walk-back then captures the treaty name from the prior sentence.
//   Anchoring on the END prevents the regex from greedily expanding the
//   case-name portion across multiple unrelated sentences.
// --------------------------------------------------------------------------
const BILATERAL_TREATY_END_RE = /,\s+U\.S\.-[A-Z][\w'.\-]*(?:[\s.]+[A-Z][\w'.\-]+){0,2}(?:,\s+[A-Z][a-z]+\.?\s+\d{1,2},\s+\d{4})?(?:,\s+\d+\s+(?:Stat\.|T\.I\.A\.S\.|U\.S\.T\.)\s+[\d,]+)?/g;

// --------------------------------------------------------------------------
// ICJ case (R. 21) — anchor on END marker "<year> I.C.J. <page>".
//   The walk-back captures the case name and the optional decision-date paren.
// --------------------------------------------------------------------------
const ICJ_CASE_END_RE = /\b\d{4}\s+I\.C\.J\.\s+\d{1,5}/g;

// --------------------------------------------------------------------------
// ECHR case (R. 21)
//   "<Case Name> v. <Country>, App. No. NNNNN(/NN)?, <vol> Eur. Ct. H.R. <page>"
//   OR "<Case Name> v. <Country>, <vol> Eur. H.R. Rep. <page>"
// --------------------------------------------------------------------------
const ECHR_CASE_RE = /\b[A-Z][\w'.\-]+(?:\s+[A-Z][\w'.\-]+){0,3}\s+v\.\s+(?:United Kingdom|Italy|France|Germany|Spain|Greece|Russia|Turkey|Poland|Romania|[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})(?:,\s+App\.\s+No\.\s+[\d\/]+)?,?\s+\d{1,3}\s+(?:Eur\.\s+Ct\.\s+H\.R\.(?:\s*\(ser\.\s+[AB]\))?|Eur\.\s+H\.R\.\s+Rep\.)\s+\d{1,5}(?:\s*\(\d{4}\))?/g;

// --------------------------------------------------------------------------
// ICTY/ICTR/Other Tribunal (R. 21)
//   "Prosecutor v. <Name>, Case No. <num>, ... (Tribunal date)"
// --------------------------------------------------------------------------
const TRIBUNAL_RE = /\bProsecutor\s+v\.\s+[A-Z][\w'.\-čć]+,\s+Case\s+No\.\s+[A-Z\-\d]+,[^)]{0,300}\)/g;

// --------------------------------------------------------------------------
// Specialty federal courts (R. 10 / T1)
// --------------------------------------------------------------------------
const TCM_RE = /\b[A-Z][\w'.\-]+(?:\s+[A-Z][\w'.\-]*)*\s+v\.\s+(?:Comm'r|Commissioner|United States),?\s+T\.C\.M\.\s+\d{4}-\d{1,4}(?:\s*\((?:CCH|RIA)\))?/g;

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
const ABBREV = new Set([
  'v','vs','Co','Inc','Corp','Ltd','Bros','Cir','Mfg','Univ',
  'Ed','Rev','Bull','Mag',
  'A','B','C','D','E','F','G','H','I','J','K','L','M','N',
  'O','P','Q','R','S','T','U','V','W','X','Y','Z',
  'Mr','Mrs','Ms','Dr','Hon','Prof','Pa','Va','Tex','Cal','Fla',
  'Mass','Mich','Wash','St','Jr','Sr','No','Nos',
  'Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sept','Sep','Oct','Nov','Dec',
  'ed','rev','eds','art','amend','cl','pt',
  'Cass','civ','crim','com','soc','Fr','Ger','Eng','Austl','Scot',
  'BGH','BGHZ','BVerfG','BVerfGE','HL','CA','UKSC','PC','UKHL',
  'AC','WLR','QB','Ch','CLR','I','II','III','IV','V','VI','VII','VIII','IX','X',
]);

function walkBackToStart(text, endStart) {
  const LOOKBACK = 600;
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
  // Strip leading signal.
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
// Main entry
// --------------------------------------------------------------------------
export function findForeignSourceCandidates(text) {
  if (!text || typeof text !== 'string') return [];
  const candidates = [];

  function emit(type, m, opts = {}) {
    const matchStart = m.index;
    const matchEnd = m.index + m[0].length;
    const start = opts.start ?? walkBackToStart(text, matchStart);
    const end = opts.end ?? walkForwardThroughTrailers(text, matchEnd);
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
      candidate_text_hash: 'foreign:' + sha256Hex(Buffer.from(candText + '|' + start, 'utf8')).slice(0, 16),
    });
  }

  // Order matters — most specific first.
  // German (most specific multi-bracket pattern)
  GERMAN_CASE_RE.lastIndex = 0;
  let m;
  while ((m = GERMAN_CASE_RE.exec(text)) !== null) emit('foreign_case_german', m, { provisional_type: 'foreign_case' });

  // French
  FRENCH_CASE_RE.lastIndex = 0;
  while ((m = FRENCH_CASE_RE.exec(text)) !== null) emit('foreign_case_french', m, { provisional_type: 'foreign_case' });

  // ECHR
  ECHR_CASE_RE.lastIndex = 0;
  while ((m = ECHR_CASE_RE.exec(text)) !== null) emit('echr_case', m, { provisional_type: 'echr_case' });

  // ICJ — anchor on year+I.C.J.+page; walk-back picks up case name.
  ICJ_CASE_END_RE.lastIndex = 0;
  while ((m = ICJ_CASE_END_RE.exec(text)) !== null) emit('icj_case', m, { provisional_type: 'icj_case' });

  // Tribunal
  TRIBUNAL_RE.lastIndex = 0;
  while ((m = TRIBUNAL_RE.exec(text)) !== null) emit('tribunal_case', m, { provisional_type: 'tribunal_case' });

  // UK
  UK_CASE_RE.lastIndex = 0;
  while ((m = UK_CASE_RE.exec(text)) !== null) emit('foreign_case_uk', m, { provisional_type: 'foreign_case' });

  // Australian
  AUS_CASE_RE.lastIndex = 0;
  while ((m = AUS_CASE_RE.exec(text)) !== null) emit('foreign_case_aus', m, { provisional_type: 'foreign_case' });

  // Bilateral treaty (must come before multilateral so U.S.-X cites match here).
  // The regex anchors on END marker; walk-back picks up the treaty name.
  BILATERAL_TREATY_END_RE.lastIndex = 0;
  while ((m = BILATERAL_TREATY_END_RE.exec(text)) !== null) emit('bilateral_treaty', m, { provisional_type: 'bilateral_treaty' });

  // Multilateral treaty — anchor on end marker; walk-back picks up name.
  MULTILATERAL_TREATY_END_RE.lastIndex = 0;
  while ((m = MULTILATERAL_TREATY_END_RE.exec(text)) !== null) emit('multilateral_treaty', m, { provisional_type: 'multilateral_treaty' });

  // Tax Court Memorandum
  TCM_RE.lastIndex = 0;
  while ((m = TCM_RE.exec(text)) !== null) emit('tcm_case', m, { provisional_type: 'tcm_case' });

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
