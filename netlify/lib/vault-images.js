/**
 * Vault image staging — extract, store, caption, embed.
 *
 * This module owns the lifecycle of an image embedded in a vault
 * document (DOCX, PDF). Pipeline:
 *
 *   1. extractImages — Returns the raw image bytes + position metadata.
 *      Called from library-extract.js after text extraction completes.
 *
 *   2. stageVaultImages — Upload bytes to Supabase Storage, insert
 *      rows into workspace_vault_images, and return the placeholder
 *      strings (e.g. `[image-1]`) the caller should weave into the
 *      body text where each image appeared.
 *
 *   3. captionVaultImages — Background job that calls Gemini Flash
 *      vision on each image to generate a description, then UPDATEs
 *      the row's `description` column AND rewrites the body text
 *      to upgrade `[image-1]` → `[image-1: <description>]`.
 *
 *   4. embedVaultImages — Background job that computes a multimodal
 *      embedding for each image under the user's chosen provider
 *      (Voyage-multimodal-3 or Vertex), and writes the vector to the
 *      matching column.
 *
 * SAFETY: every entry point is a graceful no-op when:
 *   - VAULT_IMAGE_EXTRACTION env var is not set (or is "off"/"false")
 *   - workspace_user_settings.vault_image_extraction_enabled = false
 *   - the workspace_vault_images table doesn't exist (migration 0032
 *     not applied yet) — INSERTs fail and we log + continue
 *
 * Errors are caught and logged; nothing here ever throws back into
 * the caller. The text-extraction path always succeeds even if the
 * image pipeline is completely broken.
 */

import { resolveProviderKey } from './byok-keys.js';
import { ocrImage as _ocrImage } from './ocr.js'; // reuse Gemini key resolution + fetch wrapping
import {
  embedImage,
  pickMultimodalProvider,
  MULTIMODAL_PROVIDERS,
  vectorLiteral,
} from './embeddings.js';

// ---------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------

/**
 * Returns true if the env var permits image extraction. The
 * per-user setting is checked separately at the callsite (since it
 * requires a DB read).
 */
export function imageExtractionEnvEnabled() {
  const v = String(process.env.VAULT_IMAGE_EXTRACTION || '').trim().toLowerCase();
  return v === '1' || v === 'on' || v === 'true' || v === 'yes';
}

/**
 * Combined check: env flag + user setting must both be true.
 * @param {object} supabase admin client
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
export async function imageExtractionEnabledForUser({ supabase, userId }) {
  if (!imageExtractionEnvEnabled()) return false;
  if (!supabase || !userId) return false;
  try {
    const { data } = await supabase
      .from('workspace_user_settings')
      .select('vault_image_extraction_enabled')
      .eq('user_id', userId)
      .maybeSingle();
    return Boolean(data?.vault_image_extraction_enabled);
  } catch {
    // Column may not exist if migration 0032 hasn't been applied.
    // Conservative: skip image extraction.
    return false;
  }
}

// ---------------------------------------------------------------
// Image-bytes constraints
// ---------------------------------------------------------------

const MIN_DIM_PX = 50;            // skip tiny icons / UI chrome
const MAX_BYTE_SIZE = 10 * 1024 * 1024;  // 10MB hard cap
const MAX_IMAGES_PER_DOC = 50;    // sanity cap

/**
 * Quick-reject filters before we do any expensive work. Returns null
 * if the image should be skipped, or { mimeType, ext, sizeBytes,
 * width?, height? } if it's accepted.
 */
function vetImage({ buffer, mimeType, width, height }) {
  if (!buffer || !buffer.length) return null;
  if (buffer.length > MAX_BYTE_SIZE) return null;
  if (width && height && (width < MIN_DIM_PX || height < MIN_DIM_PX)) return null;

  const mt = String(mimeType || '').toLowerCase();
  // Default to jpg if mime is missing — that's by far the most common
  // for embedded contract images.
  let ext = 'jpg';
  if (mt.includes('png')) ext = 'png';
  else if (mt.includes('webp')) ext = 'webp';
  else if (mt.includes('gif')) ext = 'gif';
  else if (mt.includes('bmp')) ext = 'bmp';
  else if (mt.includes('tiff')) ext = 'tiff';
  return { mimeType: mt || 'image/jpeg', ext, sizeBytes: buffer.length };
}

// ---------------------------------------------------------------
// extractDocxImages
// ---------------------------------------------------------------

/**
 * Walk word/media/* inside a DOCX zip and return the raw image bytes
 * + provisional position metadata. Pure read — does not touch
 * storage or the database.
 *
 * Returns: [{ buffer, mimeType, width?, height?, source_paragraph?,
 *             archive_path }]
 *
 * source_paragraph is best-effort: we walk document.xml, count
 * <w:p> blocks, and for each <w:drawing>/<w:pict> reference to a
 * media file, record the paragraph index. If we can't resolve the
 * reference, source_paragraph stays null.
 */
export async function extractDocxImages(buffer) {
  let JSZip;
  try {
    JSZip = (await import('jszip')).default;
  } catch {
    return [];
  }
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return [];
  }

  // 1. Find all word/media/* files
  const mediaFiles = [];
  zip.forEach((path, file) => {
    if (path.startsWith('word/media/') && !file.dir) {
      mediaFiles.push({ path, file });
    }
  });
  if (!mediaFiles.length) return [];

  // 2. Read content types for mime detection
  let contentTypesXml = '';
  try {
    contentTypesXml = await zip.file('[Content_Types].xml')?.async('string') || '';
  } catch {}

  function mimeForFilename(filename) {
    // Try [Content_Types].xml first; fall back to extension guess
    const ext = filename.split('.').pop().toLowerCase();
    const ctMatch = contentTypesXml.match(
      new RegExp(`<Default[^/]*Extension="${ext}"[^/]*ContentType="([^"]+)"`),
    );
    if (ctMatch) return ctMatch[1];
    if (ext === 'png') return 'image/png';
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'bmp') return 'image/bmp';
    if (ext === 'tiff' || ext === 'tif') return 'image/tiff';
    return 'application/octet-stream';
  }

  // 3. Build a relationship map: rId → media filename via
  //    word/_rels/document.xml.rels. Without this we can't tell which
  //    paragraph an image belongs to.
  const relsMap = {};
  try {
    const relsXml = await zip.file('word/_rels/document.xml.rels')?.async('string');
    if (relsXml) {
      const re = /<Relationship\b([^/]*?)\/>/g;
      let m;
      while ((m = re.exec(relsXml)) !== null) {
        const id = (m[1].match(/Id="([^"]+)"/) || [])[1];
        const target = (m[1].match(/Target="([^"]+)"/) || [])[1];
        if (id && target) relsMap[id] = target.replace(/^\.\.?\//, '');
      }
    }
  } catch {}

  // 4. Walk document.xml; for each paragraph, find <a:blip r:embed="rId"/>
  //    references and map them to media filenames. Build paragraph→media[].
  const paraToMedia = {};
  try {
    const docXml = await zip.file('word/document.xml')?.async('string');
    if (docXml) {
      const paraRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
      let paraIdx = 0;
      let m;
      while ((m = paraRe.exec(docXml)) !== null) {
        const inner = m[1];
        const blipRe = /<a:blip\b[^>]*\br:embed="([^"]+)"/g;
        let bm;
        while ((bm = blipRe.exec(inner)) !== null) {
          const rId = bm[1];
          const target = relsMap[rId];
          if (target) {
            // Normalize 'media/image1.png' → 'word/media/image1.png'
            const fullPath = target.startsWith('media/') ? `word/${target}` : target;
            paraToMedia[fullPath] = paraToMedia[fullPath] || [];
            paraToMedia[fullPath].push(paraIdx);
          }
        }
        paraIdx++;
      }
    }
  } catch {}

  // 5. Read each media file's bytes + assemble result
  const out = [];
  for (const { path, file } of mediaFiles) {
    if (out.length >= MAX_IMAGES_PER_DOC) break;
    let bytes;
    try {
      const ab = await file.async('arraybuffer');
      bytes = Buffer.from(ab);
    } catch {
      continue;
    }
    const vet = vetImage({ buffer: bytes, mimeType: mimeForFilename(path) });
    if (!vet) continue;
    const paras = paraToMedia[path] || [];
    out.push({
      buffer: bytes,
      mimeType: vet.mimeType,
      ext: vet.ext,
      sizeBytes: vet.sizeBytes,
      // First paragraph this image was referenced from. Multi-reference
      // images are rare in legal docs; we just pick the first.
      source_paragraph: paras.length ? paras[0] : null,
      source_kind: 'embedded',
      archive_path: path,
    });
  }
  return out;
}

// ---------------------------------------------------------------
// extractStandaloneImage — for direct PNG / JPG / WEBP uploads
// ---------------------------------------------------------------

/**
 * When the user uploads a single image file (not a DOCX/PDF carrying
 * embedded images), wrap the buffer as a one-element image array so
 * the same staging/caption/embed pipeline applies. The whole file
 * becomes a single workspace_vault_images row.
 *
 * Used by workspace-doc-extract-background.js after OCR completes
 * for image-type uploads — the OCR text still becomes the vault
 * item's body content, and this gives the image binary first-class
 * vault-image status (storage row + caption + embedding).
 */
export function extractStandaloneImage(buffer, mimeType) {
  const vet = vetImage({ buffer, mimeType });
  if (!vet) return [];
  return [{
    buffer: Buffer.from(buffer),
    mimeType: vet.mimeType,
    ext: vet.ext,
    sizeBytes: vet.sizeBytes,
    source_kind: 'attached',     // distinct from 'embedded' for filtering
    source_page: null,
    source_paragraph: null,
    source_rect: null,
    width_px: null,
    height_px: null,
  }];
}

// ---------------------------------------------------------------
// extractPdfImages — Phase 3
// ---------------------------------------------------------------

/**
 * Extract embedded images from a PDF using pdfjs-dist's operator
 * list. For each page, we walk the page's content stream operators
 * looking for paintImageXObject / paintJpegXObject calls; for each
 * matching XObject we pull the underlying image bytes via the page's
 * object store.
 *
 * IMPORTANT LIMITATION: pdfjs decodes most non-JPEG images into raw
 * RGBA pixel buffers. Re-encoding RGBA → PNG without `canvas` /
 * `sharp` (neither installed; both have native deps unsuitable for
 * Netlify Functions) would require shipping a pure-JS PNG encoder
 * (pngjs etc.). For now we ONLY save images whose underlying bytes
 * are still in JPEG / JPEG2000 / PNG / GIF format — i.e. the PDF
 * preserved the original encoded bytes. In practice this covers the
 * vast majority of legal-doc images: signatures, scanned exhibits,
 * embedded photos, and most contract logos are stored as JPEG.
 *
 * Images we skip get a console.warn so the user (or future us) knows
 * the doc had image content that didn't make it into the vault.
 *
 * Returns: same shape as extractDocxImages — { buffer, mimeType,
 *   ext, sizeBytes, source_kind, source_page, source_rect, width_px,
 *   height_px }
 */
export async function extractPdfImages(buffer) {
  let getDocument;
  try {
    ({ getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs'));
  } catch {
    return [];
  }
  let doc;
  try {
    doc = await getDocument({
      data: new Uint8Array(buffer),
      useSystemFonts: true,
      disableFontFace: true,
    }).promise;
  } catch (err) {
    console.warn('[vault-images] pdfjs load failed:', err.message);
    return [];
  }

  const out = [];
  const pageCount = doc.numPages;
  let skipped = 0;
  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    if (out.length >= MAX_IMAGES_PER_DOC) break;
    let page;
    try {
      page = await doc.getPage(pageNum);
    } catch {
      continue;
    }
    let opList;
    try {
      opList = await page.getOperatorList();
    } catch (err) {
      console.warn(`[vault-images] op list failed page ${pageNum}: ${err.message}`);
      continue;
    }

    // pdfjs OPS constants — we look up by hardcoded index since
    // the OPS export isn't always available cleanly. paintImageXObject
    // is op code 85; paintJpegXObject is 82 in pdfjs v3+. We use
    // operator name lookup if available, else fall back to numeric.
    // (Future-proofing: if pdfjs adds new opcodes we'd want to update.)
    const fnArray = opList.fnArray || [];
    const argsArray = opList.argsArray || [];

    for (let i = 0; i < fnArray.length; i++) {
      if (out.length >= MAX_IMAGES_PER_DOC) break;
      const fn = fnArray[i];
      const args = argsArray[i];
      // 82 = paintJpegXObject  (kept-as-JPEG image)
      // 85 = paintImageXObject (decoded RGBA bitmap, sometimes JPEG)
      // 86 = paintInlineImage  (small inline image, usually JPEG)
      if (fn !== 82 && fn !== 85 && fn !== 86) continue;
      const objId = Array.isArray(args) ? args[0] : null;
      if (!objId) continue;
      let imgObj;
      try {
        imgObj = page.objs.get(objId);
      } catch {
        skipped++;
        continue;
      }
      if (!imgObj) { skipped++; continue; }

      const result = pickPdfImageBytes(imgObj);
      if (!result) {
        skipped++;
        continue;
      }
      const vet = vetImage({
        buffer: result.buffer,
        mimeType: result.mimeType,
        width: imgObj.width,
        height: imgObj.height,
      });
      if (!vet) {
        skipped++;
        continue;
      }
      out.push({
        buffer: result.buffer,
        mimeType: vet.mimeType,
        ext: vet.ext,
        sizeBytes: vet.sizeBytes,
        source_kind: 'embedded',
        source_page: pageNum,
        source_paragraph: null,
        source_rect: null,
        width_px: imgObj.width || null,
        height_px: imgObj.height || null,
      });
    }
    page.cleanup?.();
  }
  await doc.destroy?.();
  if (skipped > 0) {
    console.warn(`[vault-images] PDF: skipped ${skipped} image(s) — non-JPEG raster data not currently extractable`);
  }
  return out;
}

/**
 * Inspect a pdfjs Image object and return the encoded bytes if we
 * can recover them (JPEG / JPEG2000 / PNG / GIF). Otherwise null.
 *
 * pdfjs preserves the original encoded payload in `image.data` when
 * the source filter is DCTDecode (JPEG) or JPXDecode (JPEG2000).
 * For FlateDecode + raw raster, `image.data` is decoded RGBA which
 * we can't re-encode without a PNG encoder.
 */
function pickPdfImageBytes(imgObj) {
  const data = imgObj?.data;
  if (!data || !data.length) return null;
  // ArrayBuffer, Uint8Array, or Uint8ClampedArray all have `length`
  // and a constructor we can pass to Buffer.from()
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  // Magic-byte sniff
  if (u8.length >= 3 && u8[0] === 0xFF && u8[1] === 0xD8 && u8[2] === 0xFF) {
    // JPEG (SOI marker)
    return { buffer: Buffer.from(u8), mimeType: 'image/jpeg' };
  }
  if (u8.length >= 12 && u8[0] === 0x00 && u8[1] === 0x00 && u8[2] === 0x00 && u8[3] === 0x0C
      && u8[4] === 0x6A && u8[5] === 0x50) {
    // JPEG 2000 (jP marker)
    return { buffer: Buffer.from(u8), mimeType: 'image/jp2' };
  }
  if (u8.length >= 8 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) {
    // PNG (89 50 4E 47 0D 0A 1A 0A)
    return { buffer: Buffer.from(u8), mimeType: 'image/png' };
  }
  if (u8.length >= 6 && u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x38) {
    // GIF (GIF8)
    return { buffer: Buffer.from(u8), mimeType: 'image/gif' };
  }
  // Otherwise this is raw decoded RGBA / grayscale pixels. Without a
  // PNG encoder, we can't ship it to storage in a viewable form. The
  // rare PDF that ships a PNG XObject as FlateDecode RGB would also
  // hit this path — that's the trade-off for not bundling pngjs.
  return null;
}

// ---------------------------------------------------------------
// stageVaultImages — upload bytes + insert rows
// ---------------------------------------------------------------

/**
 * Upload a list of extracted images to Supabase Storage and insert
 * a row per image into workspace_vault_images. Returns a list of
 * { id, placeholder, source_paragraph, source_page } records the
 * caller weaves into the document's body text.
 *
 * Failures on any single image are logged + skipped — the rest still
 * upload. If the workspace_vault_images table doesn't exist
 * (migration 0032 not applied), inserts fail; we return [] and the
 * caller proceeds with text-only ingest.
 *
 * @param {object} opts
 * @param {object} opts.supabase   — service-role client
 * @param {string} opts.userId
 * @param {string} opts.itemId     — workspace_vault_items.id
 * @param {Array}  opts.images     — output of extractDocxImages / extractPdfImages
 * @returns {Promise<Array<{ id, placeholder, source_paragraph, source_page }>>}
 */
export async function stageVaultImages({ supabase, userId, itemId, images }) {
  if (!supabase || !userId || !itemId) return [];
  if (!Array.isArray(images) || images.length === 0) return [];

  const out = [];
  let imageIdx = 0;
  for (const img of images) {
    imageIdx++;
    try {
      const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : require('crypto').randomUUID();
      const storagePath = `${userId}/vault-images/${id}.${img.ext}`;
      const { error: upErr } = await supabase.storage
        .from('library')
        .upload(storagePath, img.buffer, {
          contentType: img.mimeType,
          upsert: false,
        });
      if (upErr) {
        console.warn(`[vault-images] upload failed for image ${imageIdx}: ${upErr.message}`);
        continue;
      }

      const row = {
        id,
        user_id: userId,
        item_id: itemId,
        storage_path: storagePath,
        mime_type: img.mimeType,
        source_kind: img.source_kind || 'embedded',
        source_page: img.source_page ?? null,
        source_paragraph: img.source_paragraph ?? null,
        source_rect: img.source_rect ?? null,
        width_px: img.width_px ?? null,
        height_px: img.height_px ?? null,
        byte_size: img.sizeBytes ?? null,
      };
      const { error: insErr } = await supabase
        .from('workspace_vault_images')
        .insert(row);
      if (insErr) {
        // If the table doesn't exist (migration not applied), this
        // fires on EVERY image. Log once at the first occurrence and
        // continue — we don't want to spam the console.
        if (imageIdx === 1) {
          console.warn(`[vault-images] DB insert failed (migration 0032 may not be applied): ${insErr.message}`);
        }
        // Best effort: clean up the orphaned upload
        try {
          await supabase.storage.from('library').remove([storagePath]);
        } catch {}
        continue;
      }

      out.push({
        id,
        placeholder: `[image-${imageIdx}]`,
        source_paragraph: row.source_paragraph,
        source_page: row.source_page,
      });
    } catch (err) {
      console.warn(`[vault-images] staging error for image ${imageIdx}: ${err?.message || err}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------
// captionVaultImages — Gemini Flash vision → description
// ---------------------------------------------------------------

const CAPTION_MODEL = 'gemini-2.5-flash';
const CAPTION_TIMEOUT_MS = 60_000;

const CAPTION_PROMPT = `Describe this image from a contract or legal document with full visual specificity. This caption is the ONLY way downstream chat retrieval will know what's in the image, so be thorough and concrete — never generalize.

CRITICAL — capture all of the following when present:
- VERBATIM TEXT in every visible label, box, banner, caption, or stamp. Quote it exactly.
- COLORS used and what each color encodes (e.g. "purple boxes labeled 'Redis', blue boxes labeled 'App Server', green boxes labeled 'PostgreSQL'")
- SPATIAL LAYOUT (top-to-bottom or left-to-right), how elements are grouped, and what arrows / connecting lines indicate
- COUNT of distinct elements per category (e.g. "two purple boxes", "three database icons")
- ICONS / SYMBOLS visible on each element if recognizable
- ANY SECTION HEADINGS or sub-captions inside the image (e.g. "Tier 1: Frontend", "Availability Zone A")

For specific image kinds:
- DIAGRAM / CHART / FLOWCHART → list every distinct labeled element with its color and position. Quote axis labels and legend text.
- TABLE-AS-IMAGE → transcribe every cell verbatim row by row.
- SIGNATURE → transcribe the signer's typed name + handwritten name if legible. Note presence of a notary stamp or seal.
- STAMP / SEAL → transcribe the inner text exactly.
- LOGO → identify the entity name and any tagline.
- PHOTO → identify subject and any visible text on signs / labels / paperwork.

Output 3-6 sentences max but cover ALL visible text and color-coding. No preamble, no markdown, no quotes around the whole description. Be factual. If you cannot read text inside an element, say so explicitly ("the third box is too small to read") rather than skipping it.`;

/**
 * Generate descriptions for a batch of staged vault images and
 * UPDATE the row's description column. Returns a Map of imageId →
 * description so the caller can inline-substitute body-text
 * placeholders.
 *
 * Failures per-image are caught — partial results are persisted, the
 * rest continue. Uses the user's BYOK Google key if available, else
 * GOOGLE_AI_API_KEY env fallback. If no key resolves, returns an
 * empty map and skips captioning entirely (description stays null).
 *
 * @param {object} opts
 * @param {object} opts.supabase
 * @param {string} opts.userId
 * @param {Array<{ id, buffer, mimeType }>} opts.images
 * @returns {Promise<Map<string,string>>} imageId → description
 */
export async function captionVaultImages({ supabase, userId, images }) {
  if (!Array.isArray(images) || images.length === 0) return new Map();

  let apiKey;
  try {
    const r = await resolveProviderKey({ userId, provider: 'google' });
    apiKey = r.key;
  } catch (err) {
    console.warn('[vault-images] Google key resolve failed:', err?.message);
    apiKey = null;
  }
  if (!apiKey) {
    console.warn('[vault-images] no Google AI key — skipping captions');
    return new Map();
  }

  const out = new Map();
  for (const img of images) {
    if (!img?.id || !img?.buffer || !img?.mimeType) continue;
    try {
      const description = await callGeminiVision({
        imageBytes: img.buffer,
        mimeType: img.mimeType,
        prompt: CAPTION_PROMPT,
        apiKey,
      });
      if (description) {
        out.set(img.id, description);
        // Persist to DB
        try {
          await supabase
            .from('workspace_vault_images')
            .update({ description })
            .eq('id', img.id);
        } catch (err) {
          console.warn(`[vault-images] caption persist failed for ${img.id}:`, err?.message);
        }
      }
    } catch (err) {
      console.warn(`[vault-images] caption gen failed for ${img.id}:`, err?.message);
    }
  }
  return out;
}

/**
 * Call Gemini Flash vision with a single image + prompt. Returns
 * the model's text output (trimmed) or '' on failure.
 */
async function callGeminiVision({ imageBytes, mimeType, prompt, apiKey }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CAPTION_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{
      role: 'user',
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mimeType, data: Buffer.from(imageBytes).toString('base64') } },
      ],
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 800,    // doubled — 400 was clipping verbose captions
    },
    // Disable Gemini's default safety filters as fully as the API
    // allows. Mirrors the streamGoogle config in chat-stream.ts.
    // Without these, Gemini routinely truncates contract / legal-doc
    // captions mid-sentence (RECITATION + safety categories fire on
    // anything that "looks like training-data prose"). Captions for
    // contract diagrams contain phrases that trigger the
    // recitation filter; with BLOCK_NONE the model produces full
    // descriptions every time.
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_CIVIC_INTEGRITY',   threshold: 'BLOCK_NONE' },
    ],
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CAPTION_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      throw new Error(`Gemini ${r.status}: ${errText.slice(0, 200)}`);
    }
    const j = await r.json();
    const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const finishReason = j?.candidates?.[0]?.finishReason;
    // Log when Gemini truncates so we can spot RECITATION / SAFETY /
    // MAX_TOKENS issues in production. STOP is normal completion.
    if (finishReason && finishReason !== 'STOP') {
      console.warn(`[vault-images] Gemini caption finishReason=${finishReason} length=${txt.length}`);
    }
    return String(txt).trim().replace(/\s+/g, ' ').slice(0, 1200);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------
// embedVaultImages — Phase 5
// ---------------------------------------------------------------

/**
 * Generate a multimodal embedding for each staged image and write
 * the vector to the matching column on workspace_vault_images.
 *
 * Provider mapping:
 *   - User on voyage  → voyage-multimodal-3 (1024 dim)
 *   - User on gemini  → Gemini multimodal embeddings (768 dim)
 *   - User on openai  → fall back to Gemini (no OpenAI multimodal API)
 *
 * Returns a Map of imageId → provider (the column that was
 * populated), so the caller can confirm which images now have
 * vector representations and which fell back to caption-only.
 *
 * Failures are per-image: a single bad image doesn't block the rest.
 *
 * @param {object} opts
 * @param {object} opts.supabase
 * @param {string} opts.userId
 * @param {Array<{ id, buffer, mimeType, description? }>} opts.images
 * @param {string} opts.textProvider — user's text-embedding preference
 * @returns {Promise<Map<string,string>>}
 */
export async function embedVaultImages({ supabase, userId, images, textProvider }) {
  if (!Array.isArray(images) || images.length === 0) return new Map();

  const provider = pickMultimodalProvider(textProvider);
  if (!provider) {
    // No usable multimodal provider for this user. Caption text in
    // chunks already gives us search coverage; we just don't get
    // image-vector retrieval. Silent skip.
    return new Map();
  }

  // Resolve API key for the multimodal provider. Both Voyage and
  // Gemini now go through the BYOK resolver — user's stored key
  // first, then server env fallback. Voyage was added to the BYOK
  // system in migration 0038.
  let apiKey;
  const byokSlot = provider === 'voyage' ? 'voyage'
                 : provider === 'gemini' ? 'google'
                 : null;
  if (byokSlot) {
    try {
      const r = await resolveProviderKey({ userId, provider: byokSlot });
      apiKey = r.key;
    } catch {
      // Last-ditch server fallback if resolveProviderKey itself errors.
      apiKey = (provider === 'voyage')
        ? (process.env.VOYAGE_API_KEY || '')
        : (process.env.GOOGLE_AI_API_KEY || '');
    }
  }
  if (!apiKey) {
    console.warn(`[vault-images] no API key for multimodal ${provider} — skipping image embeddings`);
    return new Map();
  }

  const cfg = MULTIMODAL_PROVIDERS[provider];
  const out = new Map();
  for (const img of images) {
    if (!img?.id || !img?.buffer || !img?.mimeType) continue;
    try {
      const vec = await embedImage({
        imageBytes: img.buffer,
        mimeType: img.mimeType,
        provider,
        apiKey,
        descriptionHint: img.description || undefined,
      });
      if (!vec) continue;
      const update = { embedding_provider: provider };
      update[cfg.column] = vectorLiteral(vec);
      const { error } = await supabase
        .from('workspace_vault_images')
        .update(update)
        .eq('id', img.id);
      if (error) {
        console.warn(`[vault-images] embed persist failed for ${img.id}:`, error.message);
        continue;
      }
      out.set(img.id, provider);
    } catch (err) {
      console.warn(`[vault-images] embed failed for ${img.id}:`, err?.message || err);
    }
  }
  return out;
}

// ---------------------------------------------------------------
// applyImagePlaceholders — body-text rewriter
// ---------------------------------------------------------------

/**
 * Take a body markdown string that contains generic `[image]`
 * placeholders (one per image, in document order) and replace each
 * with `[image-N]` or `[image-N: <description>]` based on the staged
 * results.
 *
 * The Phase 2 DOCX flow places `[image]` placeholders during mammoth
 * extraction at the position of each image. We replace them in order
 * so the placeholder index matches the staged image's index.
 */
export function applyImagePlaceholders(body, staged, captionMap) {
  if (!staged || staged.length === 0) return body;
  let idx = 0;
  return String(body || '').replace(/\[image\]/g, () => {
    if (idx >= staged.length) return '[image]';
    const s = staged[idx];
    idx++;
    const cap = captionMap?.get?.(s.id);
    return cap ? `[image-${idx}: ${cap}]` : `[image-${idx}]`;
  });
}
