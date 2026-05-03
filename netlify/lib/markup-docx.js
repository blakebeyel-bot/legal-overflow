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

    const searchText = source_text || anchor_text || '';
    if (!searchText || searchText.length < 8) {
      unanchored.push(f);
      continue;
    }

    // Each pass re-enumerates paragraphs since prior splices have shifted offsets.
    const paragraphs = enumerateParagraphs(modifiedXml);
    const location = locateText(modifiedXml, searchText, paragraphs);
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
  const commentEnd = `<w:commentRangeEnd w:id="${commentId}"/><w:r><w:commentReference w:id="${commentId}"/></w:r>`;

  const rPrMatch = originalRunXml.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
  const rPr = rPrMatch ? rPrMatch[0] : '';

  let body = '';
  if (markupType === 'replace') {
    body =
      `<w:del w:id="${commentId + 1000}" w:author="${AUTHOR}" w:date="${ts}"><w:r>${rPr}<w:delText xml:space="preserve">${encodeXml(sourceText)}</w:delText></w:r></w:del>` +
      `<w:ins w:id="${commentId + 2000}" w:author="${AUTHOR}" w:date="${ts}"><w:r>${rPr}<w:t xml:space="preserve">${encodeXml(suggestedText)}</w:t></w:r></w:ins>`;
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
