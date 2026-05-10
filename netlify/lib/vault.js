/**
 * Vault helper — insert and retrieve vault items.
 *
 * Used by both the HTTP endpoints AND by auto-ingest hooks (e.g.
 * after a library upload finishes extracting, the register endpoint
 * fires this to add the doc to the vault automatically).
 *
 * Public API:
 *   addVaultItem({ supabase, userId, sourceKind, sourceIds?, title,
 *                  content, summary?, tags? })   → { item, chunks }
 *
 *   searchVault({ supabase, userId, query, topK?, kinds? })
 *                                               → [{ chunk, item, score }]
 *
 *   reembedAllForUser({ supabase, userId, newProvider })
 *
 * The supabase client passed in MUST be the service-role client
 * (getSupabaseAdmin()) so writes/reads aren't blocked by RLS — RLS
 * is enforced at the HTTP-endpoint layer where we resolve the user's
 * identity from their JWT.
 */

import {
  resolveProviderForUser,
  embed,
  embedBatch,
  embedImage,
  chunkText,
  vectorLiteral,
  pickMultimodalProvider,
  PROVIDERS,
  MULTIMODAL_PROVIDERS,
} from './embeddings.js';
import {
  imageExtractionEnabledForUser,
  extractDocxImages,
  extractPdfImages,
  extractStandaloneImage,
  stageVaultImages,
  captionVaultImages,
  embedVaultImages,
  applyImagePlaceholders,
} from './vault-images.js';

// Postgres rejects U+0000 (NULL bytes) on text columns with
// "unsupported Unicode escape sequence". DocuSign PDFs and some
// scanner outputs sneak NULLs into extracted text. Strip them and
// other unprintable C0 control chars (except tab/newline/CR) as
// defense-in-depth — library-extract.js does the same thing on the
// way in, but vault.js is also called from chat-save and
// finding-save paths where text may not have been pre-cleaned.
const _PG_CONTROL_RE = new RegExp(
  '[' +
    '\\x00-\\x08' +
    '\\x0B\\x0C' +
    '\\x0E-\\x1F' +
    '\\x7F' +
    '\\uFFFD' +
  ']',
  'g',
);
function sanitizeForPg(text) {
  if (!text) return text;
  return String(text).replace(_PG_CONTROL_RE, '');
}

// ---------------------------------------------------------------
// addVaultItem
// ---------------------------------------------------------------

/**
 * Add a piece of content to the user's vault. Inserts the header
 * row, chunks the content, embeds each chunk, and inserts the
 * chunks. Returns the item row plus the chunk rows.
 *
 * @param {object} opts
 * @param {object} opts.supabase     — service-role Supabase client
 * @param {string} opts.userId
 * @param {'document'|'chat'|'review_finding'|'manual_note'} opts.sourceKind
 * @param {object} [opts.sourceIds]  — { docId?, chatId?, messageId?, reviewId? }
 * @param {string} opts.title
 * @param {string} opts.content
 * @param {string} [opts.summary]
 * @param {string[]} [opts.tags]
 * @returns {Promise<{ item: object, chunks: object[] }>}
 */
export async function addVaultItem({
  supabase,
  userId,
  sourceKind,
  sourceIds = {},
  title,
  content,
  summary,
  tags,
  // Optional original file bytes + format. When provided AND the
  // image-extraction feature flag is enabled (env var + user setting),
  // images embedded in the doc are staged to storage, captioned, and
  // their captions are inlined into the body content before chunking.
  // Without these, behavior is identical to the pre-Phase-2 path.
  // For format='image', mimeType is also required so the standalone
  // wrapper knows the encoding without sniffing bytes.
  originalBytes,
  format,
  mimeType,
}) {
  if (!userId) throw new Error('addVaultItem: userId required');
  if (!supabase) throw new Error('addVaultItem: supabase required');
  if (!sourceKind) throw new Error('addVaultItem: sourceKind required');
  // Strip NULL bytes / C0 control chars that Postgres won't accept
  // before we trim — the cleaner can't add length but might leave the
  // string visibly identical while making it safe to insert.
  const cleanContent = sanitizeForPg(String(content || '')).trim();
  if (!cleanContent) throw new Error('addVaultItem: content is empty');
  const cleanTitle = sanitizeForPg(String(title || '')).trim().slice(0, 500);
  if (!cleanTitle) throw new Error('addVaultItem: title required');

  // Resolve embedding provider (and key) for this user
  const { provider, key, dim, column, model } = await resolveProviderForUser({ userId, supabase });

  // 1. Insert the header row (we set embedding_provider so we know
  //    which column the chunks live in, useful for re-embed jobs).
  const itemInsert = {
    user_id: userId,
    source_kind: sourceKind,
    source_doc_id:     sourceIds.docId     || null,
    source_chat_id:    sourceIds.chatId    || null,
    source_message_id: sourceIds.messageId || null,
    source_review_id:  sourceIds.reviewId  || null,
    title: cleanTitle,
    summary: summary ? sanitizeForPg(String(summary)).slice(0, 2000) : null,
    tags: Array.isArray(tags) ? tags.slice(0, 32).map((t) => String(t).slice(0, 80)) : null,
    content: cleanContent,
    embedding_provider: provider,
  };

  const { data: item, error: itemErr } = await supabase
    .from('workspace_vault_items')
    .insert(itemInsert)
    .select('*')
    .single();
  if (itemErr) throw new Error(`vault item insert failed: ${itemErr.message}`);

  // 1b. IMAGE PIPELINE — only runs when:
  //   - originalBytes + format provided by caller
  //   - VAULT_IMAGE_EXTRACTION env flag = on
  //   - user setting vault_image_extraction_enabled = true
  // Failure at any step is logged and skipped — we never let image
  // work block the text-extraction path that already succeeded.
  // Format ∈ 'docx' | 'pdf' | 'image':
  //   docx  → walk word/media/* in the zip
  //   pdf   → walk pdfjs operator list for embedded JPEG/PNG/JP2/GIF
  //   image → wrap the single buffer as a one-element array (used
  //           by the OCR background after a standalone PNG/JPG upload)
  let finalContent = cleanContent;
  if (originalBytes && (format === 'docx' || format === 'pdf' || format === 'image')) {
    try {
      const enabled = await imageExtractionEnabledForUser({ supabase, userId });
      if (enabled) {
        const rawImages = format === 'docx'
          ? await extractDocxImages(originalBytes)
          : format === 'pdf'
          ? await extractPdfImages(originalBytes)
          : extractStandaloneImage(originalBytes, mimeType);
        if (rawImages.length) {
          const staged = await stageVaultImages({
            supabase, userId, itemId: item.id, images: rawImages,
          });
          // Pair each staged record with its source bytes for captioning
          const stagedWithBytes = staged.map((s, idx) => ({
            id: s.id,
            buffer: rawImages[idx]?.buffer,
            mimeType: rawImages[idx]?.mimeType,
          }));
          const captionMap = await captionVaultImages({
            supabase, userId, images: stagedWithBytes,
          });
          // Generate multimodal embeddings for each image so the
          // search RPC can rank them in the same vector space as
          // text chunks. Caption text is passed as a hint so the
          // embedding incorporates both visual and described content.
          const embedInputs = stagedWithBytes.map((s) => ({
            id: s.id,
            buffer: s.buffer,
            mimeType: s.mimeType,
            description: captionMap.get?.(s.id) || null,
          }));
          await embedVaultImages({
            supabase, userId, images: embedInputs, textProvider: provider,
          });
          // Replace generic [image] placeholders in body content with
          // numbered ones, optionally including the caption text. The
          // placeholders were inserted during text extraction; this
          // upgrades them to `[image-1: <caption>]` form so chunks
          // pick up image content via existing keyword + semantic
          // search even when multimodal embeddings aren't usable.
          const rewritten = applyImagePlaceholders(cleanContent, staged, captionMap);
          if (rewritten !== cleanContent) {
            finalContent = sanitizeForPg(rewritten);
            await supabase
              .from('workspace_vault_items')
              .update({ content: finalContent })
              .eq('id', item.id);
            // Sync the local item object so the return value reflects
            // the rewritten content.
            item.content = finalContent;
          }
        }
      }
    } catch (err) {
      console.warn(`[vault.addVaultItem] image pipeline failed: ${err?.message || err}`);
      // finalContent remains the plain cleanContent — text path proceeds normally
    }
  }

  // 2. Chunk the content (~500 tokens each). NOTE: we chunk the FINAL
  //    content (with captions inlined if the image pipeline ran), so
  //    image content is searchable via the existing chunk index even
  //    before multimodal embeddings are added in Phase 5.
  const chunks = chunkText(finalContent, { maxTokens: 500, overlapTokens: 50 });
  if (chunks.length === 0) {
    return { item, chunks: [] };
  }

  // 3. Batch-embed all chunks
  const vectors = await embedBatch(chunks, { provider, apiKey: key });

  // 4. Insert chunk rows. Use vector literal text to populate the
  //    pgvector column. We also write a comment column so we can
  //    reconstruct content without joining the item.
  const rows = chunks.map((c, i) => {
    const row = {
      user_id: userId,
      item_id: item.id,
      chunk_index: i,
      content: c,
    };
    row[column] = vectorLiteral(vectors[i]);
    return row;
  });

  // Insert in pages of 50 to keep request bodies modest
  const inserted = [];
  for (let i = 0; i < rows.length; i += 50) {
    const slice = rows.slice(i, i + 50);
    const { data: ch, error: chErr } = await supabase
      .from('workspace_vault_chunks')
      .insert(slice)
      .select('id, item_id, chunk_index, content');
    if (chErr) {
      // Roll back the item to avoid orphans
      await supabase.from('workspace_vault_items').delete().eq('id', item.id);
      throw new Error(`vault chunk insert failed: ${chErr.message}`);
    }
    for (const row of ch) inserted.push(row);
  }

  return { item, chunks: inserted };
}

// ---------------------------------------------------------------
// searchVault
// ---------------------------------------------------------------

/**
 * Semantic search over a user's vault.
 *
 * Embeds the query with the user's chosen provider, then runs a
 * vector cosine-distance query against the matching column. Returns
 * the top `topK` chunks ordered by similarity (highest first).
 *
 * @param {object} opts
 * @param {object} opts.supabase
 * @param {string} opts.userId
 * @param {string} opts.query
 * @param {number} [opts.topK=6]
 * @param {string[]} [opts.kinds]    — filter to specific source_kinds
 * @param {boolean} [opts.includeArchived=false]
 * @returns {Promise<Array<{ chunk: object, item: object, score: number }>>}
 */
export async function searchVault({
  supabase,
  userId,
  query,
  topK = 6,
  kinds = null,
  includeArchived = false,
}) {
  if (!userId || !query || !query.trim()) return [];
  if (!supabase) throw new Error('searchVault: supabase required');

  // Resolve provider + embed the query
  let resolved;
  try {
    resolved = await resolveProviderForUser({ userId, supabase });
  } catch (err) {
    console.warn('[vault.searchVault] provider resolve failed:', err.message);
    return [];
  }
  const { provider, key, column } = resolved;

  let queryVec;
  try {
    queryVec = await embed(query.trim(), { provider, apiKey: key });
  } catch (err) {
    console.warn('[vault.searchVault] embed failed:', err.message);
    return [];
  }
  const lit = vectorLiteral(queryVec);

  // Use a SQL function for the vector search since PostgREST doesn't
  // support pgvector operators directly. We define `vault_search` in
  // an RPC stub; if the function isn't installed we fall back to a
  // raw SELECT via supabase.rpc-equivalent using a stored procedure.
  //
  // For now: use the supabase-js `rpc` interface with the function
  // workspace_vault_search defined in a later migration. As a v1
  // fallback before that function exists, we issue a regular query
  // sorted by Postgres operator via a custom view.
  //
  // SIMPLER PATH: use postgrest's filter to narrow by user, fetch all
  // chunks the user owns (capped), then compute distance client-side.
  // That's ugly — better to use rpc once we add the function.
  //
  // Below is the rpc call. The function takes: user_id uuid, query_vec
  // vector, k int, kinds text[] (nullable). Migration 0027 (or rolled
  // into 0026) defines it. Until that migration is applied we no-op.

  // Run text-chunk search and image-vector search IN PARALLEL. The
  // image search is best-effort: if migration 0032 isn't applied, the
  // image RPC silently returns nothing and we fall back to text-only.
  // Image embeddings live in the same column space as the user's
  // text provider for voyage / gemini, so we can use the same query
  // vector. For openai users, we'd need a separate Gemini embedding
  // for the query — done here in parallel and cheap enough.
  const textPromise = supabase.rpc('workspace_vault_search', {
    p_user_id: userId,
    p_query_vec: lit,
    p_top_k: topK,
    p_kinds: kinds && kinds.length ? kinds : null,
    p_provider: provider,
    p_include_archived: includeArchived,
  });
  const imagePromise = searchImageVectors({
    supabase, userId, query: query.trim(), topK,
    textProvider: provider, queryLiteral: lit,
    includeArchived,
  });

  const [textResult, imageResult] = await Promise.all([textPromise, imagePromise]);
  if (textResult.error) {
    console.warn('[vault.searchVault] rpc failed:', textResult.error.message);
  }
  const textRows = textResult.data || [];

  // Function returns rows with: chunk_id, item_id, chunk_content,
  // chunk_index, distance, item_title, item_summary, item_source_kind,
  // item_source_doc_id, item_created_at, item_pinned
  const textHits = textRows.map((row) => ({
    chunk: {
      id: row.chunk_id,
      item_id: row.item_id,
      chunk_index: row.chunk_index,
      content: row.chunk_content,
    },
    item: {
      id: row.item_id,
      title: row.item_title,
      summary: row.item_summary,
      source_kind: row.item_source_kind,
      source_doc_id: row.item_source_doc_id,
      created_at: row.item_created_at,
      pinned: row.item_pinned,
    },
    // distance is cosine distance (0 = identical, 2 = opposite). Convert
    // to a similarity score for the UI: 1 - (distance / 2).
    score: typeof row.distance === 'number' ? 1 - (row.distance / 2) : null,
    match_type: 'text',
  }));

  // Merge image hits into the result list. We slightly de-rank
  // image scores (×0.92) so equally-similar text hits surface first
  // — text retrieval is a more reliable signal for legal queries —
  // but a strong image hit can still beat a weak text hit. Dedup by
  // item: if both text and image hit the same item, keep the
  // higher-scoring one.
  const merged = new Map();
  for (const hit of textHits) {
    merged.set(hit.item.id, hit);
  }
  for (const hit of imageResult || []) {
    const existing = merged.get(hit.item.id);
    if (!existing || (hit.score || 0) > (existing.score || 0)) {
      merged.set(hit.item.id, hit);
    }
  }
  // Sort by score desc, then trim to topK
  return Array.from(merged.values())
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, topK);
}

/**
 * Image-vector search helper. Calls workspace_vault_image_search RPC
 * (defined in migration 0032). Quietly returns [] on error so the
 * text-only path always works even if the migration isn't applied
 * yet or the user has no images embedded.
 *
 * For users on OpenAI text embeddings, we fire a separate Gemini
 * query embedding in parallel since OpenAI's vector space doesn't
 * match the multimodal columns. Voyage and Gemini text embeddings
 * share dimension+space with their multimodal siblings (Voyage uses
 * the same 1024-dim space; Gemini's text-embedding-001 and the
 * multimodal embedding-001 produce compatible vectors at our
 * outputDimensionality=768).
 */
async function searchImageVectors({
  supabase, userId, query, topK, textProvider, queryLiteral, includeArchived,
}) {
  const mmProvider = pickMultimodalProvider(textProvider);
  if (!mmProvider) return [];

  // Resolve the query vector for the multimodal column space.
  let queryLit = queryLiteral;
  if (textProvider === 'openai') {
    // OpenAI users: image embeddings are stored in the gemini column;
    // re-embed the query against Gemini for the image RPC.
    try {
      const apiKey = process.env.GOOGLE_AI_API_KEY || '';
      if (!apiKey) return [];
      const vec = await embedImage({
        imageBytes: Buffer.from(query, 'utf-8'),  // dummy: text-only doesn't pass image
        mimeType: 'text/plain',
        provider: 'gemini',
        apiKey,
        descriptionHint: query,
      }).catch(() => null);
      if (!vec) return [];
      queryLit = vectorLiteral(vec);
    } catch {
      return [];
    }
  }

  try {
    const { data, error } = await supabase.rpc('workspace_vault_image_search', {
      p_user_id: userId,
      p_query_vec: queryLit,
      p_top_k: topK,
      p_provider: mmProvider,
      p_include_archived: includeArchived,
    });
    if (error) {
      // Migration 0032 not applied → RPC missing. Silent fallback.
      return [];
    }
    return (data || []).map((row) => ({
      chunk: {
        id: row.image_id,
        item_id: row.item_id,
        chunk_index: -1,           // sentinel: image hit, not a text chunk
        content: row.description || '',
      },
      image: {
        id: row.image_id,
        storage_path: row.storage_path,
        mime_type: row.mime_type,
        description: row.description,
        source_page: row.source_page,
        source_paragraph: row.source_paragraph,
        width_px: row.width_px,
        height_px: row.height_px,
      },
      item: {
        id: row.item_id,
        title: row.item_title,
        summary: row.item_summary,
        source_kind: row.item_source_kind,
        source_doc_id: row.item_source_doc_id,
        created_at: row.item_created_at,
        pinned: row.item_pinned,
      },
      // ×0.92 slight de-rank vs text hits (see merge logic in caller)
      score: typeof row.distance === 'number'
        ? (1 - (row.distance / 2)) * 0.92
        : null,
      match_type: 'image',
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------
// keywordSearchVault
// ---------------------------------------------------------------

/**
 * Exact-phrase / substring search across a user's vault chunks. No
 * embeddings — pure ilike on workspace_vault_chunks.content. Use for:
 *
 *   - "find this exact clause in any of my contracts"
 *   - users whose embedding provider isn't configured
 *   - hybrid mode (paired with semantic results)
 *
 * Returns [{ chunk, item, score, match_type }] where score is a
 * synthetic 1.0 (keyword matches aren't ranked by similarity) and
 * match_type='keyword' so the UI can label them. Dedups by item id —
 * the FIRST chunk that contains the phrase wins per item.
 *
 * @param {object} opts
 * @param {object} opts.supabase
 * @param {string} opts.userId
 * @param {string} opts.query
 * @param {number} [opts.topK=30]
 * @param {string[]} [opts.kinds]
 * @param {boolean} [opts.includeArchived=false]
 * @returns {Promise<Array<{ chunk: object, item: object, score: number, match_type: string }>>}
 */
export async function keywordSearchVault({
  supabase,
  userId,
  query,
  topK = 30,
  kinds = null,
  includeArchived = false,
}) {
  if (!userId || !query || !query.trim()) return [];
  if (!supabase) throw new Error('keywordSearchVault: supabase required');

  // Strip ilike metacharacters — we want LITERAL substring match, no
  // wildcard injection. Same strip pattern as workspace-vault-list.js.
  // Backslash also stripped so users can't smuggle escaped wildcards.
  const safe = query.trim().replace(/[%_\\]/g, '');
  if (!safe) return [];

  // 1. Page through the user's items so we can filter chunks by
  //    item_id (RLS scopes chunks via item_id → items.user_id, but
  //    PostgREST joins on FK are cleaner via .in()). Also captures
  //    item metadata for the response.
  let itemQ = supabase
    .from('workspace_vault_items')
    .select('id, title, summary, source_kind, source_doc_id, created_at, pinned, archived_at, content_chars, tags, embedding_provider, updated_at')
    .eq('user_id', userId);
  if (!includeArchived) itemQ = itemQ.is('archived_at', null);
  if (kinds && kinds.length) itemQ = itemQ.in('source_kind', kinds);
  const { data: items, error: iErr } = await itemQ;
  if (iErr) {
    console.warn('[vault.keywordSearchVault] item fetch failed:', iErr.message);
    return [];
  }
  if (!items || items.length === 0) return [];
  const itemMap = new Map(items.map((it) => [it.id, it]));
  const itemIds = items.map((it) => it.id);

  // 2. ilike-search chunks. Fetch a bit more than topK so dedup-by-item
  //    leaves us with a reasonable result set even if one document
  //    has many matching chunks.
  const fetchLimit = Math.min(500, topK * 4);
  const { data: chunks, error: cErr } = await supabase
    .from('workspace_vault_chunks')
    .select('id, item_id, chunk_index, content')
    .in('item_id', itemIds)
    .ilike('content', `%${safe}%`)
    .order('chunk_index', { ascending: true })
    .limit(fetchLimit);
  if (cErr) {
    console.warn('[vault.keywordSearchVault] chunk search failed:', cErr.message);
    return [];
  }
  if (!chunks || chunks.length === 0) return [];

  // 3. Dedup by item_id — keep the FIRST matching chunk per item
  //    (ordered by chunk_index ASC means we get the earliest hit,
  //    which is usually most representative).
  const seen = new Set();
  const results = [];
  for (const chunk of chunks) {
    if (seen.has(chunk.item_id)) continue;
    const item = itemMap.get(chunk.item_id);
    if (!item) continue;
    seen.add(chunk.item_id);
    results.push({
      chunk: {
        id: chunk.id,
        item_id: chunk.item_id,
        chunk_index: chunk.chunk_index,
        content: chunk.content,
      },
      item,
      score: 1.0,
      match_type: 'keyword',
    });
    if (results.length >= topK) break;
  }

  // 4. Also keyword-search image descriptions. Best-effort — silently
  //    skipped if the workspace_vault_images table doesn't exist.
  try {
    const { data: imgRows } = await supabase
      .from('workspace_vault_images')
      .select('id, item_id, storage_path, mime_type, description, source_page, source_paragraph')
      .in('item_id', itemIds)
      .ilike('description', `%${safe}%`)
      .limit(Math.min(100, topK * 2));
    if (Array.isArray(imgRows)) {
      for (const img of imgRows) {
        if (seen.has(img.item_id)) continue;     // text chunk already won this item
        const item = itemMap.get(img.item_id);
        if (!item) continue;
        seen.add(img.item_id);
        results.push({
          chunk: {
            id: img.id,
            item_id: img.item_id,
            chunk_index: -1,
            content: img.description || '',
          },
          image: {
            id: img.id,
            storage_path: img.storage_path,
            mime_type: img.mime_type,
            description: img.description,
            source_page: img.source_page,
            source_paragraph: img.source_paragraph,
          },
          item,
          score: 0.95,                            // slight de-rank vs text keyword hits
          match_type: 'image_keyword',
        });
        if (results.length >= topK) break;
      }
    }
  } catch {
    // Migration 0032 not applied yet — skip image keyword search
  }

  return results;
}

// ---------------------------------------------------------------
// reembedAllForUser
// ---------------------------------------------------------------

/**
 * Re-embed every chunk for a given user under a new provider. Used
 * when the user changes their vault_embedding_provider in settings.
 *
 * Process:
 *   1. Update workspace_user_settings.vault_embedding_provider
 *   2. Walk every workspace_vault_items row for the user; for each
 *      item:
 *        a. Pull all its chunk rows
 *        b. Batch-embed under the new provider
 *        c. UPDATE each chunk row, setting the new provider's vector
 *           column and clearing the others
 *        d. Update the item's embedding_provider
 *
 * Long-running. Caller should invoke from a background function
 * (workspace-vault-reembed-background).
 */
export async function reembedAllForUser({ supabase, userId, newProvider }) {
  if (!supabase) throw new Error('reembedAllForUser: supabase required');
  if (!userId) throw new Error('reembedAllForUser: userId required');
  if (!PROVIDERS[newProvider]) throw new Error(`reembedAllForUser: unknown provider ${newProvider}`);

  // 1. Set the user's provider preference (source of truth for
  //    resolveProviderForUser used below).
  await supabase
    .from('workspace_user_settings')
    .upsert(
      { user_id: userId, vault_embedding_provider: newProvider },
      { onConflict: 'user_id' },
    );

  // 2. Resolve key for the new provider
  const { provider, key, column } = await resolveProviderForUser({ userId, supabase });
  if (provider !== newProvider) {
    throw new Error(`reembed: provider mismatch after upsert (expected ${newProvider}, got ${provider})`);
  }

  // 3. Page through items
  const PAGE = 25;
  let offset = 0;
  let processed = 0;
  while (true) {
    const { data: items, error: iErr } = await supabase
      .from('workspace_vault_items')
      .select('id, embedding_provider')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (iErr) throw new Error(`reembed list failed: ${iErr.message}`);
    if (!items || items.length === 0) break;

    for (const item of items) {
      if (item.embedding_provider === newProvider) {
        // Already on the right provider — skip (e.g. items added
        // mid-reembed under the new provider).
        continue;
      }

      const { data: chunks, error: cErr } = await supabase
        .from('workspace_vault_chunks')
        .select('id, content, chunk_index')
        .eq('item_id', item.id)
        .order('chunk_index', { ascending: true });
      if (cErr) throw new Error(`reembed chunk fetch failed: ${cErr.message}`);
      if (!chunks || chunks.length === 0) continue;

      const texts = chunks.map((c) => c.content);
      const vectors = await embedBatch(texts, { provider, apiKey: key });

      // Update each chunk: clear the OTHER provider columns and set
      // the new one. We use a per-row UPDATE because PostgREST doesn't
      // do UPSERT-with-different-payloads in bulk.
      for (let i = 0; i < chunks.length; i++) {
        const update = {
          embedding_voyage: null,
          embedding_openai: null,
          embedding_gemini: null,
        };
        update[column] = vectorLiteral(vectors[i]);
        const { error: uErr } = await supabase
          .from('workspace_vault_chunks')
          .update(update)
          .eq('id', chunks[i].id);
        if (uErr) throw new Error(`reembed chunk update failed: ${uErr.message}`);
      }

      // Mark the item as on the new provider
      await supabase
        .from('workspace_vault_items')
        .update({ embedding_provider: newProvider })
        .eq('id', item.id);

      processed++;
    }

    if (items.length < PAGE) break;
    offset += PAGE;
  }

  return { reembeddedItems: processed };
}

// ---------------------------------------------------------------
// Helper: format vault chunks into a system-prompt context block
// ---------------------------------------------------------------

/**
 * Build the `=== YOUR VAULT ===` block that gets inlined into the
 * chat system prompt. Each snippet shows its title + source kind +
 * (optional) created date for provenance.
 *
 * @param {Array<{ chunk: object, item: object, score: number }>} results
 * @returns {string} markdown-ish block ready to inline
 */
export function buildVaultContextBlock(results) {
  if (!Array.isArray(results) || results.length === 0) return '';
  const lines = [
    '=== YOUR VAULT (relevant context from your prior work) ===',
    '',
  ];
  results.forEach((r, i) => {
    const src = humanizeSource(r.item?.source_kind);
    const datePart = r.item?.created_at ? formatShortDate(r.item.created_at) : '';
    const meta = [src, datePart].filter(Boolean).join(' · ');
    lines.push(`[${i + 1}] ${r.item?.title || 'Untitled'}${meta ? `  (${meta})` : ''}`);
    lines.push((r.chunk?.content || '').trim());
    lines.push('');
  });
  lines.push('=== END VAULT ===');
  return lines.join('\n');
}

function humanizeSource(kind) {
  switch (kind) {
    case 'document':       return 'document';
    case 'chat':           return 'chat';
    case 'review_finding': return 'review finding';
    case 'manual_note':    return 'note';
    default: return kind || '';
  }
}

function formatShortDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short' });
  } catch {
    return '';
  }
}
