/**
 * Markdown extraction for the document library.
 *
 * Synchronous extraction of PDF, DOCX, plaintext content from a
 * Buffer. Returns { text, chars, status, method, format } where:
 *   - status : 'done' | 'failed' | 'skipped' | 'pending_ocr'
 *   - method : 'pdfjs' | 'mammoth' | 'plain' | 'ocr' (set on success
 *              or 'pending_ocr')
 *   - format : 'plain' | 'markdown'
 *
 * For image files (PNG, JPEG, TIFF, HEIC, WEBP) and for PDFs whose
 * pdfjs extraction returns sparse text (the DocuSign / scanned case),
 * status is 'pending_ocr' and the caller (workspace-library-register)
 * should kick off the workspace-doc-extract-background OCR job.
 *
 * pdfjs-dist is required lazily because it's heavy. Mammoth is
 * loaded the same way to keep cold starts fast for non-DOCX uploads.
 */

import { isImageFile, shouldOcrPdf } from './ocr.js';

/**
 * Strip control characters Postgres won't accept on text columns.
 *
 * The big offender is U+0000 (NULL bytes) — PostgreSQL rejects them
 * outright with "unsupported Unicode escape sequence". DocuSign PDFs
 * routinely carry NULLs from their signature-stamp encoding, as do
 * some scanner outputs and weird OCR artifacts. We also strip other
 * non-printable C0 control chars (U+0001..U+0008, U+000B, U+000C,
 * U+000E..U+001F) that have no legitimate use in extracted document
 * text. Tab (U+0009), LF (U+000A), and CR (U+000D) are kept.
 *
 * Also strips lone U+FFFD replacement chars and DEL (U+007F).
 */
const CONTROL_CHAR_RE = new RegExp(
  '[' +
    '\\x00-\\x08' +    // NUL through BS
    '\\x0B\\x0C' +     // VT and FF
    '\\x0E-\\x1F' +    // SO through US
    '\\x7F' +          // DEL
    '\\uFFFD' +        // replacement char
  ']',
  'g',
);
function sanitizeForPg(text) {
  if (!text) return text;
  return String(text).replace(CONTROL_CHAR_RE, '');
}

/**
 * Detect "garbled" text — what you get when pdfjs extracts from a
 * PDF whose embedded fonts have no ToUnicode CMap. pdfjs hands back
 * raw glyph codes that visually look like ASCII punctuation or
 * Latin-1 supplement chars (mojibake). Common with DocuSign overlays,
 * heavily-edited contracts, and contracts produced by older drafting
 * software.
 *
 * Heuristic: real English/legal prose is at least ~50% letters.
 * Garbled mojibake passages are dominated by punctuation glyphs or
 * high-codepoint chars (è, ©, ±, etc.).
 *
 * Returns true when the text is too low-letter-fraction to be
 * useful prose. Empty or very short text returns false (we don't
 * have enough signal to judge).
 */
function looksGarbled(text) {
  const s = String(text || '');
  if (s.length < 80) return false;
  let letters = 0;
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch === 0x20 || ch === 0x09 || ch === 0x0A || ch === 0x0D) continue;
    total++;
    // Roman letters (incl. accented Latin): A-Z, a-z, plus the broad
    // "Latin" Unicode block ranges that genuine prose actually uses.
    if (
      (ch >= 0x41 && ch <= 0x5A) ||              // A-Z
      (ch >= 0x61 && ch <= 0x7A) ||              // a-z
      (ch >= 0xC0 && ch <= 0xFF && ch !== 0xD7 && ch !== 0xF7) ||  // Latin-1 letters
      (ch >= 0x100 && ch <= 0x17F)               // Latin Extended-A
    ) {
      letters++;
    }
  }
  if (total < 60) return false;
  return (letters / total) < 0.45;
}

const PDF_TYPES = new Set([
  'application/pdf',
  'application/x-pdf',
  'application/acrobat',
  'applications/vnd.pdf',
]);

const DOCX_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml',
  'application/octet-stream',  // sometimes browsers report DOCX this way
]);

const TEXT_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'text/html',
  'application/json',
  'application/xml',
  'text/csv',
]);

export async function extractTextFromBuffer({ buffer, fileType, filename }) {
  const ft = (fileType || '').toLowerCase();
  const ext = (filename || '').toLowerCase().split('.').pop();

  // Image files → defer to background OCR
  if (isImageFile({ fileType: ft, filename })) {
    return {
      text: '',
      chars: 0,
      status: 'pending_ocr',
      method: 'ocr',
      format: 'markdown',
      detail: 'Image file — OCR queued',
    };
  }

  // PDF — try pdfjs first; fall back to OCR if text is sparse.
  if (PDF_TYPES.has(ft) || ext === 'pdf') {
    return await extractPdf(buffer);
  }

  // DOCX (extension check protects against octet-stream false positives)
  if ((DOCX_TYPES.has(ft) && ext === 'docx') || ext === 'docx') {
    return await extractDocx(buffer);
  }

  // Plain text-like — wrap as markdown so downstream consumers can
  // assume markdown format universally.
  if (TEXT_TYPES.has(ft) || ['txt', 'md', 'markdown', 'csv', 'json', 'xml', 'html'].includes(ext)) {
    try {
      const raw = buffer.toString('utf8');
      const text = sanitizeForPg(raw);
      return {
        text,
        chars: text.length,
        status: 'done',
        method: 'plain',
        format: ext === 'md' || ext === 'markdown' ? 'markdown' : 'plain',
      };
    } catch (err) {
      return { text: '', chars: 0, status: 'failed', method: 'plain', format: 'plain', detail: err.message };
    }
  }

  return {
    text: '',
    chars: 0,
    status: 'skipped',
    method: null,
    format: 'plain',
    detail: `Unsupported file type: ${ft || ext}`,
  };
}

async function extractPdf(buffer) {
  try {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(buffer);
    const doc = await getDocument({
      data,
      useSystemFonts: true,
      disableFontFace: true,
    }).promise;

    const pageCount = doc.numPages;
    const parts = [];
    let totalBodyChars = 0;
    let garbledPages = 0;
    let anyAnnotations = false;
    for (let i = 1; i <= pageCount; i++) {
      try {
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();

        // Pull annotations FIRST so we can interleave them inline as
        // we walk text items. Markup-type annots (Highlight, StrikeOut,
        // Underline, Squiggly) carry quadPoints — boxes that bracket
        // the underlying text. We map each quad to the text-item index
        // range it covers, then emit `{{HIGHLIGHT: "..."}}` markers
        // INLINE in the page text. Non-quad annots (FreeText / Sticky
        // notes / Stamps) are anchored to the nearest text item by
        // y-coordinate so they appear near the prose they comment on.
        let rawAnnots = [];
        try {
          rawAnnots = await page.getAnnotations();
        } catch (err) {
          console.warn(`[pdf-annotations] page ${i}: ${err.message}`);
          rawAnnots = [];
        }
        const inlineAnchors = buildPdfAnnotationAnchors(rawAnnots, tc.items, i);

        // Walk text items in order; emit inline markup either
        // BEFORE the text item (for "anchor before" annots) or AFTER
        // (for "anchor after" annots). For Highlight/Strikeout etc.
        // we typically put the marker BEFORE the first item it covers
        // and a closing tag AFTER the last covered item — so the
        // chunk reads "the parties hereby {{HIGHLIGHT}}indemnify and
        // hold harmless{{/HIGHLIGHT}}…".
        let pageText = '';
        let lastY = null;
        for (let idx = 0; idx < tc.items.length; idx++) {
          const item = tc.items[idx];
          if (lastY !== null && item.transform && Math.abs(item.transform[5] - lastY) > 5) {
            pageText += '\n';
          }
          // Sticky-note / FreeText anchors keyed to this text item.
          // We emit BEFORE the text item (as a separate blockquote line)
          // so margin notes appear visually adjacent to the prose
          // they annotate. Always-emit (not gated on y-discontinuity)
          // so anchors on the first text item or contiguous lines also
          // render.
          if (inlineAnchors.lineAt[idx]) {
            for (const a of inlineAnchors.lineAt[idx]) {
              pageText += (pageText.endsWith('\n') || pageText === '' ? '' : '\n') + a + '\n';
            }
          }
          // Inline-open annotations starting at this text item
          for (const a of inlineAnchors.openAt[idx] || []) {
            pageText += a;
          }
          pageText += item.str || '';
          // Inline-close annotations ending at this text item
          for (const a of inlineAnchors.closeAt[idx] || []) {
            pageText += a;
          }
          if (item.hasEOL) pageText += '\n';
          if (item.transform) lastY = item.transform[5];
        }
        // Any non-quad annots that didn't anchor anywhere — emit at
        // the foot of the page rather than dropping them on the floor.
        const orphans = inlineAnchors.orphan;

        const pageBody = pageText.trim();
        totalBodyChars += pageBody.length;
        if (looksGarbled(pageBody)) garbledPages++;
        if (rawAnnots.length) anyAnnotations = true;

        // Always also emit the "### Markup on this page" summary block
        // — same annotations, but listed cleanly with author/date/etc.
        // Chat queries like "list all comments on page 4" hit this
        // block; in-context queries hit the inline markers.
        const pageAnnots = formatPdfAnnotations(rawAnnots, tc.items, i);

        const segments = [`[Page ${i}]`];
        if (pageBody) segments.push(pageBody);
        if (orphans.length) {
          segments.push(orphans.join('\n'));
        }
        if (pageAnnots.length) {
          segments.push('### Markup on this page\n\n' + pageAnnots.join('\n\n'));
        }
        if (pageBody || pageAnnots.length || orphans.length) {
          parts.push(segments.join('\n\n'));
        }
        page.cleanup?.();
      } catch (err) {
        parts.push(`[Page ${i}] (extraction failed: ${err.message})`);
      }
    }
    await doc.destroy?.();

    const text = parts.join('\n\n');

    // Trigger OCR if EITHER:
    //  (a) per-page body text is too sparse (scanned / image-only PDF), OR
    //  (b) too many pages are "garbled" — pdfjs extracted bytes but
    //      they're mojibake from missing ToUnicode CMaps (common in
    //      DocuSign overlays, edited contracts).
    const avgBodyPerPage = totalBodyChars / Math.max(1, pageCount);
    const garbledRatio = garbledPages / Math.max(1, pageCount);
    const isSparse = avgBodyPerPage < 50;
    const isMostlyGarbled = garbledRatio >= 0.25 && pageCount >= 1;
    if (isSparse || isMostlyGarbled) {
      const reason = isSparse
        ? `sparse text (${totalBodyChars} chars over ${pageCount} pages)`
        : `${garbledPages} of ${pageCount} pages have garbled text (font has no ToUnicode CMap)`;
      return {
        text: '',
        chars: 0,
        status: 'pending_ocr',
        method: 'ocr',
        format: 'markdown',
        detail: `PDF needs OCR: ${reason} — queued`,
      };
    }

    const cleanText = sanitizeForPg(text);
    return {
      text: cleanText,
      chars: cleanText.length,
      status: cleanText.length > 0 ? 'done' : 'failed',
      method: 'pdfjs',
      // Markdown if we emitted any structural ### headings (i.e.
      // any annotations); plain text otherwise.
      format: anyAnnotations ? 'markdown' : 'plain',
      detail: cleanText.length === 0 ? 'PDF has no extractable text' : undefined,
    };
  } catch (err) {
    return { text: '', chars: 0, status: 'failed', method: 'pdfjs', format: 'plain', detail: `PDF parse failed: ${err.message}` };
  }
}

/**
 * Build inline annotation anchors for a PDF page's text items.
 *
 * Returns three lookup maps:
 *   openAt[idx]   — markers to emit BEFORE text item at idx
 *                   (e.g. opening `{{HIGHLIGHT}}` markers)
 *   closeAt[idx]  — markers to emit AFTER text item at idx
 *                   (e.g. closing `{{/HIGHLIGHT}}` markers and
 *                    inline `{{COMMENT: "..."}}` notes)
 *   lineAt[idx]   — markers to emit on the line break BEFORE this
 *                   item (used for FreeText margin notes that float
 *                   in the margin near a paragraph)
 *   orphan        — annots that couldn't be anchored anywhere and
 *                   should be appended at the foot of the page
 *
 * Strategy:
 *   - Highlight / StrikeOut / Underline / Squiggly carry quadPoints.
 *     For each text item, check if its origin (transform[4], [5])
 *     falls inside any quad rectangle. The first item inside a quad
 *     gets the open-marker, the last gets the close-marker.
 *   - FreeText / Text (sticky note) / Stamp / Note carry a `rect`.
 *     Find the nearest text item by y-coordinate and emit the
 *     annotation as a blockquote line just before that item.
 *   - Replies are flattened into the parent annotation's marker.
 */
function buildPdfAnnotationAnchors(annots, textItems, pageNum) {
  const result = {
    openAt: {},
    closeAt: {},
    lineAt: {},
    orphan: [],
  };
  if (!Array.isArray(annots) || annots.length === 0) return result;
  if (!Array.isArray(textItems) || textItems.length === 0) {
    // Nothing to anchor to — every annotation becomes an orphan.
    for (const ann of annots) {
      const line = renderAnnotationOneLiner(ann, pageNum);
      if (line) result.orphan.push(line);
    }
    return result;
  }

  const QUAD_KINDS = new Set(['Highlight', 'StrikeOut', 'Underline', 'Squiggly']);
  // PolyLine = arrows / multi-segment lines (a Line with elbow points).
  // Widget  = form fields including signature fields (subtype 'Sig') —
  //           captured here so signed PDF forms surface their field
  //           labels and signer names.
  const FLOAT_KINDS = new Set([
    'FreeText', 'Text', 'Stamp', 'Caret', 'Ink',
    'Line', 'PolyLine', 'Square', 'Circle', 'Polygon',
    'Note', 'Widget',
  ]);

  for (const ann of annots) {
    const sub = ann.subtype || ann.subType;
    if (!sub) continue;
    if (ann.inReplyTo) continue;   // replies are inlined via parent

    if (QUAD_KINDS.has(sub) && Array.isArray(ann.quadPoints) && ann.quadPoints.length >= 8) {
      const range = textItemRangeForQuads(textItems, ann.quadPoints);
      if (range) {
        const verb = sub === 'Highlight' ? 'HIGHLIGHT'
          : sub === 'StrikeOut' ? 'STRIKEOUT'
          : sub === 'Underline' ? 'UNDERLINE'
          : 'SQUIGGLY';
        const meta = annotationMetaTag(ann);
        const open = `{{${verb}${meta}}}`;
        const close = `{{/${verb}}}`;
        result.openAt[range.start] = result.openAt[range.start] || [];
        result.openAt[range.start].push(open);
        result.closeAt[range.end] = result.closeAt[range.end] || [];
        result.closeAt[range.end].push(close);
        // If the annotation has a comment body, emit it inline as a
        // blockquote AFTER the closed range — chat then sees the
        // highlighted phrase + the comment about it together.
        const contents = (ann.contents || ann.contentsObj?.str || '').trim();
        if (contents) {
          const author = ann.title || ann.author || '';
          const repliesText = (Array.isArray(ann.replies) ? ann.replies : [])
            .map((r) => `${r.title || r.author || 'Unknown'}: ${(r.contents || '').trim()}`)
            .filter((s) => s.trim().length > 0)
            .join('  ↳  ');
          const fullText = repliesText ? `${contents}  ↳  ${repliesText}` : contents;
          const tag = `\n> [COMMENT${author ? ` · ${author}` : ''}]: ${truncate(fullText, 600)}`;
          result.closeAt[range.end].push(tag);
        }
        continue;
      }
    }

    if (FLOAT_KINDS.has(sub) && Array.isArray(ann.rect) && ann.rect.length === 4) {
      const idx = nearestTextItemIndex(textItems, ann.rect);
      if (idx != null) {
        const line = renderAnnotationOneLiner(ann, pageNum);
        if (line) {
          result.lineAt[idx] = result.lineAt[idx] || [];
          result.lineAt[idx].push(line);
        }
        continue;
      }
    }

    // Couldn't anchor — fall back to orphan
    const line = renderAnnotationOneLiner(ann, pageNum);
    if (line) result.orphan.push(line);
  }
  return result;
}

function annotationMetaTag(ann) {
  const author = ann.title || ann.author || '';
  const date = ann.modificationDate || ann.creationDate || '';
  const meta = [];
  if (author) meta.push(`author=${author.replace(/[}|]/g, '')}`);
  if (date) meta.push(`date=${formatPdfDate(date)}`);
  return meta.length ? ` | ${meta.join(' | ')}` : '';
}

function renderAnnotationOneLiner(ann, pageNum) {
  const sub = ann.subtype || ann.subType;
  if (!sub) return '';
  const label = friendlyAnnotLabel(sub);
  const author = ann.title || ann.author || '';
  const date = ann.modificationDate || ann.creationDate || '';
  const contents = (ann.contents || ann.contentsObj?.str || '').trim();

  // Widget annotations are PDF form fields — signatures, text boxes,
  // checkboxes. They don't carry "contents" like a comment, but they
  // do carry fieldName + fieldValue (plus fieldType: Sig/Tx/Btn/Ch).
  // For signatures specifically, the fieldValue is the signer's name
  // (or a digital cert blob); for text boxes, the value is what the
  // user typed. Surface all of it so chat can answer "what did the
  // form say?" or "who signed this?".
  if (sub === 'Widget') {
    const fieldType = ann.fieldType || ann.subType || '';
    const fieldName = ann.fieldName || ann.fullName || '';
    const fieldValue = ann.fieldValue || ann.buttonValue || '';
    const kindLabel = fieldType === 'Sig' ? 'Signature field'
      : fieldType === 'Tx' ? 'Text field'
      : fieldType === 'Btn' ? 'Checkbox/button'
      : fieldType === 'Ch' ? 'Dropdown'
      : 'Form field';
    const parts = [];
    if (fieldName) parts.push(`name="${truncate(String(fieldName), 80)}"`);
    if (fieldValue) parts.push(`value="${truncate(String(fieldValue), 200)}"`);
    if (!parts.length && !contents) return '';
    return `> [${kindLabel}, p.${pageNum}]: ${parts.join(' · ')}${contents ? ' · ' + truncate(contents, 200) : ''}`;
  }

  if (!contents && !author) return '';
  const meta = [author, date ? formatPdfDate(date) : ''].filter(Boolean).join(' · ');
  const head = `[${label}${meta ? ` · ${meta}` : ''}, p.${pageNum}]`;
  return `> ${head}: ${truncate(contents || '(no comment text)', 600)}`;
}

/**
 * For a markup annotation's quadPoints, find the [start, end] index
 * range in textItems whose origins fall inside any of the quad
 * rectangles. Returns null if no items match.
 */
function textItemRangeForQuads(textItems, quadPoints) {
  const matches = [];
  for (let q = 0; q < quadPoints.length; q += 8) {
    const xs = [quadPoints[q], quadPoints[q + 2], quadPoints[q + 4], quadPoints[q + 6]];
    const ys = [quadPoints[q + 1], quadPoints[q + 3], quadPoints[q + 5], quadPoints[q + 7]];
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    for (let idx = 0; idx < textItems.length; idx++) {
      const it = textItems[idx];
      if (!it || !it.transform || !it.str) continue;
      const x = it.transform[4];
      const y = it.transform[5];
      // Same tolerance as textInQuadPoints — highlight rects are drawn
      // around cap height, baseline can sit a few units below.
      if (x >= minX - 1 && x <= maxX + 1 && y >= minY - 4 && y <= maxY + 6) {
        matches.push(idx);
      }
    }
  }
  if (matches.length === 0) return null;
  return { start: matches[0], end: matches[matches.length - 1] };
}

/**
 * Find the text-item index nearest the y-coordinate of the
 * annotation's rect. Used for FreeText / sticky notes that float
 * in the margin alongside body prose. Returns null if textItems is
 * empty.
 */
function nearestTextItemIndex(textItems, rect) {
  if (!textItems.length) return null;
  // rect = [x1, y1, x2, y2]; use the vertical center of the rect.
  const targetY = (rect[1] + rect[3]) / 2;
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let idx = 0; idx < textItems.length; idx++) {
    const it = textItems[idx];
    if (!it || !it.transform) continue;
    const dist = Math.abs(it.transform[5] - targetY);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = idx;
    }
  }
  return bestIdx;
}

/**
 * Convert pdfjs Annotation objects into markdown-ish blocks.
 *
 * pdfjs exposes:
 *   - subtype: 'Highlight' | 'StrikeOut' | 'Underline' | 'Squiggly' |
 *              'FreeText' | 'Text' (sticky note) | 'Stamp' | 'Caret' |
 *              'Ink' | 'Line' | 'Square' | 'Circle' | 'Polygon'
 *   - title: author label (PDF spec calls this "T")
 *   - contents: the comment body (PDF spec "Contents")
 *   - quadPoints: 8 numbers per quad describing rectangles for
 *                 markup-type annotations (Highlight/StrikeOut/etc.)
 *   - rect: [x1, y1, x2, y2] bounding box
 *   - replies: array of nested Annotation objects (comment threads)
 *
 * For markup-type annotations, we use quadPoints to find the
 * underlying text — i.e. what did the highlight cover? This lets the
 * chat answer questions like "what did Joe highlight on page 4".
 */
function formatPdfAnnotations(annots, textItems, pageNum) {
  if (!Array.isArray(annots) || annots.length === 0) return [];
  const VISIBLE_SUBTYPES = new Set([
    'Highlight', 'StrikeOut', 'Underline', 'Squiggly',
    'FreeText', 'Text', 'Stamp', 'Caret', 'Ink',
    'Line', 'PolyLine', 'Square', 'Circle', 'Polygon', 'Note',
    'Widget',
  ]);
  const blocks = [];
  for (const ann of annots) {
    const sub = ann.subtype || ann.subType;
    if (!sub || !VISIBLE_SUBTYPES.has(sub)) continue;
    if (ann.inReplyTo) continue;   // replies are picked up via replies[] below

    const label = friendlyAnnotLabel(sub);
    const author = ann.title || ann.author || '';
    const dateStr = ann.modificationDate || ann.creationDate || '';
    const contents = (ann.contents || ann.contentsObj?.str || '').trim();
    let quoted = '';
    if (['Highlight', 'StrikeOut', 'Underline', 'Squiggly'].includes(sub) && Array.isArray(ann.quadPoints)) {
      quoted = textInQuadPoints(textItems, ann.quadPoints);
    }

    const headParts = [`**[${label}, p.${pageNum}]**`];
    if (author) headParts.push(`by ${author}`);
    if (dateStr) headParts.push(`(${formatPdfDate(dateStr)})`);
    blocks.push(headParts.join(' '));

    if (quoted) blocks[blocks.length - 1] += `\n  > "${truncate(quoted, 400)}"`;
    if (contents) blocks[blocks.length - 1] += `\n  → ${truncate(contents, 600)}`;

    // Reply chain (popups)
    if (Array.isArray(ann.replies) && ann.replies.length) {
      for (const rep of ann.replies) {
        const repAuthor = rep.title || rep.author || 'Unknown';
        const repText = (rep.contents || '').trim();
        if (!repText) continue;
        blocks[blocks.length - 1] += `\n     ↳ ${repAuthor}: ${truncate(repText, 400)}`;
      }
    }
  }
  return blocks;
}

function friendlyAnnotLabel(subtype) {
  const map = {
    Highlight: 'Highlight',
    StrikeOut: 'Strikethrough',
    Underline: 'Underline',
    Squiggly: 'Squiggly underline',
    FreeText: 'Margin note',
    Text: 'Sticky note',
    Stamp: 'Stamp',
    Caret: 'Caret',
    Ink: 'Ink markup',
    Line: 'Line',
    PolyLine: 'Arrow',         // multi-segment lines are usually arrows in legal markup
    Square: 'Box',
    Circle: 'Ellipse',
    Polygon: 'Polygon',
    Note: 'Note',
    Widget: 'Form field',      // signature fields, text boxes, checkboxes
  };
  return map[subtype] || subtype;
}

function truncate(s, n) {
  const t = String(s || '');
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

function formatPdfDate(d) {
  // PDF dates look like "D:20240304100000-05'00'" — parse to ISO-ish.
  if (!d || typeof d !== 'string') return '';
  const m = d.match(/^D?:?(\d{4})(\d{2})(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return d.slice(0, 10);
}

/**
 * Find text items whose origin point falls within any of the
 * annotation's quad rectangles. Returns the joined text.
 *
 * quadPoints format: 8 numbers per quad, each quad is a rectangle
 * (x1,y1, x2,y2, x3,y3, x4,y4). Coordinates are in PDF user space.
 * Text items have transform [a, b, c, d, e, f] where (e, f) is the
 * baseline origin in user space.
 */
function textInQuadPoints(textItems, quadPoints) {
  if (!Array.isArray(textItems) || !Array.isArray(quadPoints) || quadPoints.length < 8) return '';
  const matched = [];
  for (let q = 0; q < quadPoints.length; q += 8) {
    const xs = [quadPoints[q], quadPoints[q + 2], quadPoints[q + 4], quadPoints[q + 6]];
    const ys = [quadPoints[q + 1], quadPoints[q + 3], quadPoints[q + 5], quadPoints[q + 7]];
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    for (const it of textItems) {
      if (!it || !it.transform || !it.str) continue;
      const x = it.transform[4];
      const y = it.transform[5];
      // pdfjs y-coords are baseline-from-bottom. Allow a 4-unit
      // tolerance because highlights are drawn on caps, baseline can
      // be slightly below the quad's bottom edge.
      if (x >= minX - 1 && x <= maxX + 1 && y >= minY - 4 && y <= maxY + 6) {
        matched.push(it.str);
      }
    }
  }
  return matched.join(' ').replace(/\s+/g, ' ').trim();
}

async function extractDocx(buffer) {
  try {
    const mammoth = await import('mammoth');
    const m = mammoth.default || mammoth;
    let body = '';
    // Tell mammoth NOT to inline images as base64 data URIs. By
    // default it embeds every embedded image (logos, signatures,
    // diagrams) as `![](data:image/jpeg;base64,/9j/4AAQ...)` which is
    // multi-kilobyte garbage in the vault — inflates chunk count,
    // wastes embedding cost, and surfaces as nonsense in chat
    // retrieval. We replace each image with a `[image]` placeholder
    // that preserves the semantic position without dragging the
    // binary into the text. (When option #3 lands, the multimodal
    // ingestor will walk word/media/* directly for the actual bytes.)
    const imageHandler = m.images && m.images.imgElement
      ? m.images.imgElement(() => Promise.resolve({ src: '' }))
      : undefined;
    const convertOpts = imageHandler ? { buffer, convertImage: imageHandler } : { buffer };
    if (typeof m.convertToMarkdown === 'function') {
      const out = await m.convertToMarkdown(convertOpts);
      body = (out.value || '').trim();
    } else {
      const out = await m.convertToHtml(convertOpts);
      body = htmlToMarkdown(out.value || '').trim();
    }
    // Defensive: replace ANY markdown image reference with `[image]`
    // — `![alt](url)`, `![alt](data:base64...)`, `![]()`, etc.
    // The convertImage handler above tells mammoth to emit empty
    // src attributes so we don't ship base64 binary into chunk text,
    // BUT mammoth still emits the `![](...)` syntax — and the empty
    // `![]()` form needs the same `[image]` replacement so the
    // applyImagePlaceholders step downstream can swap it for
    // `[image-N: <caption>]`. Without this, the chat-stream image
    // attachment fallback (which scans for `[image-N:` markers)
    // can't find any image references and never attaches the bytes.
    body = body.replace(/!\[[^\]]*\]\([^)]*\)/g, '[image]');
    // Also strip any leftover `<img>` HTML tags that slip past
    // htmlToMarkdown (rare, defense in depth).
    body = body.replace(/<img\s+[^>]*\/?>/gi, '[image]');
    // Strip Word bookmark anchor tags (`<a id="_DV_M59"></a>` etc.)
    // that mammoth passes through as raw HTML inside markdown. These
    // are document-management bookmarks (DocVerify / contract-mgmt
    // tools) — they're not comments, not visible to humans, and just
    // pollute vault chunks.
    body = body.replace(/<a\s+id="[^"]*">\s*<\/a>/gi, '');
    body = body.replace(/<a\s+id="[^"]*"\s*\/>/gi, '');

    // Pull tracked changes + comments out of the .docx archive. These
    // live in word/document.xml (<w:ins>/<w:del>) and word/comments.xml.
    // Mammoth doesn't expose them — its Markdown output silently
    // accepts insertions and drops deletions. For vault recall we need
    // the raw markup so chat can answer "what did Joe redline?".
    //
    // Strategy: pull paragraph-level markup, then INLINE-INJECT each
    // paragraph's markup right after its anchor text in the mammoth
    // body. That way when the vault chunker splits the doc, body text
    // and the markup attached to it land in the SAME chunk — chat
    // retrieval can answer "what does this clause say AND what did
    // Joe redline?" with one chunk.
    //
    // We also append a "## Markup with context" summary at the end as
    // a fallback so chat can scan all annotations at once for queries
    // like "list every comment in the document".
    let paraMarkup = [];
    try {
      paraMarkup = await extractDocxParagraphMarkup(buffer);
    } catch (err) {
      console.warn('[docx-annotations] failed:', err.message);
    }

    let combinedBody = body;
    if (paraMarkup.length) {
      combinedBody = injectInlineMarkupIntoBody(body, paraMarkup);
    }

    // Also build the end-of-doc summary section (kept for backward
    // compatibility and "scan-all-comments" queries). Reuses paraMarkup
    // so we only walk the OOXML once.
    const summary = paraMarkup.length ? buildDocxMarkupSummary(paraMarkup) : '';

    const rawText = summary ? `${combinedBody}\n\n${summary}` : combinedBody;
    let text = sanitizeForPg(rawText);

    // EMPTY-BODY FALLBACK — common in letterhead-only templates: the
    // body is blank because the user hasn't filled the doc out yet;
    // all the firm content lives in headers + footers. Mammoth only
    // walks word/document.xml so we'd otherwise mark these "failed"
    // and refuse to ingest them. Walk the header*.xml / footer*.xml
    // / footnotes / endnotes inside the zip directly, pull <w:t>
    // content, and use that as the extracted text instead.
    if (!text || text.trim().length === 0) {
      try {
        const fallbackText = await extractHeadersFootersText(buffer);
        if (fallbackText && fallbackText.trim().length > 0) {
          text = sanitizeForPg(fallbackText);
          return {
            text,
            chars: text.length,
            status: 'done',
            method: 'mammoth+header-footer-fallback',
            format: 'plain',
            detail: 'Body was empty; extracted from headers / footers.',
          };
        }
      } catch (err) {
        console.warn('[docx-empty-body-fallback] failed:', err?.message || err);
      }
    }

    return {
      text,
      chars: text.length,
      // Even an empty extraction returns 'done' if we got here without
      // a thrown error — the file was parseable, it just had no
      // recoverable text. Mark with explanatory detail so the UI is
      // honest about what happened. Previous behavior was status:
      // 'failed' with no detail, which surfaced as a useless
      // "Failed: unknown" toast and blocked the user from saving
      // empty-letterhead templates.
      status: text.length > 0 ? 'done' : 'done',
      method: 'mammoth',
      format: 'markdown',
      detail: text.length === 0 ? 'Empty document (no extractable text).' : undefined,
    };
  } catch (err) {
    return { text: '', chars: 0, status: 'failed', method: 'mammoth', format: 'plain', detail: `DOCX parse failed: ${err.message}` };
  }
}

/**
 * Walk the .docx archive directly and pull text content from every
 * header*.xml / footer*.xml / footnotes.xml / endnotes.xml file.
 * Used as a fallback for letterhead templates whose body is empty.
 *
 * Returns a flat string with newlines between paragraphs.
 */
async function extractHeadersFootersText(buffer) {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buffer);
  const lines = [];
  const paths = [];
  zip.forEach((relativePath) => {
    if (
      /^word\/(header|footer)\d+\.xml$/.test(relativePath) ||
      relativePath === 'word/footnotes.xml' ||
      relativePath === 'word/endnotes.xml'
    ) {
      paths.push(relativePath);
    }
  });
  for (const path of paths) {
    const file = zip.file(path);
    if (!file) continue;
    const xml = await file.async('string');
    // Pull every <w:t>...</w:t> text run. Preserve order (no sorting).
    const matches = xml.match(/<w:t(?:\s+[^>]*)?>([\s\S]*?)<\/w:t>/g) || [];
    for (const m of matches) {
      const inner = m.replace(/<w:t(?:\s+[^>]*)?>/, '').replace(/<\/w:t>$/, '');
      // Decode the few entities mammoth-equivalent text would also
      // decode. <w:t> elements don't contain CDATA, just entities.
      const decoded = inner
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
      if (decoded.trim()) lines.push(decoded);
    }
    // Paragraph break between files for readability.
    if (matches.length) lines.push('');
  }
  return lines.join('\n').trim();
}

/**
 * Walk DOCX paragraphs and return one record per paragraph that has
 * any tracked-change or comment markup:
 *
 *   { bodyText, anchorNeedle, markupLines: [...] }
 *
 * - bodyText: the visible paragraph text (insertions accepted,
 *   deletions removed) — same as what mammoth would emit
 * - anchorNeedle: a unique-ish substring from the START of bodyText
 *   used to locate this paragraph inside the mammoth markdown output
 * - markupLines: ready-to-render blockquote markdown lines like
 *   "> [REDLINE-DELETE · Joe Smith · 2024-03-04]: \"sole and exclusive\""
 *
 * Used by extractDocx to weave inline markup AND by the end-of-doc
 * summary builder.
 */
async function extractDocxParagraphMarkup(buffer) {
  let JSZip;
  try {
    JSZip = (await import('jszip')).default;
  } catch {
    return [];
  }
  const zip = await JSZip.loadAsync(buffer);
  const docXml = await zip.file('word/document.xml')?.async('string');
  if (!docXml) return [];

  const commentMap = {};
  const commentsXml = await zip.file('word/comments.xml')?.async('string');
  if (commentsXml) {
    const comments = parseDocxComments(commentsXml);
    for (const c of comments) commentMap[c.id] = c;
  }

  const paragraphs = walkDocxParagraphs(docXml);
  const out = [];
  for (const paraXml of paragraphs) {
    const ann = extractParagraphAnnotations(paraXml, commentMap);
    if (!ann.changes.length && !ann.comments.length && !ann.highlights.length && !ann.moves.length) continue;
    if (!ann.bodyText) continue;
    const lines = [];
    for (const ch of ann.changes) {
      const meta = [ch.author, ch.date ? ch.date.slice(0, 10) : ''].filter(Boolean).join(' · ');
      const verb = ch.kind === 'insert' ? 'REDLINE-INSERT' : 'REDLINE-DELETE';
      lines.push(`> [${verb}${meta ? ` · ${meta}` : ''}]: "${truncate(ch.text, 400)}"`);
    }
    for (const mv of ann.moves) {
      const meta = [mv.author, mv.date ? mv.date.slice(0, 10) : ''].filter(Boolean).join(' · ');
      const verb = mv.kind === 'moveTo' ? 'MOVE-IN' : 'MOVE-OUT';
      lines.push(`> [${verb}${meta ? ` · ${meta}` : ''}]: "${truncate(mv.text, 400)}"`);
    }
    for (const hl of ann.highlights) {
      const colorBit = hl.color ? ` · color=${hl.color}` : '';
      const verb = hl.kind === 'strike' ? 'STRIKEOUT'
        : hl.kind === 'underline' ? 'UNDERLINE'
        : 'HIGHLIGHT';
      lines.push(`> [${verb}${colorBit}]: "${truncate(hl.text, 300)}"`);
    }
    for (const c of ann.comments) {
      const meta = [c.author || 'Unknown', c.date ? c.date.slice(0, 10) : ''].filter(Boolean).join(' · ');
      const anchorBit = c.anchor ? ` on "${truncate(c.anchor, 80)}"` : '';
      lines.push(`> [COMMENT${meta ? ` · ${meta}` : ''}${anchorBit}]: ${truncate(c.text, 600)}`);
    }
    if (!lines.length) continue;
    out.push({
      bodyText: ann.bodyText,
      anchorNeedle: buildAnchorNeedle(ann.bodyText),
      markupLines: lines,
    });
  }
  return out;
}

/**
 * Build a stable anchor "needle" from a paragraph's body text. We use
 * the FIRST run of significant words (40-80 chars, word-aligned) so
 * the needle is long enough to be unique within a typical contract
 * but short enough to survive minor mammoth → markdown text munging.
 *
 * If the paragraph is shorter than 40 chars, return the whole
 * paragraph (still useful as an anchor — short paragraphs are usually
 * unique like "Section 4.2" or a numbered heading).
 */
function buildAnchorNeedle(bodyText) {
  const t = String(bodyText || '').replace(/\s+/g, ' ').trim();
  if (t.length <= 40) return t;
  // Take the first ~70 chars but cut at a word boundary.
  const ideal = Math.min(t.length, 70);
  const trimmed = t.slice(0, ideal);
  const lastSpace = trimmed.lastIndexOf(' ');
  return lastSpace > 30 ? trimmed.slice(0, lastSpace) : trimmed;
}

/**
 * Normalize a string for needle-matching against mammoth's markdown
 * output. Mammoth escapes punctuation that's significant in markdown
 * (`.`, `-`, `(`, `)`, `!`, `[`, `]`, `*`, `_`, etc.) with backslashes
 * in convertToMarkdown's output. Raw OOXML run text has none of these
 * escapes, so a literal `indexOf` between the two will fail on any
 * paragraph that mentions a price ($1,000), a date (3/4/24), or a
 * legal citation (4.2(a)).
 *
 * Strategy: build a normalized form by stripping ALL backslashes and
 * collapsing whitespace. Apply to BOTH the body markdown and the
 * needle before searching. The match indices in the normalized body
 * are then mapped back to the original body via a parallel index map.
 */
function normalizeForMatch(s) {
  // Strip backslash escapes and underscore/asterisk emphasis markers.
  // We deliberately don't strip `*`/`_` from text content — only when
  // they wrap (look like markup): `**foo**` → `foo`, `_bar_` → `bar`.
  // Simplest approach: drop `\` everywhere and collapse multiple
  // whitespace to single space.
  return String(s || '').replace(/\\(.)/g, '$1').replace(/\s+/g, ' ').trim();
}

/**
 * Inject inline markup into the mammoth body markdown.
 *
 * For each paragraph that has markup, find the first occurrence of
 * the anchor needle in the body and insert the markup blockquote
 * lines IMMEDIATELY after the paragraph (after the next \n\n).
 *
 * Works greedily — once a needle is consumed, we advance past that
 * spot so the same needle isn't matched twice. If the needle isn't
 * found (rare; mammoth munged the text), the markup falls through to
 * the end-of-doc summary section.
 */
function injectInlineMarkupIntoBody(body, paraMarkup) {
  // Build a normalized version of body for matching, plus an index
  // map: normIdx → origIdx so we can translate match positions back.
  const src = String(body);
  const normChars = [];
  const normToOrig = []; // for each char in normalized, the orig index
  let prevWasWS = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < src.length) {
      // Skip the backslash, keep the next char (consumed below)
      continue;
    }
    if (/\s/.test(ch)) {
      if (prevWasWS) continue;     // collapse whitespace
      normChars.push(' ');
      normToOrig.push(i);
      prevWasWS = true;
    } else {
      normChars.push(ch);
      normToOrig.push(i);
      prevWasWS = false;
    }
  }
  const normBody = normChars.join('');

  let result = '';
  let cursor = 0;
  let searchFromNorm = 0;
  for (const pm of paraMarkup) {
    if (!pm.anchorNeedle) continue;
    const normNeedle = normalizeForMatch(pm.anchorNeedle);
    if (!normNeedle) continue;
    const normIdx = normBody.indexOf(normNeedle, searchFromNorm);
    if (normIdx === -1) continue;
    // Translate the END of the matched needle back to original text
    // index, so we can scan forward for the next paragraph break.
    const matchEndNorm = normIdx + normNeedle.length - 1;
    const origMatchEnd = normToOrig[matchEndNorm] ?? src.length;
    let paraEnd = src.indexOf('\n\n', origMatchEnd);
    if (paraEnd === -1) paraEnd = src.length;
    // Append source through paraEnd, then markup, then continue.
    result += src.slice(cursor, paraEnd);
    result += '\n' + pm.markupLines.join('\n');
    cursor = paraEnd;
    // Advance the normalized search cursor past this match
    searchFromNorm = matchEndNorm + 1;
  }
  result += src.slice(cursor);
  return result;
}

/**
 * Build the end-of-document "## Markup with context" summary section.
 * Same shape as the legacy extractDocxAnnotations output — kept so
 * chat can run a single query like "list every comment" and find
 * them all in one chunk.
 */
function buildDocxMarkupSummary(paraMarkup) {
  if (!paraMarkup.length) return '';
  const blocks = paraMarkup.map((pm) => {
    const lines = [];
    lines.push(`### Paragraph: "${truncate(pm.bodyText, 200)}"`);
    for (const ml of pm.markupLines) lines.push(ml);
    return lines.join('\n');
  });
  return '## Markup with context\n\n' + blocks.join('\n\n');
}

/**
 * Find every <w:p>…</w:p> block in document.xml in order. Returns
 * each paragraph's inner XML as a string. Sectioned paragraphs (a
 * paragraph inside a table cell, footnote, etc.) all show up — we
 * intentionally don't filter so markup inside tables is captured.
 */
function walkDocxParagraphs(documentXml) {
  const out = [];
  const re = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let m;
  while ((m = re.exec(documentXml)) !== null) {
    out.push(m[1]);
  }
  return out;
}

/**
 * For one paragraph's inner XML, return:
 *   { bodyText, changes: [...], comments: [...] }
 *
 * bodyText: the visible paragraph text (excludes deleted runs, since
 * those represent past content that's no longer in the document body)
 *
 * changes: tracked insert/delete records inside this paragraph
 *
 * comments: comment records whose <w:commentRangeStart> falls inside
 * this paragraph. We attempt to capture the anchor text — the
 * substring between commentRangeStart and commentRangeEnd of the
 * same id — so the markup line can show "on '<anchored phrase>'".
 */
function extractParagraphAnnotations(paraXml, commentMap) {
  // 1. body text — strip <w:del> and <w:moveFrom> blocks first so we
  //    don't double-count their content (those represent removed
  //    content, even though "moveFrom" lives until the move is
  //    accepted)
  const bodyXml = paraXml
    .replace(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/g, '')
    .replace(/<w:moveFrom\b[^>]*>[\s\S]*?<\/w:moveFrom>/g, '');
  const bodyText = extractDocxText(bodyXml, 't');

  // 2. tracked changes inside this paragraph
  const changes = [];
  const insRe = /<w:ins\b([^>]*)>([\s\S]*?)<\/w:ins>/g;
  const delRe = /<w:del\b([^>]*)>([\s\S]*?)<\/w:del>/g;
  let mm;
  while ((mm = insRe.exec(paraXml)) !== null) {
    const text = extractDocxText(mm[2], 't');
    if (text) {
      changes.push({
        kind: 'insert',
        author: attrAt(mm[1], 'w:author'),
        date: attrAt(mm[1], 'w:date'),
        text,
      });
    }
  }
  while ((mm = delRe.exec(paraXml)) !== null) {
    const text = extractDocxText(mm[2], 'delText');
    if (text) {
      changes.push({
        kind: 'delete',
        author: attrAt(mm[1], 'w:author'),
        date: attrAt(mm[1], 'w:date'),
        text,
      });
    }
  }

  // 2b. tracked MOVES — Word records text moved from one location
  // to another as a paired (<w:moveFrom>, <w:moveTo>) annotation.
  // Capture both endpoints so chat can answer "what did Joe move
  // and where to?".
  const moves = [];
  const moveFromRe = /<w:moveFrom\b([^>]*)>([\s\S]*?)<\/w:moveFrom>/g;
  const moveToRe = /<w:moveTo\b([^>]*)>([\s\S]*?)<\/w:moveTo>/g;
  while ((mm = moveFromRe.exec(paraXml)) !== null) {
    const text = extractDocxText(mm[2], 't');
    if (text) {
      moves.push({
        kind: 'moveFrom',
        author: attrAt(mm[1], 'w:author'),
        date: attrAt(mm[1], 'w:date'),
        text,
      });
    }
  }
  while ((mm = moveToRe.exec(paraXml)) !== null) {
    const text = extractDocxText(mm[2], 't');
    if (text) {
      moves.push({
        kind: 'moveTo',
        author: attrAt(mm[1], 'w:author'),
        date: attrAt(mm[1], 'w:date'),
        text,
      });
    }
  }

  // 2c. DIRECT-FORMATTING markup — Word's "highlight" toolbar button
  // applies <w:highlight w:val="yellow"/> inside <w:rPr>; the
  // strikethrough button applies <w:strike w:val="true"/>; the
  // underline button applies <w:u w:val="single"/>. These are NOT
  // tracked changes — they're permanent formatting — but lawyers
  // commonly use them to flag clauses outside of Word's comment
  // workflow. Capture each as a markup record so chat can find
  // "what did Joe highlight in yellow?".
  //
  // We walk every <w:r>…</w:r> run in the paragraph, look at its
  // <w:rPr> for highlight/strike/underline markers, and pull the
  // visible text out of <w:t> children.
  const highlights = [];
  const runRe = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
  while ((mm = runRe.exec(paraXml)) !== null) {
    const runXml = mm[1];
    const rPrMatch = runXml.match(/<w:rPr\b[^>]*>([\s\S]*?)<\/w:rPr>/);
    if (!rPrMatch) continue;
    const rPr = rPrMatch[1];

    // <w:highlight w:val="yellow"/> — Word's highlight button
    const highlightVal = (rPr.match(/<w:highlight\b[^>]*\bw:val="([^"]+)"/) || [])[1];
    // <w:shd w:fill="FFFF00"/> — paragraph-shading-style highlight
    const shdFill = (rPr.match(/<w:shd\b[^>]*\bw:fill="([^"]+)"/) || [])[1];
    // <w:strike w:val="true"/> — direct strikethrough (NOT tracked deletion)
    const hasStrike = /<w:strike\b[^>]*(?:w:val="(?:true|1)"|\/>|>\s*)/.test(rPr) && !/<w:strike\b[^>]*w:val="(?:false|0)"/.test(rPr);
    // <w:u w:val="single"/> — direct underline (skip "none")
    const uVal = (rPr.match(/<w:u\b[^>]*\bw:val="([^"]+)"/) || [])[1];

    const isHighlighted = (highlightVal && highlightVal !== 'none')
      || (shdFill && shdFill !== 'auto' && shdFill !== 'FFFFFF');
    const isStruck = hasStrike;
    const isUnderlined = uVal && uVal !== 'none';

    if (!isHighlighted && !isStruck && !isUnderlined) continue;

    const text = extractDocxText(runXml, 't');
    if (!text) continue;
    if (isHighlighted) {
      highlights.push({
        kind: 'highlight',
        color: highlightVal || (shdFill ? `#${shdFill}` : ''),
        text,
      });
    }
    if (isStruck) {
      highlights.push({ kind: 'strike', color: '', text });
    }
    if (isUnderlined) {
      highlights.push({ kind: 'underline', color: '', text });
    }
  }

  // 3. comments anchored within this paragraph — capture anchor text
  // between commentRangeStart and commentRangeEnd
  const comments = [];
  const startRe = /<w:commentRangeStart\b[^>]*\bw:id="(\d+)"[^>]*\/?>/g;
  while ((mm = startRe.exec(paraXml)) !== null) {
    const id = mm[1];
    if (!commentMap[id]) continue;
    // Find end marker for the same id within this paragraph (best
    // effort — comments that span paragraphs lose their anchor here)
    const after = paraXml.slice(mm.index + mm[0].length);
    const endRe = new RegExp(`<w:commentRangeEnd\\b[^>]*\\bw:id="${id}"[^>]*\\/?>`);
    const endMatch = after.match(endRe);
    let anchor = null;
    if (endMatch) {
      const between = after.slice(0, endMatch.index);
      const anchorClean = between.replace(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/g, '');
      anchor = extractDocxText(anchorClean, 't');
    }
    comments.push({ ...commentMap[id], anchor });
  }

  return { bodyText, changes, comments, highlights, moves };
}

/**
 * Parse <w:comment> blocks out of word/comments.xml. Returns a flat
 * array of { id, author, date, text } that the paragraph walker
 * uses to resolve commentReference markers.
 */
function parseDocxComments(xml) {
  const out = [];
  const re = /<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const text = extractDocxText(m[2], 't');
    if (text) {
      out.push({
        id: attrAt(attrs, 'w:id'),
        author: attrAt(attrs, 'w:author'),
        date: attrAt(attrs, 'w:date'),
        text,
      });
    }
  }
  return out;
}

function attrAt(attrs, name) {
  const re = new RegExp(`${name}="([^"]*)"`);
  const m = attrs.match(re);
  return m ? m[1] : null;
}

/**
 * Pull the visible text out of a chunk of OOXML. Walks all <w:t> (or
 * <w:delText>) elements, decodes XML entities, joins with spaces.
 */
function extractDocxText(xml, tag) {
  const re = new RegExp(`<w:${tag}\\b[^>]*>([\\s\\S]*?)<\/w:${tag}>`, 'g');
  const parts = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    parts.push(decodeXmlEntities(m[1]));
  }
  return parts.join('').replace(/\s+/g, ' ').trim();
}

function decodeXmlEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * Light HTML → markdown converter. Sufficient for mammoth's output
 * (headings, paragraphs, bold/italic, lists, tables). Not a full
 * HTML→MD library. We do the minimum to preserve legal-document
 * structure.
 */
function htmlToMarkdown(html) {
  if (!html) return '';
  let s = String(html);

  // Strip <img> tags whose src is a base64 data URI BEFORE any other
  // processing — these are multi-kilobyte binary blobs that would
  // otherwise survive into the markdown output and pollute vault
  // chunks. Replace each with `[image]` to preserve position.
  s = s.replace(/<img\s+[^>]*src="data:[^"]*"[^>]*\/?>/gi, '[image]');
  // Also kill any other <img>: we don't host external URLs from
  // within the extracted text, and vault retrieval doesn't benefit
  // from `<img src="https://example.com/x.png">` either.
  s = s.replace(/<img\s+[^>]*\/?>/gi, '[image]');

  // Headings
  s = s.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_m, t) => `\n# ${stripTags(t)}\n`);
  s = s.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_m, t) => `\n## ${stripTags(t)}\n`);
  s = s.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_m, t) => `\n### ${stripTags(t)}\n`);
  s = s.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_m, t) => `\n#### ${stripTags(t)}\n`);
  s = s.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, (_m, t) => `\n##### ${stripTags(t)}\n`);
  s = s.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, (_m, t) => `\n###### ${stripTags(t)}\n`);

  // Inline emphasis
  s = s.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, t) => `**${stripTags(t)}**`);
  s = s.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, t) => `*${stripTags(t)}*`);
  s = s.replace(/<u[^>]*>([\s\S]*?)<\/u>/gi, (_m, t) => `_${stripTags(t)}_`);

  // Lists
  s = s.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_m, inner) => {
    return '\n' + inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_im, t) => `- ${stripTags(t).trim()}\n`);
  });
  s = s.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_m, inner) => {
    let n = 0;
    return '\n' + inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_im, t) => `${++n}. ${stripTags(t).trim()}\n`);
  });

  // Tables (basic): one row per <tr>, cells separated by " | "
  s = s.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_m, inner) => {
    const rows = [];
    inner.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_rm, rowInner) => {
      const cells = [];
      rowInner.replace(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi, (_cm, cell) => { cells.push(stripTags(cell).trim()); return ''; });
      if (cells.length) rows.push('| ' + cells.join(' | ') + ' |');
      return '';
    });
    if (rows.length === 0) return '';
    if (rows.length >= 1) {
      // Insert separator after header row
      const sepCells = rows[0].split('|').slice(1, -1).map(() => '---');
      rows.splice(1, 0, '| ' + sepCells.join(' | ') + ' |');
    }
    return '\n' + rows.join('\n') + '\n';
  });

  // Paragraphs and breaks
  s = s.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_m, t) => `\n${stripTags(t)}\n`);
  s = s.replace(/<br\s*\/?>/gi, '\n');

  // Strip leftover tags
  s = stripTags(s);

  // Decode common entities
  s = s.replace(/&nbsp;/g, ' ')
       .replace(/&amp;/g, '&')
       .replace(/&lt;/g, '<')
       .replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"')
       .replace(/&#39;/g, "'")
       .replace(/&rsquo;/g, '’')
       .replace(/&lsquo;/g, '‘')
       .replace(/&rdquo;/g, '”')
       .replace(/&ldquo;/g, '“');

  // Collapse 3+ newlines to 2
  s = s.replace(/\n{3,}/g, '\n\n');

  return s.trim();
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, '');
}
