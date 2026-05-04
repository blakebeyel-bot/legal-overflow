/**
 * Plain-text extraction for the document library.
 *
 * Synchronous extraction of PDF, DOCX, TXT, and Markdown content from
 * a Buffer. Returns { text, chars, status } where status is 'done' or
 * 'failed'.
 *
 * pdfjs-dist is required lazily because it's heavy. Mammoth is loaded
 * the same way to keep cold starts fast for non-DOCX uploads.
 *
 * For unsupported file types (images, audio, video, archives), we
 * return status='skipped' with empty text. The UI surfaces this as
 * "preview not available".
 */

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

  // PDF
  if (PDF_TYPES.has(ft) || ext === 'pdf') {
    return await extractPdf(buffer);
  }

  // DOCX (extension check protects against octet-stream false positives)
  if (DOCX_TYPES.has(ft) && ext === 'docx' || ext === 'docx') {
    return await extractDocx(buffer);
  }

  // Plain text-like
  if (TEXT_TYPES.has(ft) || ['txt', 'md', 'markdown', 'csv', 'json', 'xml', 'html'].includes(ext)) {
    try {
      const text = buffer.toString('utf8');
      return { text, chars: text.length, status: 'done' };
    } catch (err) {
      return { text: '', chars: 0, status: 'failed', detail: err.message };
    }
  }

  return { text: '', chars: 0, status: 'skipped', detail: `Unsupported file type: ${ft || ext}` };
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

    const parts = [];
    for (let i = 1; i <= doc.numPages; i++) {
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
        if (pageText.trim()) parts.push(`[Page ${i}]\n${pageText.trim()}`);
        page.cleanup?.();
      } catch (err) {
        parts.push(`[Page ${i}] (extraction failed: ${err.message})`);
      }
    }
    await doc.destroy?.();

    const text = parts.join('\n\n');
    return { text, chars: text.length, status: text.length > 0 ? 'done' : 'failed', detail: text.length === 0 ? 'PDF has no extractable text (likely scanned)' : undefined };
  } catch (err) {
    return { text: '', chars: 0, status: 'failed', detail: `PDF parse failed: ${err.message}` };
  }
}

async function extractDocx(buffer) {
  try {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    const text = (result.value || '').trim();
    return { text, chars: text.length, status: text.length > 0 ? 'done' : 'failed' };
  } catch (err) {
    return { text: '', chars: 0, status: 'failed', detail: `DOCX parse failed: ${err.message}` };
  }
}
