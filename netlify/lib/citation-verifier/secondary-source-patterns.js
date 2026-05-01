/**
 * Citation Verifier — secondary-source candidate extractor.
 *
 * Books (R. 15), articles (R. 16), unpublished manuscripts (R. 17), and
 * internet sources (R. 18) all share a common shape: they have an
 * AUTHOR comma TITLE comma <STRUCTURE> (PARENTHETICAL) — but they don't
 * use the " v. " marker that the case extractor relies on, and they
 * don't end in a reporter abbreviation. The case extractor in
 * citation-patterns.js can't see them; this module fills the gap.
 *
 * Strategy:
 *   1. Scan the document text for END MARKERS that uniquely identify each
 *      citation type (URL, "(forthcoming YEAR)", "(unpublished manuscript)",
 *      "(on file with...)", a T13-style journal followed by page+year, or
 *      a section/page followed by a year-parenthetical).
 *   2. For each end marker, walk BACK to find the citation start
 *      (sentence boundary, paragraph start, or after "See"/"See also" signal).
 *   3. Emit a candidate with provisional_type indicating the source type.
 *
 * The output candidates flow through the same downstream pipeline as
 * case candidates: synthetic Pass 2 (or production Sonnet) classifies
 * them, Pass 3 validators check form, Pass 5 markup applies comments.
 */

import { sha256Hex } from './extract.js';

// --------------------------------------------------------------------------
// Pattern — INTERNET source (R. 18)
//   Contains a URL anywhere. The candidate is the surrounding sentence.
// --------------------------------------------------------------------------
const URL_RE = /https?:\/\/[^\s)\]]+/g;

// --------------------------------------------------------------------------
// Pattern — NEWS article (R. 18.2)
//   "<Outlet> (Month DD, YYYY)" form. Captures candidates that LOOK like
//   news cites so the news-no-URL validator can flag missing URLs. We
//   only emit candidates here; the validator decides whether the cite
//   actually lacks a URL.
// --------------------------------------------------------------------------
const NEWS_OUTLET_PATTERN = '(?:Times|Reporter|Post|Journal|Tribune|Globe|News|Today|Chronicle|Herald|Bloomberg|Reuters|Variety|Politico|Axios|Atlantic|Newyorker|TechCrunch|Forbes|Fortune)';
const NEWS_END_RE = new RegExp(
  '\\b' + NEWS_OUTLET_PATTERN + '\\s+' +
  '\\([A-Z][a-z]{2,5}\\.?\\s+\\d{1,2},\\s+\\d{4}\\)',
  'g'
);

// --------------------------------------------------------------------------
// Pattern — ARTICLE (R. 16)
//   "[Volume ]Journal Page[, Pin] (Year)" or "Journal (forthcoming Year)"
//   Volume is optional in the regex so that R. 16.4 missing-volume errors
//   are still detected (Pass 1 must capture the malformed cite to flag it).
// --------------------------------------------------------------------------
// Journal token: an UPPERCASE-WORD sequence ending in a periodical
// terminator like "L. Rev.", "L.J.", "J.", "Rev.", "Bull.", "Q." OR a long-
// form title like "...Law Review" or "...Law Journal" or "...Journal" or
// "...Review" or "...Tribune".
const JOURNAL_RE_SRC =
  '(?:' +
    // T13 abbreviated form — sequence of cap-word tokens followed by a
    // canonical journal terminator. Allow ampersand and lowercase
    // connectors between cap words.
    "[A-Z][\\w'.\\-]*\\.?(?:\\s+(?:[A-Z][\\w'.\\-]*\\.?|of|the|and|&))*\\s+" +
    "(?:L\\.\\s*Rev\\.|L\\.\\s*J\\.|J\\.\\s*Reg\\.|J\\.\\s*Int'l\\s*L\\.|J\\.\\s*Const\\.\\s*L\\.|J\\.|Rev\\.|Bull\\.|Q\\.|Mag\\.|L\\.\\s*Q\\.)" +
  '|' +
    // Long form — "<words> Law Review" / "Law Journal" / "Journal" / "Review"
    "[A-Z][\\w'.\\-]*(?:\\s+(?:[A-Z][\\w'.\\-]*|of|the|and|&))*\\s+" +
    '(?:Law\\s+Review|Law\\s+Journal|Journal|Review|Tribune)' +
  ')';

const ARTICLE_END_RE = new RegExp(
  '(?:(\\d{1,4})\\s+)?' +                 // optional volume
  '(' + JOURNAL_RE_SRC + ')' +            // journal
  '\\s+' +
  // Either "Page[, Pin] (Year)" OR "(forthcoming Year)"
  '(?:' +
    '\\d{1,5}(?:,\\s*\\d{1,5})?' +
    '\\s*\\((?:[A-Z][a-z]+\\.?\\s+\\d{1,2}(?:,\\s+|\\s+))?\\d{4}\\)' +
  '|' +
    '\\(forthcoming\\s+\\d{4}\\)' +
  ')',
  'g'
);

// --------------------------------------------------------------------------
// Pattern — BOOK / TREATISE (R. 15)
//   "[VOL ]Author(, Co-Author)?, Title (§ X[Y]|Page) (parenthetical-with-year)"
//   We loosely match a multi-word title block followed by a section symbol
//   or pin number, then a parenthetical containing a 4-digit year.
// --------------------------------------------------------------------------
const BOOK_END_RE = new RegExp(
  // Section symbol or page pinpoint, then year-parenthetical (which may
  // include edition like "(3d ed. 2024)" or "(Matthew Bender rev. ed. 2023)").
  '(?:§{1,2}\\s*[\\w\\d.:\\[\\]]+|\\b\\d{1,5})' +
  '\\s+\\([^)]{0,100}\\b\\d{4}\\)',
  'g'
);

// --------------------------------------------------------------------------
// Pattern — UNPUBLISHED MANUSCRIPT (R. 17.1)
//   Ends with "(unpublished manuscript)" or "(on file with X)".
// --------------------------------------------------------------------------
const MANUSCRIPT_TAIL_RE = /\((?:unpublished\s+manuscript)\)|\(on\s+file\s+with[^)]{0,200}\)/gi;

// --------------------------------------------------------------------------
// Pattern — FORTHCOMING (R. 17.2)
// --------------------------------------------------------------------------
const FORTHCOMING_RE = /\(forthcoming\s+\d{4}\)/g;

// --------------------------------------------------------------------------
// Reach-back: from a citation END position, walk back to the citation START.
// Stops at the most recent sentence boundary, paragraph break, or signal
// boundary like "See ", "See also ", "Cf. ", etc.
// --------------------------------------------------------------------------
function walkBackToCitationStart(text, endStart) {
  const LOOKBACK = 600;
  const windowStart = Math.max(0, endStart - LOOKBACK);
  const window = text.slice(windowStart, endStart);

  // Find the LAST sentence boundary in the window. Mirror the case
  // reach-back logic: ". " or "; " or "! " or "? " or newline.
  // Skip abbreviation periods.
  const ABBREV = new Set([
    'v', 'vs', 'Co', 'Inc', 'Corp', 'Ltd', 'Bros', 'Cir', 'Mfg', 'Univ',
    'Ed', 'Rev', 'Bull', 'Mag',
    // ALL single uppercase letters — every one is a potential abbreviation.
    // "N.Y." has period after "Y" → must skip. "L.J." period after "J", etc.
    'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N',
    'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
    'Mr', 'Mrs', 'Ms', 'Dr', 'Hon', 'Prof', 'Pa', 'Va', 'Tex', 'Cal', 'Fla',
    'Mass', 'Mich', 'Wash', 'St', 'Jr', 'Sr', 'No', 'Nos',
    // Round 16 — month abbreviations. Without these, "(Mar. 14, 2024)" inside
    // a citation is treated as a sentence boundary, and walk-back lands
    // mid-citation, truncating internet candidates.
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Sep', 'Oct', 'Nov', 'Dec',
    'ed', 'rev', 'eds',
  ]);
  let lastBoundary = 0;
  const re = /[.;!?]\s+|\n\s*\n/g;
  let m;
  while ((m = re.exec(window)) !== null) {
    if (m[0].startsWith('\n')) {
      lastBoundary = m.index + m[0].length;
      continue;
    }
    const before = window.slice(Math.max(0, m.index - 12), m.index);
    const wordMatch = before.match(/([A-Za-z][A-Za-z']*)$/);
    const word = wordMatch ? wordMatch[1] : '';
    if (word && ABBREV.has(word)) continue;
    lastBoundary = m.index + m[0].length;
  }

  // Optionally consume a leading signal at the boundary (case-insensitive).
  const sigRe = /^(?:see also|see, e\.g\.|see|but see|but cf|cf|contra|compare|accord|e\.g\.)\.?,?\s+/i;
  const post = window.slice(lastBoundary);
  const sigMatch = post.match(sigRe);
  if (sigMatch) lastBoundary += sigMatch[0].length;

  // Round 16 — also consume INLINE intro prose like
  //   "As Professor X has explained, Author, Title..."
  // The intro prose contains a space-bounded LOWERCASE verb/connector word
  // (e.g., " has ", " explained", " stated") which distinguishes it from
  // an author name (which has no such word). Without this, citation
  // candidate_text would include "As Professor X has explained, ".
  // The discriminator `\s[a-z]+\s` is the linchpin: a name like
  // "Sarah Mitchell" has no space-bounded lowercase word, so this regex
  // doesn't fire on legitimate "Author, Note, Title" sequences.
  const afterSig = window.slice(lastBoundary);
  const inlineIntroRe = /^([A-Z][^,]{0,150}?\s[a-z]+\s[^,]{0,80},\s+)(?=[A-Z][\w'.\-]+(?:\s+[A-Z][\w'.\-]+){0,4}\s*,\s*[A-Z])/;
  const introMatch = afterSig.match(inlineIntroRe);
  if (introMatch) {
    lastBoundary += introMatch[1].length;
  }

  return windowStart + lastBoundary;
}

// --------------------------------------------------------------------------
// Reach-forward: extend a citation's char_end past adjacent
// "(...)" parentheticals so trailing markers like
// "(unpublished manuscript)", "(on file with author)", "(manuscript at 12)"
// are included in candidate_text — Pass 3 validators rely on these to
// distinguish manuscript / forthcoming / etc. shapes.
// --------------------------------------------------------------------------
function walkForwardThroughTrailers(text, charEnd) {
  let pos = charEnd;
  while (pos < text.length) {
    // Skip whitespace + optional comma between adjacent parentheticals.
    const m = text.slice(pos).match(/^[,\s]*\(([^)]{0,300})\)/);
    if (!m) break;
    pos += m[0].length;
  }
  return pos;
}

// --------------------------------------------------------------------------
// Main entry point.
// --------------------------------------------------------------------------
export function findSecondarySourceCandidates(text) {
  if (!text || typeof text !== 'string') return [];
  const candidates = [];

  // -- Internet (R. 18): every URL anchors a candidate -----------------------
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(text)) !== null) {
    const urlStart = m.index;
    let urlEnd = m.index + m[0].length;
    // URL_RE may have captured a trailing sentence-end period (e.g.,
    // "...html.") because period is not in the negated character class.
    // Strip that — it belongs to the sentence, not the URL — but keep it
    // in the candidate end so the comment range covers it.
    const start = walkBackToCitationStart(text, urlStart);
    // Walk forward through any trailing parenthetical (e.g.,
    // "(last visited Mar. 14, 2024)"), but DO NOT walk past the URL
    // sentence end. The citation terminates at the URL or its trailing
    // parenthetical.
    const end = walkForwardThroughTrailers(text, urlEnd);
    candidates.push(makeCandidate({
      text, start, end,
      provisional_type: 'internet',
      pattern_name: 'secondary-internet',
    }));
  }

  // -- Manuscript (R. 17.1): catches "(unpublished manuscript)" or
  //    "(on file with...)" at the trailer of a citation. ---------------------
  MANUSCRIPT_TAIL_RE.lastIndex = 0;
  while ((m = MANUSCRIPT_TAIL_RE.exec(text)) !== null) {
    const tailStart = m.index;
    const tailEnd = m.index + m[0].length;
    const start = walkBackToCitationStart(text, tailStart);
    const end = walkForwardThroughTrailers(text, tailEnd);
    candidates.push(makeCandidate({
      text, start, end,
      provisional_type: 'manuscript',
      pattern_name: 'secondary-manuscript',
    }));
  }

  // -- Forthcoming (R. 17.2): "(forthcoming YEAR)" tail ---------------------
  FORTHCOMING_RE.lastIndex = 0;
  while ((m = FORTHCOMING_RE.exec(text)) !== null) {
    const tailStart = m.index;
    const tailEnd = m.index + m[0].length;
    const start = walkBackToCitationStart(text, tailStart);
    const end = walkForwardThroughTrailers(text, tailEnd);
    candidates.push(makeCandidate({
      text, start, end,
      provisional_type: 'forthcoming',
      pattern_name: 'secondary-forthcoming',
    }));
  }

  // -- News article (R. 18.2): "<Outlet> (Month DD, YYYY)" cites that may
  //    lack a URL. Walks forward past optional URL trailer so the validator
  //    can decide whether the URL is present.
  NEWS_END_RE.lastIndex = 0;
  while ((m = NEWS_END_RE.exec(text)) !== null) {
    const tailStart = m.index;
    const tailEnd = m.index + m[0].length;
    const start = walkBackToCitationStart(text, tailStart);
    // Walk forward through optional ", https://..." and any trailing parens.
    let end = tailEnd;
    const fwd = text.slice(end).match(/^,?\s*https?:\/\/[^\s)]+/);
    if (fwd) end += fwd[0].length;
    end = walkForwardThroughTrailers(text, end);
    if (overlapsExisting(candidates, start, end)) continue;
    candidates.push(makeCandidate({
      text, start, end,
      provisional_type: 'news_article',
      pattern_name: 'secondary-news',
    }));
  }

  // -- Article (R. 16): journal-with-volume-and-page or no-volume
  //    Articles classified as 'article' so book/article validators can
  //    branch on type.
  ARTICLE_END_RE.lastIndex = 0;
  while ((m = ARTICLE_END_RE.exec(text)) !== null) {
    const matchStart = m.index;
    const matchEnd = m.index + m[0].length;
    const start = walkBackToCitationStart(text, matchStart);
    const end = walkForwardThroughTrailers(text, matchEnd);
    candidates.push(makeCandidate({
      text, start, end,
      provisional_type: 'article',
      pattern_name: 'secondary-article',
    }));
  }

  // -- Book (R. 15): more permissive — any citation that ends in a
  //    section/page followed by a year-parenthetical and starts with a
  //    person-name pattern (Initials + surname). To avoid double-firing
  //    on articles, we'll filter overlaps later.
  BOOK_END_RE.lastIndex = 0;
  while ((m = BOOK_END_RE.exec(text)) !== null) {
    const matchStart = m.index;
    const matchEnd = m.index + m[0].length;
    const start = walkBackToCitationStart(text, matchStart);
    const end = walkForwardThroughTrailers(text, matchEnd);
    const candText = text.slice(start, end);
    // Heuristic — books always have an author name with at least one comma
    // separating author from title. Reject candidates whose head doesn't
    // look like a person name.
    if (!looksLikeAuthorTitleStart(candText)) continue;
    // Round 16 — reject anything that's actually a CASE citation (contains
    // " v. " or "vs."). The case extractor in citation-patterns.js handles
    // these; double-classifying as a book triggers spurious R. 15.4 flags
    // on case citations like "Stoneridge ... 552 U.S. 148, 158 (2008)".
    if (/\s+(?:v\.|v\b|vs\.|vs\b)\s+/.test(candText)) continue;
    // Skip if this overlaps a journal/article match already.
    if (overlapsExisting(candidates, start, end)) continue;
    candidates.push(makeCandidate({
      text, start, end,
      provisional_type: 'book',
      pattern_name: 'secondary-book',
    }));
  }

  // De-duplicate exact spans and prefer the LONGER match where two
  // candidates overlap.
  return dedupeBySpan(candidates);
}

function makeCandidate({ text, start, end, provisional_type, pattern_name }) {
  const candidateText = text.slice(start, end);
  return {
    pattern_name,
    provisional_type,
    candidate_text: candidateText,
    char_start: start,
    char_end: end,
    pre_context: text.slice(Math.max(0, start - 300), start),
    post_context: text.slice(end, Math.min(text.length, end + 300)),
    in_footnote: false,
    footnote_num: null,
  };
}

/**
 * Round 26 — corporate-suffix exclusion list. Real book authors do NOT
 * have a corporate-entity suffix in the author-name position; case parties
 * almost always do. When the book extractor's walk-back stops at a token
 * like "Council, Inc." (the second corporate party in a case caption),
 * looksLikeAuthorTitleStart was happily accepting it because the author-
 * shape regex reads "I" of "Inc." as the start of the book title. The
 * head then matches even though "Council, Inc." is actually a case-party
 * fragment, not "<author>, <title>".
 *
 * The user-visible bug this fixes: Chevron's case citation
 * "Chevron U.S.A., Inc. v. Nat. Res. Def. Council, Inc., 467 U.S. 837..."
 * was producing a duplicate R. 3.2(a) comment with a truncated suggested
 * fix starting at "Council, Inc." — because the book extractor walked
 * back only to the second "Inc." and the validator then ran on that
 * truncated span. The cross-extractor span dedup in the orchestrator is
 * the primary fix; this is a belt-and-suspenders rejection at the source.
 *
 * The pattern matches a corporate suffix anywhere in the first ~60
 * characters of the head (the author/title prefix region). Both
 * punctuated and unpunctuated forms are covered so "LLC", "L.L.C.",
 * "Inc", "Inc." all hit.
 */
const CORPORATE_SUFFIX_RE =
  /\b(?:Inc|Corp|Co|LLC|L\.L\.C|Ltd|LLP|L\.L\.P|N\.A|P\.C|P\.A)\.?(?:,|$|\s)/;

function looksLikeAuthorTitleStart(text) {
  // Drop optional leading volume-number prefix.
  const stripped = text.replace(/^\s*\d{1,4}[A-Z]?\s+/, '');
  // Author shape: capitalized first name (or initial), optional middle,
  // surname — with optional comma-separated co-authors. Then comma + title.
  if (
    !/^([A-Z][\w'\.\-]*(?:\s+[A-Z][\w'\.\-]*){0,4})(?:\s*[,&]\s*[A-Z][\w'\.\-]*(?:\s+[A-Z][\w'\.\-]*){0,4}){0,3}\s*,\s*[A-Z]/.test(stripped)
  ) {
    return false;
  }
  // Round 26 — reject heads whose author/title prefix region contains a
  // corporate-entity suffix token. The first 60 chars cover the author
  // line + the start of the title, which is more than enough to catch
  // case-party fragments like "Council, Inc., 467 U.S. 837..." while
  // leaving real book heads untouched (real authors don't carry Inc./
  // Corp./LLC in the author position).
  const head = stripped.slice(0, 60);
  if (CORPORATE_SUFFIX_RE.test(head)) return false;
  return true;
}

function overlapsExisting(existing, start, end) {
  for (const c of existing) {
    // Any nonzero overlap.
    if (start < c.char_end && end > c.char_start) return true;
  }
  return false;
}

function dedupeBySpan(candidates) {
  // Sort by start ascending, length descending. Drop later candidates
  // whose span is fully contained within an earlier one OR whose span
  // EXACTLY MATCHES an earlier one (e.g., MANUSCRIPT_TAIL_RE finding
  // both "(unpublished manuscript)" and "(on file with...)" in the same
  // citation produces two identical spans — keep only the first).
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
