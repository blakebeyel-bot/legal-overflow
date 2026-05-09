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
        let pageText = '';
        let lastY = null;
        for (const item of tc.items) {
          if (lastY !== null && item.transform && Math.abs(item.transform[5] - lastY) > 5) {
            pageText += '\n';
          }
          pageText += item.str || '';
          if (item.hasEOL) pageText += '\n';
          if (item.transform) lastY = item.transform[5];
        }
        const pageBody = pageText.trim();
        totalBodyChars += pageBody.length;
        if (looksGarbled(pageBody)) garbledPages++;

        // Capture PDF annotations on THIS page and emit them right
        // after the page's body text. Keeps annotation chunks
        // adjacent to the body context they reference, so retrieval
        // pulls them together — chat can answer "what did Joe note
        // on the indemnity clause?" with both the clause and the
        // note in the same chunk.
        let pageAnnots = [];
        try {
          const annots = await page.getAnnotations();
          pageAnnots = formatPdfAnnotations(annots, tc.items, i);
          if (pageAnnots.length) anyAnnotations = true;
        } catch (err) {
          console.warn(`[pdf-annotations] page ${i}: ${err.message}`);
        }

        const segments = [`[Page ${i}]`];
        if (pageBody) segments.push(pageBody);
        if (pageAnnots.length) {
          segments.push('### Markup on this page\n\n' + pageAnnots.join('\n\n'));
        }
        if (pageBody || pageAnnots.length) {
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
    'Line', 'Square', 'Circle', 'Polygon', 'Note',
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
    Square: 'Box',
    Circle: 'Ellipse',
    Polygon: 'Polygon',
    Note: 'Note',
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
    if (typeof m.convertToMarkdown === 'function') {
      const out = await m.convertToMarkdown({ buffer });
      body = (out.value || '').trim();
    } else {
      const out = await m.convertToHtml({ buffer });
      body = htmlToMarkdown(out.value || '').trim();
    }

    // Pull tracked changes + comments out of the .docx archive. These
    // live in word/document.xml (<w:ins>/<w:del>) and word/comments.xml.
    // Mammoth doesn't expose them — its Markdown output silently
    // accepts insertions and drops deletions. For vault recall we need
    // the raw markup so chat can answer "what did Joe redline?".
    let annotations = '';
    try {
      annotations = await extractDocxAnnotations(buffer);
    } catch (err) {
      console.warn('[docx-annotations] failed:', err.message);
    }

    const rawText = annotations ? `${body}\n\n${annotations}` : body;
    const text = sanitizeForPg(rawText);
    return {
      text,
      chars: text.length,
      status: text.length > 0 ? 'done' : 'failed',
      method: 'mammoth',
      format: 'markdown',
    };
  } catch (err) {
    return { text: '', chars: 0, status: 'failed', method: 'mammoth', format: 'plain', detail: `DOCX parse failed: ${err.message}` };
  }
}

/**
 * Pull tracked changes (<w:ins>, <w:del>) and comments from a .docx
 * archive and render them grouped by the paragraph they touch — so
 * chat retrieval pulls anchor text + markup together.
 *
 * Output shape (one section per paragraph that has markup):
 *
 *   ## Markup with context
 *
 *   ### Paragraph: "The parties hereby agree to indemnify and hold harmless..."
 *   - **DELETE** by Joe Smith (3/4): "sole and exclusive"
 *   - **INSERT** by Joe Smith (3/4): "non-exclusive"
 *   - **COMMENT** by Joe Smith (3/4) on "sole and exclusive":
 *     Cap this at 12 months of fees paid; current language is open-ended.
 *
 * Empty string when the document has no tracked changes or comments.
 */
async function extractDocxAnnotations(buffer) {
  let JSZip;
  try {
    JSZip = (await import('jszip')).default;
  } catch {
    return '';
  }
  const zip = await JSZip.loadAsync(buffer);
  const docXml = await zip.file('word/document.xml')?.async('string');
  if (!docXml) return '';

  // Build a comment-id → comment-record lookup from comments.xml so
  // we can resolve <w:commentReference w:id="X"/> markers in the body.
  const commentMap = {};
  const commentsXml = await zip.file('word/comments.xml')?.async('string');
  if (commentsXml) {
    const comments = parseDocxComments(commentsXml);
    for (const c of comments) commentMap[c.id] = c;
  }

  // Walk paragraphs in document order. For each paragraph that has
  // any tracked change or comment, emit one anchored block.
  const paragraphs = walkDocxParagraphs(docXml);
  const blocks = [];
  for (const paraXml of paragraphs) {
    const ann = extractParagraphAnnotations(paraXml, commentMap);
    if (!ann.changes.length && !ann.comments.length) continue;
    if (!ann.bodyText) continue;     // skip empty / table-of-contents-only paragraphs

    const lines = [];
    lines.push(`### Paragraph: "${truncate(ann.bodyText, 200)}"`);
    for (const ch of ann.changes) {
      const meta = [ch.author, ch.date ? ch.date.slice(0, 10) : ''].filter(Boolean).join(' · ');
      const verb = ch.kind === 'insert' ? 'INSERT' : 'DELETE';
      lines.push(`- **${verb}**${meta ? ` (${meta})` : ''}: "${truncate(ch.text, 400)}"`);
    }
    for (const c of ann.comments) {
      const meta = [c.author || 'Unknown', c.date ? c.date.slice(0, 10) : ''].filter(Boolean).join(' · ');
      const anchorBit = c.anchor ? ` on "${truncate(c.anchor, 80)}"` : '';
      lines.push(`- **COMMENT**${meta ? ` (${meta})` : ''}${anchorBit}:`);
      lines.push(`    ${truncate(c.text, 600)}`);
    }
    blocks.push(lines.join('\n'));
  }

  if (blocks.length === 0) return '';
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
  // 1. body text — strip <w:del> blocks first so we don't double-count
  const bodyXml = paraXml.replace(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/g, '');
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

  return { bodyText, changes, comments };
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
