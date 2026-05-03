/**
 * DOCX markup — JS port of scripts/markup_docx.py.
 *
 * Produces native Word tracked changes (<w:ins>, <w:del>) and real Word
 * comments (comments.xml + commentRangeStart/End + commentReference) so
 * the counterparty can Accept/Reject and reply in Word.
 *
 * Format-in-format-out rule (CLAUDE.md §4.4): we edit the DOCX in place —
 * the output is a byte-different .docx that opens and behaves identically
 * except for our additions.
 *
 * Where proposed replacement text goes (CLAUDE.md §4.5 for DOCX):
 *   - 'replace' → <w:del> on source_text + adjacent <w:ins> with suggested_text
 *   - 'insert'  → <w:ins> with suggested_text anchored after anchor_text
 *   - 'delete'  → <w:del> on source_text (no insertion)
 *   - 'annotate'→ no text change; just a comment attached to source_text
 *
 * Comment body = external_comment ONLY. Never duplicate the replacement
 * text inside the comment — the counterparty sees it on the page face
 * via the tracked insertion.
 *
 * BUG 2 (Wave 3 fix): full-paragraph source_text matches now collapse
 * the entire <w:p> on Accept. The paragraph mark is deleted via
 * <w:pPr><w:rPr><w:del/></w:rPr></w:pPr>, every child run is wrapped
 * in <w:del>, and <w:t> is converted to <w:delText> inside. This
 * replaces the prior behavior that left an unchanged copy of the
 * original paragraph, so "Accept All" now actually removes the clause.
 *
 * BUG 2 (Change C): a post-assembly verification step simulates
 * Accept-All and asserts each finding's source_text disappeared (and
 * suggested_text appeared, for replace/insert). Failed findings move
 * to the unanchored list with a distinct reason code rather than
 * shipping a redline that silently didn't edit the text.
 */
import JSZip from 'jszip';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const CONTENT_TYPES_PATH = '[Content_Types].xml';
const DOCUMENT_PATH = 'word/document.xml';
const COMMENTS_PATH = 'word/comments.xml';
const RELS_PATH = 'word/_rels/document.xml.rels';

const DEFAULT_AUTHOR = 'Legal Overflow';
const DEFAULT_INITIALS = 'LO';

// AUTHOR / INITIALS are set per-invocation by applyDocxMarkup() and read
// by the helper functions below (buildMarkupXml, buildFullParagraphMarkup,
// buildCommentsXml). Per-invocation mutability is acceptable here because
// applyDocxMarkup runs serially within a single fanout-background
// invocation — the markup helpers are not concurrent across reviews.
let AUTHOR = DEFAULT_AUTHOR;
let INITIALS = DEFAULT_INITIALS;

function deriveInitials(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return DEFAULT_INITIALS;
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Apply an array of finding objects to a DOCX buffer. Returns a new Buffer.
 *
 * @param {Buffer} docxBuffer — input DOCX bytes
 * @param {Array<Finding>} findings — findings from specialist fan-out
 * @param {object}  [options]
 * @param {string}  [options.author='Legal Overflow'] — name to attribute on tracked changes + comments
 * @returns {Promise<{ buffer: Buffer, applied: number, unanchored: Finding[] }>}
 */
export async function applyDocxMarkup(docxBuffer, findings, options = {}) {
  AUTHOR = (options.author && String(options.author).trim()) || DEFAULT_AUTHOR;
  INITIALS = deriveInitials(AUTHOR);
  const zip = await JSZip.loadAsync(docxBuffer);

  const documentXml = await zip.file(DOCUMENT_PATH).async('string');
  let modifiedXml = documentXml;

  const existingComments = zip.file(COMMENTS_PATH)
    ? await zip.file(COMMENTS_PATH).async('string')
    : null;

  let commentIdCounter = highestCommentId(existingComments) + 1;
  const commentsToAppend = [];
  const applied = [];
  const unanchored = [];

  for (const f of findings) {
    const { markup_type, source_text, suggested_text, anchor_text, external_comment } = f;

    // Round 4 anchor-reliability: specialists sometimes wrap source_text in a
    // citation prefix like "Section 4.2: 'actual quoted contract text…'" — that
    // prefix never appears in the contract, so locateText fails. Strip the
    // wrapper before searching.
    const rawSearchText = source_text || anchor_text || '';
    const stripped = stripQuotedSectionPrefix(rawSearchText);
    let searchText = stripped || rawSearchText;

    // For insert findings without a usable searchText, try to derive an anchor
    // from the suggested_text's section number (e.g. "10.5 …" → place after the
    // existing 10.4). Falls back to unanchored if no derivation works.
    if (markup_type === 'insert' && (!searchText || searchText.length < 8)) {
      const paragraphs = enumerateParagraphs(modifiedXml);
      const cid = commentIdCounter;
      const result = tryInsertWithDerivedAnchor(
        modifiedXml,
        paragraphs,
        suggested_text || '',
        cid,
      );
      if (result) {
        modifiedXml = result.modifiedXml;
        commentIdCounter += 1;
        if (external_comment) commentsToAppend.push({ id: cid, text: external_comment });
        applied.push(f);
        continue;
      }
      unanchored.push(f);
      continue;
    }

    if (!searchText || searchText.length < 8) {
      unanchored.push(f);
      continue;
    }

    // Each pass re-enumerates paragraphs since prior splices have shifted offsets.
    const paragraphs = enumerateParagraphs(modifiedXml);

    // Round 5 — multi-instance disambiguation: if `searchText` is short
    // (under 30 chars after normalization) AND occurs more than once in the
    // document body, anchoring on the first hit is unsafe — the deletion
    // lands on whichever instance happens to come first, but the OTHER
    // instances stay put. Verification then flags it because source_text
    // is still present in the accepted view. Better to mark it unanchored
    // with a clear reason so the user can either accept the verification
    // failure or have the specialist refine the source_text with leading
    // context to make it unique.
    const occurrenceCount = countOccurrences(modifiedXml, searchText);
    if (occurrenceCount > 1 && normalizeForCompare(searchText).length < 30) {
      f._markup_failure_reason = 'short_source_text_matches_multiple_instances';
      f._markup_failure_detail =
        `source_text "${normalizeForCompare(searchText).slice(0, 60)}" appears ` +
        `${occurrenceCount} times — needs more leading context to be unique.`;
      console.log(`[markup-locate] AMBIGUOUS ${f.id || f.category || '(unnamed)'}: ${f._markup_failure_detail}`);
      unanchored.push(f);
      continue;
    }

    let location = locateText(modifiedXml, searchText, paragraphs);

    // Round 4 fallback: if the stripped quoted text didn't anchor, try the raw
    // form (some specialists emit just the inner quote without the wrapper, but
    // the wrapper-strip itself can over-trim if the contract really does include
    // a "Section X:" lead-in).
    if (location == null && stripped && stripped !== rawSearchText) {
      location = locateText(modifiedXml, rawSearchText, paragraphs);
      if (location != null) searchText = rawSearchText;
    }

    if (location == null) {
      unanchored.push(f);
      continue;
    }

    const cid = commentIdCounter++;

    let replacement;
    let spliceStart;
    let spliceEnd;

    if (location.isFullParagraph && markup_type !== 'insert' && markup_type !== 'annotate') {
      // Full-paragraph deletion or replacement — operate on <w:p> boundaries
      replacement = buildFullParagraphMarkup({
        markupType: markup_type,
        paragraphXmls: location.spanParagraphXmls,
        suggestedText: suggested_text || '',
        commentId: cid,
      });
      spliceStart = location.spanStart;
      spliceEnd = location.spanEnd;
    } else {
      // Partial match inside a paragraph — run-level splice (existing behavior)
      replacement = buildMarkupXml({
        markupType: markup_type,
        sourceText: source_text,
        suggestedText: suggested_text || '',
        commentId: cid,
        originalRunXml: location.runXml,
      });
      spliceStart = location.start;
      spliceEnd = location.end;
    }

    modifiedXml = modifiedXml.slice(0, spliceStart) + replacement + modifiedXml.slice(spliceEnd);

    if (external_comment) {
      commentsToAppend.push({ id: cid, text: external_comment });
    }
    applied.push(f);
  }

  if (commentsToAppend.length > 0) {
    const commentsXml = buildCommentsXml(existingComments, commentsToAppend);
    zip.file(COMMENTS_PATH, commentsXml);

    await ensureCommentsContentType(zip);
    await ensureCommentsRelationship(zip);
  }

  // Add <w:trackChanges/> to settings.xml so the document opens with
  // Track Changes mode active. Effect: any new edits the reviewer types
  // are also tracked (not just our existing redlines). The Review
  // ribbon's Track Changes button shows as toggled on. Pure UX polish —
  // doesn't affect the existing <w:del>/<w:ins> tags we wrote above.
  await ensureTrackChangesEnabled(zip);

  zip.file(DOCUMENT_PATH, modifiedXml);

  // --- Change C: post-assembly verification (simulate Accept-All) ---
  const verifiedApplied = [];
  const verificationFailed = [];
  const acceptedText = simulateAcceptAll(modifiedXml);
  const acceptedNormalized = normalizeForCompare(acceptedText);

  for (const f of applied) {
    const check = verifyFinding(f, acceptedNormalized);
    if (check.ok) {
      verifiedApplied.push(f);
    } else {
      // Mark the finding so the UI / summary can surface the failure reason
      f._markup_failure_reason = 'anchored_but_markup_failed_verification';
      f._markup_failure_detail = check.reason;
      console.log(`[markup-verification] FAIL ${f.id || f.category || '(unnamed)'}: ${check.reason}`);
      verificationFailed.push(f);
    }
  }
  // Failed findings move to unanchored
  unanchored.push(...verificationFailed);

  const outBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  return { buffer: outBuffer, applied: verifiedApplied.length, unanchored };
}

// ================================================================
// Paragraph / text location
// ================================================================

/**
 * Enumerate every <w:p>...</w:p> block with its byte offsets and plain text.
 */
function enumerateParagraphs(xml) {
  const pRegex = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
  const paragraphs = [];
  let m;
  while ((m = pRegex.exec(xml)) !== null) {
    paragraphs.push({
      start: m.index,
      end: m.index + m[0].length,
      xml: m[0],
      text: extractParagraphText(m[0]),
    });
  }
  return paragraphs;
}

/**
 * Plain text of a paragraph — concatenates every <w:t> content inside it.
 */
function extractParagraphText(pXml) {
  let text = '';
  const tRegex = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let m;
  while ((m = tRegex.exec(pXml)) !== null) {
    text += decodeXml(m[1]);
  }
  return text;
}

/**
 * Normalize a string for comparison: unify smart quotes, collapse
 * whitespace, trim. Used for both locator matching and post-assembly
 * verification so the two always agree.
 */
function normalizeForCompare(s) {
  return String(s || '')
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Count occurrences of `needle` in the document XML's plain-text projection.
 * Used by the multi-instance guard before locateText \u2014 short generic phrases
 * like "sixty (60) days" can occur in three or four sections of an MSA;
 * anchoring on the first hit silently mis-strikes one and leaves the others
 * untouched. The caller treats > 1 as "ambiguous, mark unanchored with reason."
 */
function countOccurrences(xml, needle) {
  // Project the XML to plain text the same way locateText does (concatenated
  // <w:t> contents) so the count matches the locator's view.
  const tRegex = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let plain = '';
  let m;
  while ((m = tRegex.exec(xml)) !== null) {
    plain += decodeXml(m[1]);
  }
  const plainNorm = normalizeForCompare(plain);
  const needleNorm = normalizeForCompare(needle);
  if (!needleNorm) return 0;
  let count = 0;
  let i = 0;
  while (true) {
    const at = plainNorm.indexOf(needleNorm, i);
    if (at < 0) break;
    count++;
    i = at + needleNorm.length;
  }
  return count;
}

/**
 * Locate a substring in the document XML by scanning <w:t> text content.
 * Returns the byte offset range covering the parent <w:r> run + the
 * enclosing <w:p>'s boundaries, and a flag indicating whether the match
 * is a FULL paragraph (or span of paragraphs) vs a partial intra-paragraph
 * match. Callers branch on isFullParagraph for Bug 2 handling.
 */
function locateText(xml, needle, paragraphs) {
  // Build a parallel "plain text + offset map" over all <w:t> runs, find
  // the needle in the plain text, then translate back to the enclosing
  // <w:r>'s XML offsets.
  const textRunRegex = /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g;
  const runs = [];
  let plain = '';
  let match;
  while ((match = textRunRegex.exec(xml)) !== null) {
    const runXml = match[0];
    const runStart = match.index;
    const runEnd = match.index + runXml.length;
    const textMatch = runXml.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/);
    const runText = textMatch ? decodeXml(textMatch[1]) : '';
    runs.push({ runStart, runEnd, runXml, plainOffset: plain.length, text: runText });
    plain += runText;
  }

  const needleNormalized = normalizeForCompare(needle);
  const plainNormalized = normalizeForCompare(plain);
  const idx = plainNormalized.indexOf(needleNormalized);
  if (idx === -1) return null;

  // Find which run contains the match start. Use strict > on the upper
  // bound so that a match starting exactly at a run boundary (end of run
  // N = start of run N+1) correctly picks the run where the match actually
  // begins, not the preceding run that merely ends there. This was the
  // Bug 2 root cause — the boundary picked the Section-heading run
  // instead of the body-paragraph run, which made the full-paragraph
  // match detection fail and the deletion land in the wrong paragraph.
  let startRun = null;
  for (const r of runs) {
    const rNormalizedOffset = r.plainOffset - countCompressed(plain.slice(0, r.plainOffset));
    if (rNormalizedOffset <= idx && rNormalizedOffset + normalizeForCompare(r.text).length > idx) {
      startRun = r;
      break;
    }
  }
  if (!startRun) return null;

  // Find the paragraph containing that run
  const containingParagraph = paragraphs.find(p => p.start <= startRun.runStart && startRun.runStart < p.end);
  if (!containingParagraph) {
    // Fall back to run-level behavior if we can't locate the paragraph
    return {
      start: startRun.runStart,
      end: startRun.runEnd,
      runXml: startRun.runXml,
      matchedText: needleNormalized,
      isFullParagraph: false,
    };
  }

  // Check for full-paragraph match (single paragraph)
  const paragraphNormalized = normalizeForCompare(containingParagraph.text);
  if (paragraphNormalized === needleNormalized) {
    return {
      start: startRun.runStart,
      end: startRun.runEnd,
      runXml: startRun.runXml,
      matchedText: needleNormalized,
      isFullParagraph: true,
      spanStart: containingParagraph.start,
      spanEnd: containingParagraph.end,
      spanParagraphXmls: [containingParagraph.xml],
    };
  }

  // Check for multi-paragraph span: needle starts at this paragraph and
  // extends through subsequent full paragraphs.
  if (needleNormalized.startsWith(paragraphNormalized) && paragraphNormalized.length > 0) {
    const startIdx = paragraphs.indexOf(containingParagraph);
    let cumulative = paragraphNormalized;
    const spanXmls = [containingParagraph.xml];
    let spanEndOffset = containingParagraph.end;

    for (let i = startIdx + 1; i < paragraphs.length; i++) {
      const nextNorm = normalizeForCompare(paragraphs[i].text);
      if (!nextNorm) continue;
      const combined = (cumulative + ' ' + nextNorm).trim();
      if (combined === needleNormalized) {
        spanXmls.push(paragraphs[i].xml);
        spanEndOffset = paragraphs[i].end;
        return {
          start: startRun.runStart,
          end: startRun.runEnd,
          runXml: startRun.runXml,
          matchedText: needleNormalized,
          isFullParagraph: true,
          spanStart: containingParagraph.start,
          spanEnd: spanEndOffset,
          spanParagraphXmls: spanXmls,
        };
      }
      if (!needleNormalized.startsWith(combined)) break;
      spanXmls.push(paragraphs[i].xml);
      spanEndOffset = paragraphs[i].end;
      cumulative = combined;
    }
  }

  // Partial match inside a single paragraph — use run-level splice
  return {
    start: startRun.runStart,
    end: startRun.runEnd,
    runXml: startRun.runXml,
    matchedText: needleNormalized,
    isFullParagraph: false,
  };
}

function countCompressed(s) {
  const orig = s.length;
  const norm = s.replace(/\s+/g, ' ').length;
  return orig - norm;
}

function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function encodeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ================================================================
// Round 4 — anchor-reliability helpers
// ================================================================

/**
 * Strip a quoted-section prefix from `source_text` so the inner quote can be
 * located in the document.
 *
 * Specialists sometimes emit source_text shaped like:
 *
 *   Section 4.2: "Customer shall pay all invoices within sixty (60) days…"
 *   Section 10.1 GOVERNING LAW: "This Agreement shall be governed by…"
 *   Section 7.3 AS USED: "The term Confidential Information shall mean…"
 *
 * The prefix never appears in the contract body that way — the contract has the
 * heading on its own line and the prose on subsequent lines. To anchor, we
 * peel the wrapper and return the inner quoted contract text.
 *
 * Composite citations ("Section 4.2 + Section 4.3", "Section 4.2 AND Section
 * 4.3", "Section 4.2 COMBINED WITH Section 4.3") are flattened to the inner
 * quoted text of the FIRST section — locateText handles cross-paragraph
 * matching from there.
 *
 * Returns null when the input doesn't match the wrapper shape — caller falls
 * back to the original text.
 */
function stripQuotedSectionPrefix(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();

  // -------- Pass 1: quoted form (preferred — most reliable). --------
  //   Section 4.2: "Customer shall pay..."
  //   Section 10.1 GOVERNING LAW: "This Agreement..."
  // The opening quote anchors the match; the LAST matching close quote is
  // the end of the contract excerpt.
  const wrapper = /Section\s+[\d.()a-zA-Z]+(?:\s+[^:'"]{1,80}?)?\s*:\s*['"‘’“”]/;
  const qm = trimmed.match(wrapper);
  if (qm) {
    const startQuoteIdx = qm.index + qm[0].length - 1;
    const openQuote = trimmed[startQuoteIdx];
    const closeQuote =
      openQuote === '‘' ? '’' :
      openQuote === '“' ? '”' :
      openQuote;
    const innerStart = startQuoteIdx + 1;
    let innerEnd = trimmed.lastIndexOf(closeQuote);
    if (innerEnd <= innerStart) {
      innerEnd = trimmed.indexOf(closeQuote, innerStart);
    }
    if (innerEnd > innerStart) {
      const inner = trimmed.slice(innerStart, innerEnd).trim();
      if (inner && inner.length >= 8) return inner;
    }
  }

  // -------- Pass 2: unquoted composite form. --------
  //   Section 9.1: Lattice may engage subcontractors without notice or
  //     consent + Section 8.6: ...
  //   Section 3.4: If any amount owing... AND Section 8.5: ...
  //
  // Take whatever comes between the FIRST `Section X.Y:` and the FIRST
  // composite separator (` + Section`, ` AND Section`, ` COMBINED WITH
  // Section`). That slice is the candidate contract text from the first
  // cited section — locateText handles cross-paragraph matching from
  // there.
  const colonForm = /Section\s+[\d.()a-zA-Z]+(?:\s+[^:'"+]{1,80}?)?\s*:\s+/;
  const cm = trimmed.match(colonForm);
  if (cm) {
    const innerStart = cm.index + cm[0].length;
    const rest = trimmed.slice(innerStart);
    // Composite separator: a " + Section ", " AND Section ", " OR Section ",
    // " COMBINED WITH Section ", or " IN COMBINATION WITH Section ".
    const sepRegex = /\s+(?:\+|AND|OR|COMBINED\s+WITH|IN\s+COMBINATION\s+WITH)\s+Section\s+[\d.()a-zA-Z]+/i;
    const sm = rest.match(sepRegex);
    let candidate = sm ? rest.slice(0, sm.index) : rest;
    candidate = candidate.trim().replace(/[,;.]+$/, '').trim();
    if (candidate && candidate.length >= 12) return candidate;
  }

  // No usable form found — caller falls back to the raw input.
  return null;
}

/**
 * For an `insert` finding with no source_text/anchor_text, try to derive an
 * anchor from the section number embedded in `suggested_text`. Example:
 *
 *   suggested_text starts with "10.5 Force Majeure. Neither party shall…"
 *   → look for paragraphs whose text begins with "10.4" (or "10.4.x"); the
 *     last one is the closest preceding section.
 *   → splice a new <w:p> immediately after that paragraph containing the
 *     suggested_text wrapped in <w:ins>, with a comment range around it.
 *
 * Returns { modifiedXml } on success, or null when no anchor could be derived.
 */
function tryInsertWithDerivedAnchor(xml, paragraphs, suggestedText, commentId) {
  if (!suggestedText || typeof suggestedText !== 'string') return null;

  // Extract the leading section number from the suggestion.
  const numMatch = suggestedText.trim().match(/^(?:Section\s+)?(\d+)(?:\.(\d+))?(?:\.(\d+))?\b/);
  if (!numMatch) return null;
  const major = parseInt(numMatch[1], 10);
  const minor = numMatch[2] != null ? parseInt(numMatch[2], 10) : null;
  if (!Number.isFinite(major)) return null;

  // Walk paragraphs and find the deepest preceding sibling whose number is in
  // the same major and lower minor. If we have no minor (just "10 …"), find
  // the last paragraph in major (10.x.x) — i.e., the section just before the
  // next major.
  let anchorIdx = -1;
  let bestKey = -1;
  for (let i = 0; i < paragraphs.length; i++) {
    const t = (paragraphs[i].text || '').trim();
    const pm = t.match(/^(?:Section\s+)?(\d+)(?:\.(\d+))?(?:\.(\d+))?\b/);
    if (!pm) continue;
    const pMajor = parseInt(pm[1], 10);
    if (pMajor !== major) continue;
    const pMinor = pm[2] != null ? parseInt(pm[2], 10) : 0;
    if (minor != null && pMinor >= minor) continue;
    // rank: prefer highest minor < target minor; ties broken by index (later wins).
    const key = pMinor * 1000 + i;
    if (key > bestKey) {
      bestKey = key;
      anchorIdx = i;
    }
  }

  if (anchorIdx < 0) return null;

  // Walk forward to the LAST paragraph of that section — i.e., until we hit
  // a paragraph whose major.minor differs from the anchor's.
  const anchorText = paragraphs[anchorIdx].text.trim();
  const am = anchorText.match(/^(?:Section\s+)?(\d+)(?:\.(\d+))?/);
  const aMajor = parseInt(am[1], 10);
  const aMinor = am[2] != null ? parseInt(am[2], 10) : 0;
  let lastIdx = anchorIdx;
  for (let i = anchorIdx + 1; i < paragraphs.length; i++) {
    const t = (paragraphs[i].text || '').trim();
    const pm = t.match(/^(?:Section\s+)?(\d+)(?:\.(\d+))?/);
    if (!pm) {
      // unnumbered continuation — assume it belongs to the current section.
      lastIdx = i;
      continue;
    }
    const pMajor = parseInt(pm[1], 10);
    const pMinor = pm[2] != null ? parseInt(pm[2], 10) : 0;
    if (pMajor === aMajor && pMinor === aMinor) {
      lastIdx = i;
      continue;
    }
    // Different section reached — stop.
    break;
  }

  // Splice a new <w:p>…</w:p> with the insertion AFTER paragraphs[lastIdx].
  const ts = new Date().toISOString();
  // Inherit the anchor paragraph's pPr (sans rPr) so the inserted paragraph
  // matches the surrounding style — heading level, indentation, etc.
  const anchorXml = paragraphs[lastIdx].xml;
  const pPrMatch = anchorXml.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/);
  const cleanPPrBody = pPrMatch ? pPrMatch[1].replace(/<w:rPr>[\s\S]*?<\/w:rPr>/g, '') : '';
  const cleanPPr = cleanPPrBody ? `<w:pPr>${cleanPPrBody}</w:pPr>` : '';
  const insertedParagraph =
    `<w:p>${cleanPPr}` +
    `<w:commentRangeStart w:id="${commentId}"/>` +
    `<w:ins w:id="${commentId + 2000}" w:author="${AUTHOR}" w:date="${ts}">` +
    `<w:r><w:t xml:space="preserve">${encodeXml(suggestedText)}</w:t></w:r>` +
    `</w:ins>` +
    `<w:commentRangeEnd w:id="${commentId}"/>` +
    `<w:r><w:commentReference w:id="${commentId}"/></w:r>` +
    `</w:p>`;

  const insertAt = paragraphs[lastIdx].end;
  const modifiedXml = xml.slice(0, insertAt) + insertedParagraph + xml.slice(insertAt);
  return { modifiedXml };
}

// ================================================================
// Markup builders
// ================================================================

/**
 * Build tracked-change XML for a PARTIAL match inside a single paragraph.
 * This is the original Wave 1/2 behavior, preserved for intra-paragraph
 * edits (one sentence inside a multi-sentence paragraph, etc.).
 */
function buildMarkupXml({ markupType, sourceText, suggestedText, commentId, originalRunXml }) {
  const ts = new Date().toISOString();
  const commentStart = `<w:commentRangeStart w:id="${commentId}"/>`;
  // Split the closing markers so we can place the rangeEnd between the
  // deletion and the insertion (for `replace`), with the marker reference
  // at the end of the change. Other markup types still use the combined
  // closing block via `commentEnd`.
  const commentRangeEnd = `<w:commentRangeEnd w:id="${commentId}"/>`;
  const commentReference = `<w:r><w:commentReference w:id="${commentId}"/></w:r>`;
  const commentEnd = commentRangeEnd + commentReference;

  const rPrMatch = originalRunXml.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
  const rPr = rPrMatch ? rPrMatch[0] : '';

  let body = '';
  if (markupType === 'replace') {
    // Wrap the comment range around ONLY the deletion. Putting the
    // <w:ins> outside the comment range lets Word's inline "Accept or
    // reject" tooltip surface cleanly when the reviewer hovers over the
    // inserted text — without it, the comment-balloon overlay (which
    // covers the whole rangeStart..rangeEnd span) intercepts hover
    // events on the inserted text and Word shows the comment instead of
    // the accept/reject card.
    return (
      commentStart +
      `<w:del w:id="${commentId + 1000}" w:author="${AUTHOR}" w:date="${ts}"><w:r>${rPr}<w:delText xml:space="preserve">${encodeXml(sourceText)}</w:delText></w:r></w:del>` +
      commentRangeEnd +
      `<w:ins w:id="${commentId + 2000}" w:author="${AUTHOR}" w:date="${ts}"><w:r>${rPr}<w:t xml:space="preserve">${encodeXml(suggestedText)}</w:t></w:r></w:ins>` +
      commentReference
    );
  } else if (markupType === 'delete') {
    body =
      `<w:del w:id="${commentId + 1000}" w:author="${AUTHOR}" w:date="${ts}"><w:r>${rPr}<w:delText xml:space="preserve">${encodeXml(sourceText)}</w:delText></w:r></w:del>`;
  } else if (markupType === 'insert') {
    body =
      originalRunXml +
      `<w:ins w:id="${commentId + 2000}" w:author="${AUTHOR}" w:date="${ts}"><w:r>${rPr}<w:t xml:space="preserve">${encodeXml(suggestedText)}</w:t></w:r></w:ins>`;
    return commentStart + body + commentEnd;
  } else {
    // annotate — comment-only, no document-body modification.
    //
    // Round 22 — split the run when the citation is a SUBSTRING of the
    // run's text. Without this split, the comment range wrapped the
    // entire run including prose AFTER the citation (e.g., comment on
    // "Westmoreland v. ..., 924 F.3d 718, 725-26 (4th Cir. 2019)" extended
    // through ". At a minimum, those statements...").
    const split = splitRunForAnnotation(originalRunXml, sourceText);
    if (split) {
      // Three runs: before (no comment), middle (wrapped in commentRange),
      // after (no comment).
      return split.before + commentStart + split.middle + commentEnd + split.after;
    }
    // Fall back to wrapping the entire run if we can't cleanly split.
    body = originalRunXml;
  }

  return commentStart + body + commentEnd;
}

/**
 * Split a `<w:r>` run into [before][needle][after] sub-runs based on the
 * needle's position within the run's text content. Returns null if the
 * needle isn't found in the run's text or if the run lacks a `<w:t>` element.
 *
 * The before/after sub-runs preserve the original run's properties (rPr,
 * attributes); the middle sub-run is the same shape but contains only the
 * needle text.
 */
function splitRunForAnnotation(originalRunXml, needle) {
  if (!needle) return null;
  // Extract the run's opening tag (preserving any attributes), the rPr if
  // present, and the <w:t>...</w:t> content.
  const openMatch = originalRunXml.match(/^(<w:r(?:\s[^>]*)?>)/);
  if (!openMatch) return null;
  const runOpen = openMatch[1];
  const rPrMatch = originalRunXml.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
  const rPrXml = rPrMatch ? rPrMatch[0] : '';
  const tMatch = originalRunXml.match(/(<w:t(?:\s[^>]*)?>)([\s\S]*?)(<\/w:t>)/);
  if (!tMatch) return null;
  const tOpen = tMatch[1];
  const tCloseTag = tMatch[3];
  const rawTextEncoded = tMatch[2];
  const rawText = decodeXml(rawTextEncoded);

  // Try to locate the needle in the run's raw text. First try direct
  // substring match. If that fails, try a normalized-equivalent match
  // and translate back via offset counting.
  let needleStart = rawText.indexOf(needle);
  let needleLen = needle.length;
  if (needleStart < 0) {
    const rawNorm = normalizeForCompare(rawText);
    const needleNorm = normalizeForCompare(needle);
    const normIdx = rawNorm.indexOf(needleNorm);
    if (normIdx < 0) return null;
    // Walk through rawText counting normalized characters until we reach normIdx.
    let raw = 0, norm = 0;
    while (raw < rawText.length && norm < normIdx) {
      const ch = rawText[raw];
      const isWS = /\s/.test(ch);
      // Whitespace runs collapse to one space in normalize.
      if (isWS) {
        // Only count this whitespace if the previous normalized char wasn't whitespace.
        if (norm === 0 || normalizeForCompare(rawText.slice(0, raw + 1)).length > norm) norm++;
      } else {
        norm++;
      }
      raw++;
    }
    needleStart = raw;
    // Find the end the same way.
    let endRaw = raw, endNorm = norm;
    while (endRaw < rawText.length && endNorm < normIdx + needleNorm.length) {
      const ch = rawText[endRaw];
      const isWS = /\s/.test(ch);
      if (isWS) {
        if (endNorm === 0 || normalizeForCompare(rawText.slice(0, endRaw + 1)).length > endNorm) endNorm++;
      } else {
        endNorm++;
      }
      endRaw++;
    }
    needleLen = endRaw - raw;
  }

  const before = rawText.slice(0, needleStart);
  const middle = rawText.slice(needleStart, needleStart + needleLen);
  const after = rawText.slice(needleStart + needleLen);

  // If the needle covers the entire run, no split needed — fall through to
  // the whole-run wrap.
  if (!before && !after) return null;

  function makeRun(text) {
    if (!text) return '';
    return `${runOpen}${rPrXml}${tOpen}${encodeXml(text)}${tCloseTag}</w:r>`;
  }

  return {
    before: makeRun(before),
    middle: makeRun(middle),
    after: makeRun(after),
  };
}

/**
 * Build tracked-change XML for a FULL-paragraph (or multi-paragraph span)
 * deletion or replacement.
 *
 * For each paragraph in the span:
 *   - wraps every <w:r> in <w:del>, converting <w:t> to <w:delText>
 *   - adds <w:del/> inside <w:pPr><w:rPr> so the paragraph mark itself
 *     is deleted on Accept (collapses the paragraph; no empty orphan)
 * For markup_type=replace, emits a new <w:p> AFTER the deleted span
 * containing the suggested_text as an <w:ins>.
 */
function buildFullParagraphMarkup({ markupType, paragraphXmls, suggestedText, commentId }) {
  const ts = new Date().toISOString();
  const delIdBase = commentId + 1000;

  const deletedParas = paragraphXmls.map((pXml, i) => {
    const delIdForPMark = delIdBase + i * 3;
    const delIdForRuns = delIdBase + i * 3 + 1;

    // Preserve the paragraph's <w:pPr>, but strip any existing <w:rPr> inside
    // it (we'll inject our own with <w:del/> to mark the paragraph mark deleted).
    const pPrMatch = pXml.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/);
    const existingPPrBody = pPrMatch ? pPrMatch[1].replace(/<w:rPr>[\s\S]*?<\/w:rPr>/g, '') : '';
    const newPPr =
      `<w:pPr>${existingPPrBody}` +
      `<w:rPr><w:del w:id="${delIdForPMark}" w:author="${AUTHOR}" w:date="${ts}"/></w:rPr>` +
      `</w:pPr>`;

    // Extract the paragraph's inner content WITHOUT the opening/closing <w:p> tags
    // and WITHOUT the existing <w:pPr> (we replaced it above).
    const innerMatch = pXml.match(/^<w:p(?:\s[^>]*)?>([\s\S]*)<\/w:p>$/);
    let inner = innerMatch ? innerMatch[1] : pXml;
    inner = inner.replace(/<w:pPr>[\s\S]*?<\/w:pPr>/, '');

    // Wrap every <w:r>...</w:r> in <w:del> and convert <w:t> to <w:delText>
    let runIdx = 0;
    const wrappedRuns = inner.replace(
      /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g,
      (runXml) => {
        const converted = runXml.replace(
          /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g,
          (_, content) => `<w:delText xml:space="preserve">${content}</w:delText>`,
        );
        runIdx++;
        return `<w:del w:id="${delIdForRuns}" w:author="${AUTHOR}" w:date="${ts}">${converted}</w:del>`;
      },
    );

    // Comment markers: start on first paragraph, end on last. Both also get a
    // commentReference run for the sidebar anchor.
    const isFirst = i === 0;
    const isLast = i === paragraphXmls.length - 1;
    const commentStart = isFirst ? `<w:commentRangeStart w:id="${commentId}"/>` : '';
    const commentEnd = isLast
      ? `<w:commentRangeEnd w:id="${commentId}"/><w:r><w:commentReference w:id="${commentId}"/></w:r>`
      : '';

    return `<w:p>${newPPr}${commentStart}${wrappedRuns}${commentEnd}</w:p>`;
  }).join('');

  if (markupType === 'replace' && suggestedText) {
    // Emit an inserted paragraph after the deleted span. Copy the first
    // original paragraph's <w:pPr> (sans rPr) so the inserted paragraph
    // inherits the same styling (heading level, etc.) as the original.
    const firstPPrMatch = paragraphXmls[0].match(/<w:pPr>([\s\S]*?)<\/w:pPr>/);
    const cleanPPrBody = firstPPrMatch ? firstPPrMatch[1].replace(/<w:rPr>[\s\S]*?<\/w:rPr>/g, '') : '';
    const cleanPPr = cleanPPrBody ? `<w:pPr>${cleanPPrBody}</w:pPr>` : '';
    const insertedParagraph =
      `<w:p>${cleanPPr}` +
      `<w:ins w:id="${commentId + 2000}" w:author="${AUTHOR}" w:date="${ts}">` +
      `<w:r><w:t xml:space="preserve">${encodeXml(suggestedText)}</w:t></w:r>` +
      `</w:ins>` +
      `</w:p>`;
    return deletedParas + insertedParagraph;
  }

  return deletedParas;
}

// ================================================================
// Comments / manifest bookkeeping (unchanged)
// ================================================================

function highestCommentId(existingCommentsXml) {
  if (!existingCommentsXml) return 0;
  const matches = [...existingCommentsXml.matchAll(/w:id="(\d+)"/g)].map(m => parseInt(m[1], 10));
  return matches.length ? Math.max(...matches) : 0;
}

function buildCommentsXml(existingXml, newComments) {
  const header = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:comments xmlns:w="${W_NS}">`;
  const footer = `</w:comments>`;
  const ts = new Date().toISOString();

  let existingBody = '';
  if (existingXml) {
    const inner = existingXml.match(/<w:comments[^>]*>([\s\S]*)<\/w:comments>/);
    if (inner) existingBody = inner[1];
  }

  const newBody = newComments
    .map(c =>
      `<w:comment w:id="${c.id}" w:author="${AUTHOR}" w:date="${ts}" w:initials="${INITIALS}">` +
      `<w:p><w:r><w:t xml:space="preserve">${encodeXml(c.text)}</w:t></w:r></w:p>` +
      `</w:comment>`
    )
    .join('');

  return header + existingBody + newBody + footer;
}

async function ensureCommentsContentType(zip) {
  const ctxFile = zip.file(CONTENT_TYPES_PATH);
  if (!ctxFile) return;
  let ctx = await ctxFile.async('string');
  if (ctx.includes('comments+xml')) return;
  const override = `<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>`;
  ctx = ctx.replace('</Types>', override + '</Types>');
  zip.file(CONTENT_TYPES_PATH, ctx);
}

async function ensureCommentsRelationship(zip) {
  const relsFile = zip.file(RELS_PATH);
  if (!relsFile) return;
  let rels = await relsFile.async('string');
  if (rels.includes('comments.xml')) return;
  const rId = nextRelId(rels);
  const newRel = `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>`;
  rels = rels.replace('</Relationships>', newRel + '</Relationships>');
  zip.file(RELS_PATH, rels);
}

/**
 * Add <w:trackChanges/> to word/settings.xml so the document opens with
 * Track Changes mode active. Idempotent — bails if the flag is already
 * present, otherwise inserts immediately after the opening <w:settings>
 * tag (per OOXML, child elements of w:settings have no required order).
 *
 * If word/settings.xml is missing entirely (some authoring tools omit
 * it), we create a minimal one with just the trackChanges flag.
 */
async function ensureTrackChangesEnabled(zip) {
  const SETTINGS_PATH = 'word/settings.xml';
  const settingsFile = zip.file(SETTINGS_PATH);

  if (!settingsFile) {
    // Create a minimal settings.xml. Word accepts this even without the
    // usual <w:zoom>, <w:defaultTabStop>, etc. — those default to sane
    // values. The settings.rels relationship is auto-discovered.
    const minimal =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:trackChanges/>` +
      `</w:settings>`;
    zip.file(SETTINGS_PATH, minimal);
    return;
  }

  let settings = await settingsFile.async('string');
  if (/<w:trackChanges\b/.test(settings)) return; // already enabled

  // Insert after the opening <w:settings ...> tag. Match the tag with
  // any namespace declarations / attributes.
  const updated = settings.replace(
    /(<w:settings\b[^>]*>)/,
    '$1<w:trackChanges/>',
  );
  zip.file(SETTINGS_PATH, updated);
}

function nextRelId(relsXml) {
  const nums = [...relsXml.matchAll(/Id="rId(\d+)"/g)].map(m => parseInt(m[1], 10));
  const max = nums.length ? Math.max(...nums) : 0;
  return `rId${max + 1}`;
}

// ================================================================
// Change C — post-assembly verification
// ================================================================

/**
 * Produce a plain-text "accepted" view by simulating Word's Accept All
 * Tracked Changes:
 *   1. Drop every paragraph whose pPr/rPr contains <w:del/>
 *      (paragraph mark was deleted → paragraph collapses)
 *   2. Drop every <w:del>...</w:del> block (deletions take effect)
 *   3. Unwrap every <w:ins>...</w:ins> (insertions take effect)
 *   4. Concatenate remaining <w:t> content
 */
function simulateAcceptAll(xml) {
  // Step 1: remove paragraphs whose pPr/rPr contains <w:del/>
  let x = xml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (pMatch) => {
    const pPrMatch = pMatch.match(/<w:pPr>[\s\S]*?<\/w:pPr>/);
    if (pPrMatch && /<w:rPr>[\s\S]*?<w:del\b[^>]*\/>/i.test(pPrMatch[0])) {
      return '';
    }
    return pMatch;
  });
  // Step 2: drop <w:del>...</w:del> blocks
  x = x.replace(/<w:del(?:\s[^>]*)?>[\s\S]*?<\/w:del>/g, '');
  // Step 3: unwrap <w:ins>...</w:ins> blocks (keep inner)
  x = x.replace(/<w:ins(?:\s[^>]*)?>([\s\S]*?)<\/w:ins>/g, '$1');
  // Step 4: pull all remaining <w:t> content, joined with spaces
  const texts = [];
  const tRegex = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let m;
  while ((m = tRegex.exec(x)) !== null) {
    texts.push(decodeXml(m[1]));
  }
  return texts.join(' ');
}

/**
 * Verify a single finding against the simulated-accept text. Returns
 * { ok: boolean, reason: string }. A minimum match length guards against
 * false positives on very short snippets that might incidentally appear
 * elsewhere in the document.
 */
function verifyFinding(f, acceptedNormalized) {
  const MIN_MATCH_LEN = 12; // chars; below this we can't reliably assert inclusion
  const srcNorm = normalizeForCompare(f.source_text || '');
  const sugNorm = normalizeForCompare(f.suggested_text || '');
  const type = f.markup_type;

  if (type === 'annotate') {
    // Annotate doesn't change text; nothing to verify.
    return { ok: true, reason: '' };
  }

  if (type === 'delete' || type === 'replace') {
    if (srcNorm.length >= MIN_MATCH_LEN && acceptedNormalized.includes(srcNorm)) {
      return {
        ok: false,
        reason: `source_text still present in accepted view (deletion did not take effect on Accept-All)`,
      };
    }
  }
  if (type === 'replace' || type === 'insert') {
    if (sugNorm.length >= MIN_MATCH_LEN && !acceptedNormalized.includes(sugNorm)) {
      return {
        ok: false,
        reason: `suggested_text missing from accepted view (insertion did not take effect on Accept-All)`,
      };
    }
  }
  return { ok: true, reason: '' };
}
