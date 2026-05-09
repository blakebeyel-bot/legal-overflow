/**
 * Vision-based OCR via Gemini Flash 2.0.
 *
 * Two entry points:
 *   - ocrPdf({ pdfBytes, ... })   — splits a PDF into per-page PNGs,
 *                                    OCRs each in batched parallel,
 *                                    returns markdown with [Page N]
 *                                    markers.
 *   - ocrImage({ imageBytes, ... }) — single image OCR → markdown.
 *
 * Plus shouldOcrPdf({ extractedText, pageCount }) which the
 * library-extract pipeline calls to decide whether to fall back to
 * OCR on a "PDF" that pdfjs returned essentially empty for (the
 * DocuSign / scanned-contract case).
 *
 * Default provider: Gemini Flash 2.0 via the user's BYOK Google key,
 * falling back to GOOGLE_AI_API_KEY (free tier covers most users).
 *
 * The OCR prompt asks the model to output clean markdown — preserve
 * headings, tables, lists, bold/italic, but DO NOT add commentary or
 * explanation. The chat LLM consuming this content reads markdown
 * natively.
 *
 * Pure ESM, runtime-portable.
 */

import { resolveProviderKey } from './byok-keys.js';

// gemini-2.5-flash replaced gemini-2.0-flash, which Google retired
// for new API users. 2.5-flash is the current production fast-tier
// model with native PDF + vision understanding and the same free
// tier as 2.0. Output budget unchanged.
const OCR_MODEL = 'gemini-2.5-flash';
const OCR_TIMEOUT_MS = 120_000;   // up to 2 min — PDFs can take longer than single images
// How many pages to send to Gemini in one shot. Each page renders to
// ~500-800 markdown tokens; Gemini Flash maxOutputTokens is 8192, so
// 8 pages fits comfortably with headroom for tables and annotations.
const OCR_PDF_CHUNK_PAGES = 8;

const OCR_PROMPT = `Transcribe this contract / legal document page into clean markdown.

BODY-TEXT RULES:
- Use markdown headings (#, ##, ###) for section titles, article numbers, recitals
- Preserve bold (**text**), italic (*text*), and underlined emphasis from the original
- Tables → markdown pipe-table syntax with alignment
- Numbered lists → "1.", bulleted lists → "-"
- Definitions / defined terms → keep them in the same paragraph; do not split into lists
- If the page is blank or unreadable, output exactly: [page intentionally blank]
- If the page is a stamp / form-watermark only with no real content, output: [stamp/watermark only]

ANNOTATION RULES (CRITICAL):
Lawyers redline contracts. Capture every visible annotation as a separate markdown line AT THE END of the page (after the body text), each on its own line:

- Highlights (yellow/pink/green/etc.) → > [HIGHLIGHT] "<exact highlighted text>"
- Strikethroughs / redlines crossed out → > [STRIKEOUT] "<crossed-out text>"
- Underlines added by the reviewer (NOT structural underline-emphasis) → > [UNDERLINE] "<underlined text>"
- Margin notes / sticky notes / handwritten comments → > [NOTE] "<the note text>"
- Stamps (RECEIVED, FILED, EXECUTED, etc.) → > [STAMP] "<text inside stamp>"
- Signatures (handwritten ink) → > [SIGNATURE] "<name if legible, else 'illegible'>"
- Initials → > [INITIALS] "<initials>"
- Stickers / tabs / arrows pointing at clauses → > [MARK] "<what's being pointed at>"

If a margin note is associated with a particular clause, include the clause text in quotes after the note: > [NOTE on "the term hereof"] "Push back — too long"

DO NOT:
- Add commentary, explanation, or preamble like "Here is the transcription"
- Skip any text — annotations are first-class content, not optional
- Re-order content (preserve top-to-bottom reading order)
- Translate or "improve" the language — transcribe verbatim
- Treat annotations as decorative — they often carry the most important information on the page

Output ONLY the markdown for this page. Body first, then a blank line, then the annotation lines. No introductions.`;

const SHOULD_OCR_MIN_CHARS_PER_PAGE = 50;

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Heuristic: if a PDF's pdfjs extraction returned almost nothing per
 * page, the PDF is probably image-only (scanned, DocuSigned without
 * a flattened text layer, or the text was rasterized).
 */
export function shouldOcrPdf({ extractedText, pageCount }) {
  if (!pageCount || pageCount <= 0) return false;
  const len = (extractedText || '').replace(/\[Page \d+\]/g, '').trim().length;
  return (len / pageCount) < SHOULD_OCR_MIN_CHARS_PER_PAGE;
}

/**
 * Resolve the OCR API key for a user. Mirrors embeddings.js — Google
 * BYOK first, GOOGLE_AI_API_KEY fallback. Returns { key, source }.
 * Throws if no key is available.
 */
export async function resolveOcrKey({ userId }) {
  const r = await resolveProviderKey({ userId, provider: 'google' });
  if (!r.key) {
    throw new Error('No Google AI API key available for OCR. Add a Google BYOK key in your account settings.');
  }
  return r;
}

/**
 * OCR a single image (PNG, JPEG, TIFF, HEIC) into markdown.
 *
 * @param {object} opts
 * @param {Buffer|Uint8Array} opts.imageBytes
 * @param {string} opts.mimeType   — e.g. 'image/png'
 * @param {string} opts.apiKey
 * @param {function} [opts.fetchImpl]
 * @returns {Promise<{ markdown: string, model: string }>}
 */
export async function ocrImage({ imageBytes, mimeType, apiKey, fetchImpl }) {
  if (!imageBytes || !apiKey) throw new Error('ocrImage: missing imageBytes or apiKey');
  const f = fetchImpl || globalThis.fetch;
  const md = await ocrSingleImageGemini({
    imageBytes,
    mimeType: mimeType || 'image/png',
    apiKey,
    fetchImpl: f,
  });
  return { markdown: md, model: OCR_MODEL };
}

/**
 * Single-image Gemini Vision call (PNG/JPEG/etc.). Used by ocrImage
 * when the input is a standalone image file rather than a PDF.
 */
async function ocrSingleImageGemini({ imageBytes, mimeType, apiKey, fetchImpl }) {
  const f = fetchImpl || globalThis.fetch;
  const base64 = bytesToBase64(imageBytes);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${OCR_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{
      role: 'user',
      parts: [
        { text: OCR_PROMPT },
        { inline_data: { mime_type: mimeType, data: base64 } },
      ],
    }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 8192 },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ],
  };
  const r = await withTimeout(
    f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    OCR_TIMEOUT_MS,
  );
  if (!r.ok) throw new Error(`OCR gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const md = (j.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || '')
    .join('')
    .trim();
  if (!md) throw new Error('OCR gemini returned empty output');
  return md.replace(/^(?:here(?:'s| is)|the (?:transcription|markdown))[^:]*:\s*/i, '').trim();
}

/**
 * OCR every page of a PDF into markdown via Gemini Flash 2.0's
 * native PDF understanding. Sends the PDF directly to Gemini as
 * inline_data — no rasterization needed, no native canvas deps.
 *
 * For PDFs longer than OCR_PDF_CHUNK_PAGES, the doc is split into
 * page chunks via pdf-lib, each chunk OCR'd in parallel, results
 * concatenated. This stays within Gemini Flash's 8192-output-token
 * cap per call.
 *
 * @param {object} opts
 * @param {Buffer|Uint8Array} opts.pdfBytes
 * @param {string} opts.apiKey
 * @param {function} [opts.fetchImpl]
 * @param {function} [opts.onProgress]   — called as (chunkIdx, totalChunks) for UI updates
 * @returns {Promise<{ markdown: string, model: string, pageCount: number }>}
 */
export async function ocrPdf({ pdfBytes, apiKey, fetchImpl, onProgress }) {
  if (!pdfBytes || !apiKey) throw new Error('ocrPdf: missing pdfBytes or apiKey');
  const f = fetchImpl || globalThis.fetch;
  const buf = Buffer.isBuffer(pdfBytes) ? pdfBytes : Buffer.from(pdfBytes);

  // Page count via pdf-lib so we know whether to split.
  let totalPages;
  let chunks;
  try {
    const { PDFDocument } = await import('pdf-lib');
    const src = await PDFDocument.load(buf, { ignoreEncryption: true });
    totalPages = src.getPageCount();

    if (totalPages <= OCR_PDF_CHUNK_PAGES) {
      // Small PDF — send whole buffer in one shot
      chunks = [{ bytes: buf, startPage: 1, endPage: totalPages }];
    } else {
      // Large PDF — slice into chunks
      chunks = [];
      for (let start = 0; start < totalPages; start += OCR_PDF_CHUNK_PAGES) {
        const end = Math.min(start + OCR_PDF_CHUNK_PAGES, totalPages);
        const chunkDoc = await PDFDocument.create();
        const pageIndices = [];
        for (let i = start; i < end; i++) pageIndices.push(i);
        const copied = await chunkDoc.copyPages(src, pageIndices);
        for (const p of copied) chunkDoc.addPage(p);
        const chunkBytes = await chunkDoc.save();
        chunks.push({
          bytes: Buffer.from(chunkBytes),
          startPage: start + 1,
          endPage: end,
        });
      }
    }
  } catch (err) {
    throw new Error(`ocrPdf: pdf-lib load failed: ${err.message}`);
  }

  // Process chunks in parallel pairs (2 in flight at a time) to
  // balance throughput vs Gemini Flash free-tier RPM (1500/min is
  // generous, so 2 concurrent is safe).
  const CONCURRENCY = 2;
  const results = new Array(chunks.length);
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const slice = chunks.slice(i, i + CONCURRENCY);
    await Promise.all(slice.map(async (chunk, j) => {
      const idx = i + j;
      try {
        const md = await ocrPdfChunkGemini({
          pdfBytes: chunk.bytes,
          startPage: chunk.startPage,
          endPage: chunk.endPage,
          apiKey,
          fetchImpl: f,
        });
        results[idx] = md;
      } catch (err) {
        console.error(`[ocrPdf] chunk pages ${chunk.startPage}-${chunk.endPage} failed:`, err.message);
        results[idx] = `[Pages ${chunk.startPage}-${chunk.endPage}] (OCR failed: ${err.message})`;
      }
      if (typeof onProgress === 'function') {
        try { onProgress(idx + 1, chunks.length); } catch {}
      }
    }));
  }

  const markdown = results.join('\n\n').trim();
  return { markdown, model: OCR_MODEL, pageCount: totalPages };
}

// ---------------------------------------------------------------
// Internals
// ---------------------------------------------------------------

/**
 * OCR a chunk of pages by sending the (already-sliced) PDF directly
 * to Gemini Flash as inline_data. Gemini Flash 2.0 reads PDFs
 * natively — no rasterization needed.
 *
 * Returns the markdown for the chunk with [Page N] markers prefixed
 * for each page (we tell Gemini what page-number range to use).
 */
async function ocrPdfChunkGemini({ pdfBytes, startPage, endPage, apiKey, fetchImpl }) {
  const f = fetchImpl || globalThis.fetch;
  const base64 = bytesToBase64(pdfBytes);

  const pageInstruction = startPage === endPage
    ? `This PDF contains 1 page. Number it as page ${startPage}.`
    : `This PDF contains ${endPage - startPage + 1} pages. Number them sequentially starting at page ${startPage}.`;

  const promptText =
    OCR_PROMPT +
    `\n\nPAGE NUMBERING: ${pageInstruction}\n` +
    `Format each page as:\n[Page N]\n\n<body markdown>\n\n<annotations if any>\n\n` +
    `Then continue to the next page. Use the [Page N] marker exactly so downstream tools can split pages.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${OCR_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{
      role: 'user',
      parts: [
        { text: promptText },
        { inline_data: { mime_type: 'application/pdf', data: base64 } },
      ],
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 8192,
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ],
  };

  const r = await withTimeout(
    f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    OCR_TIMEOUT_MS,
  );
  if (!r.ok) {
    throw new Error(`OCR gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const j = await r.json();
  const md = (j.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || '')
    .join('')
    .trim();
  if (!md) throw new Error('OCR gemini returned empty output');

  // Strip common preambles models occasionally emit despite the prompt
  return md.replace(/^(?:here(?:'s| is)|the (?:transcription|markdown))[^:]*:\s*/i, '').trim();
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('OCR timeout')), ms)),
  ]);
}

function bytesToBase64(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return buf.toString('base64');
}

// ---------------------------------------------------------------
// MIME-type detection (used by library-extract.js)
// ---------------------------------------------------------------

const IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/tiff',
  'image/heic',
  'image/heif',
  'image/webp',
]);

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'tiff', 'tif', 'heic', 'heif', 'webp']);

export function isImageFile({ fileType, filename }) {
  const ft = (fileType || '').toLowerCase();
  if (IMAGE_MIME_TYPES.has(ft)) return true;
  const ext = (filename || '').toLowerCase().split('.').pop();
  return IMAGE_EXTS.has(ext);
}

export { OCR_MODEL };
