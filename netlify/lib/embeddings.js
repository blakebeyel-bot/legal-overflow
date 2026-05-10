/**
 * Multi-provider embedding helper for the Vault.
 *
 * Three supported providers, each producing fixed-dimension vectors:
 *   - voyage : voyage-3                  → 1024 dims
 *   - openai : text-embedding-3-small    → 1536 dims
 *   - gemini : text-embedding-004        → 768 dims
 *
 * Per-user provider preference lives in workspace_user_settings.
 * Switching providers triggers a re-embed of all of that user's
 * chunks (handled by workspace-vault-reembed-background.js).
 *
 * Provider key resolution: the user's BYOK key wins; fall back to a
 * server env var; fail with a clear error if neither exists.
 *
 *   Voyage  → user's `voyage` BYOK key, then VOYAGE_API_KEY
 *   OpenAI  → user's `openai` BYOK key, then LO_OPENAI_API_KEY / OPENAI_API_KEY
 *   Gemini  → user's `google` BYOK key, then GOOGLE_AI_API_KEY (free tier)
 *
 * Pure ESM, runtime-portable (Deno edge + Node functions).
 */

import { resolveProviderKey } from './byok-keys.js';

// ---------------------------------------------------------------
// Provider config
// ---------------------------------------------------------------

export const PROVIDERS = {
  voyage: {
    dim: 1024,
    column: 'embedding_voyage',
    model: 'voyage-3',
    // Voyage has its own API. If/when the user adds a Voyage BYOK key
    // entry, byok-keys.js needs to know about provider='voyage'. Until
    // then we always use the server env. resolveKey() handles this.
  },
  openai: {
    dim: 1536,
    column: 'embedding_openai',
    model: 'text-embedding-3-small',
  },
  gemini: {
    dim: 768,
    column: 'embedding_gemini',
    // gemini-embedding-001 replaced text-embedding-004 in late 2024.
    // Default output is 3072 dims; we request 768 via outputDimensionality
    // to match our vector(768) column. The model uses Matryoshka
    // representation learning so 768-dim is a valid prefix of 3072.
    model: 'gemini-embedding-001',
  },
};

// ---------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------

/**
 * Read the user's vault settings + resolve the API key for their
 * chosen embedding provider. Returns:
 *   { provider, key, source, dim, column, model }
 * Throws if no key is available (caller should surface an error to
 * the user prompting them to add a BYOK key or contact support).
 */
export async function resolveProviderForUser({ userId, supabase }) {
  // Load (or create) the user's settings row.
  let { data: settings } = await supabase
    .from('workspace_user_settings')
    .select('vault_embedding_provider')
    .eq('user_id', userId)
    .maybeSingle();
  if (!settings) {
    // Auto-create with defaults so first-time vault use just works.
    await supabase.from('workspace_user_settings').insert({ user_id: userId });
    settings = { vault_embedding_provider: 'gemini' };
  }
  const provider = settings.vault_embedding_provider || 'gemini';

  // Map embedding provider → BYOK provider name. OpenAI maps 1:1.
  // Gemini uses Google's BYOK slot. Voyage isn't yet a BYOK provider
  // (we'd extend byok-keys to handle 'voyage' if/when users want it).
  const byokSlot = provider === 'gemini' ? 'google'
                : provider === 'openai' ? 'openai'
                : provider === 'voyage' ? 'voyage'
                : null;

  let key = null;
  let source = 'none';

  if (byokSlot && byokSlot !== 'voyage') {
    const r = await resolveProviderKey({ userId, provider: byokSlot });
    key = r.key;
    source = r.source;
  }

  // Voyage-specific server fallback. byok-keys.js currently doesn't
  // know 'voyage'; read straight from env until/unless we add it.
  if (!key && provider === 'voyage') {
    key = process.env.VOYAGE_API_KEY || null;
    source = key ? 'server' : 'none';
  }

  if (!key) {
    throw new Error(
      `No API key available for embedding provider "${provider}". ` +
      `Add a BYOK key in your account settings, or contact support to enable a server-side fallback.`,
    );
  }

  const cfg = PROVIDERS[provider];
  return { provider, key, source, dim: cfg.dim, column: cfg.column, model: cfg.model };
}

// ---------------------------------------------------------------
// Embedding calls
// ---------------------------------------------------------------

const TIMEOUT_MS = 30_000;

function withTimeout(promise, ms = TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('embedding timeout')), ms)),
  ]);
}

/**
 * Embed a single string. Returns a Float32Array (or plain number[] —
 * pgvector accepts either when serialized to text).
 *
 * Throws on any error. Caller should retry or surface the failure.
 */
export async function embed(text, { provider, apiKey, fetchImpl } = {}) {
  if (!text || !text.trim()) {
    throw new Error('embed: empty text');
  }
  const out = await embedBatch([text], { provider, apiKey, fetchImpl });
  return out[0];
}

/**
 * Embed an array of strings in a single API call where each provider
 * supports it (all three do). For very large batches we chunk to stay
 * under each provider's per-request token cap.
 */
export async function embedBatch(texts, { provider, apiKey, fetchImpl } = {}) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  if (!provider || !apiKey) {
    throw new Error('embedBatch requires provider + apiKey');
  }
  const f = fetchImpl || globalThis.fetch;

  // Hard cap per request (rough; providers all accept way more, but
  // we want to keep latency predictable and avoid edge-case 4xxs):
  const PER_BATCH = 64;
  const results = [];
  for (let i = 0; i < texts.length; i += PER_BATCH) {
    const slice = texts.slice(i, i + PER_BATCH);
    const part = await embedSlice(slice, { provider, apiKey, fetchImpl: f });
    for (const v of part) results.push(v);
  }
  return results;
}

async function embedSlice(texts, { provider, apiKey, fetchImpl }) {
  if (provider === 'openai') return embedOpenAI(texts, apiKey, fetchImpl);
  if (provider === 'gemini') return embedGemini(texts, apiKey, fetchImpl);
  if (provider === 'voyage') return embedVoyage(texts, apiKey, fetchImpl);
  throw new Error(`embed: unknown provider ${provider}`);
}

async function embedOpenAI(texts, apiKey, f) {
  const r = await withTimeout(f('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: PROVIDERS.openai.model, input: texts }),
  }));
  if (!r.ok) {
    throw new Error(`embed openai ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const j = await r.json();
  // OpenAI returns data sorted by `index`; sort defensively just in case.
  const sorted = (j.data || []).slice().sort((a, b) => (a.index || 0) - (b.index || 0));
  return sorted.map((d) => d.embedding);
}

async function embedVoyage(texts, apiKey, f) {
  const r = await withTimeout(f('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: PROVIDERS.voyage.model,
      input: texts,
      input_type: 'document',
    }),
  }));
  if (!r.ok) {
    throw new Error(`embed voyage ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const j = await r.json();
  const sorted = (j.data || []).slice().sort((a, b) => (a.index || 0) - (b.index || 0));
  return sorted.map((d) => d.embedding);
}

async function embedGemini(texts, apiKey, f) {
  // Gemini's batchEmbedContents takes one request per text in a batch
  // wrapper. The :embedContent endpoint is single-only; :batchEmbedContents
  // is the batched form. Each request must echo the model and may set
  // outputDimensionality (we trim to 768 to match our vector column).
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${PROVIDERS.gemini.model}:batchEmbedContents?key=${encodeURIComponent(apiKey)}`;
  const requests = texts.map((t) => ({
    model: `models/${PROVIDERS.gemini.model}`,
    content: { parts: [{ text: t }] },
    outputDimensionality: PROVIDERS.gemini.dim,
  }));
  const r = await withTimeout(f(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requests }),
  }));
  if (!r.ok) {
    throw new Error(`embed gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const j = await r.json();
  const out = (j.embeddings || []).map((e) => e.values || []);
  if (out.length !== texts.length) {
    throw new Error(`embed gemini: expected ${texts.length} embeddings, got ${out.length}`);
  }
  return out;
}

// ---------------------------------------------------------------
// Multimodal embeddings (Phase 5 — vault images)
// ---------------------------------------------------------------

/**
 * Multimodal-capable provider config.
 *
 * VOYAGE — `voyage-multimodal-3` exposes a true multimodal embedding
 * API at /v1/multimodalembeddings that takes text + image content
 * blocks together. Requires VOYAGE_API_KEY env var.
 *
 * GEMINI — Google's TRUE multimodal embedding model is
 * `multimodalembedding@001` and lives ONLY on Vertex AI (not on the
 * standard Generative Language API). Vertex requires GCP service-
 * account auth (OAuth2 access tokens), not the simple API-key auth
 * used by the rest of this file. We deliberately do NOT expose Gemini
 * as a multimodal embedding provider — users on Gemini text
 * embeddings get image attachment via the chat-stream fallback path
 * (text chunks containing `[image-N:` markers trigger image lookup
 * by item_id without needing a vector match).
 *
 * OPENAI — no public multimodal embedding API; same fallback applies.
 *
 * The `column` field MUST match a column in workspace_vault_images.
 */
export const MULTIMODAL_PROVIDERS = {
  voyage: {
    dim: 1024,
    column: 'embedding_voyage',
    model: 'voyage-multimodal-3',
  },
};

/**
 * Embed a single image into a vector under the given provider. The
 * image is provided as base64-encoded bytes + a mime type. Returns
 * the vector as a number[] of length PROVIDERS[provider].dim.
 *
 * Multimodal providers:
 *   - voyage  : voyage-multimodal-3 (1024 dim) — accepts image + text
 *               in the same request via the multimodal/embed endpoint
 *   - gemini  : Vertex multimodal embeddings (768 dim) — accepts an
 *               inline_data part with mime_type + base64 data
 *
 * If provider is 'openai' (no public multimodal API), returns null.
 * Caller should fall back to text-only embeddings on the description.
 *
 * @param {object} opts
 * @param {Buffer|Uint8Array} opts.imageBytes
 * @param {string} opts.mimeType
 * @param {string} opts.provider — 'voyage' | 'gemini' | 'openai'
 * @param {string} opts.apiKey
 * @param {string} [opts.descriptionHint] — optional caption text to
 *                  include alongside the image (Voyage supports this
 *                  natively; for Gemini we include it as a separate
 *                  text part in the same content block)
 * @param {function} [opts.fetchImpl]
 * @returns {Promise<number[]|null>}
 */
export async function embedImage({
  imageBytes,
  mimeType,
  provider,
  apiKey,
  descriptionHint,
  fetchImpl,
}) {
  if (!imageBytes || !mimeType || !provider || !apiKey) return null;
  const f = fetchImpl || globalThis.fetch;
  const b64 = Buffer.from(imageBytes).toString('base64');

  if (provider === 'voyage') {
    // voyage-multimodal-3 — POST to /v1/multimodalembeddings
    // Inputs: array of content objects; each can mix text + image.
    const inputs = [{
      content: [
        ...(descriptionHint ? [{ type: 'text', text: descriptionHint }] : []),
        { type: 'image_base64', image_base64: `data:${mimeType};base64,${b64}` },
      ],
    }];
    const r = await withTimeout(f('https://api.voyageai.com/v1/multimodalembeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MULTIMODAL_PROVIDERS.voyage.model,
        inputs,
        input_type: 'document',
      }),
    }));
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`embedImage voyage ${r.status}: ${txt.slice(0, 200)}`);
    }
    const j = await r.json();
    const vec = j?.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length !== MULTIMODAL_PROVIDERS.voyage.dim) {
      throw new Error(`embedImage voyage: unexpected response shape (got ${vec?.length} dim)`);
    }
    return vec;
  }

  // Gemini and OpenAI: no public multimodal embedding APIs that work
  // with simple API-key auth. Caller should rely on:
  //   - Caption text inlined in chunks (every chat model can read)
  //   - Chat-stream image-attachment fallback (vision models get
  //     pixels for any item whose chunks reference `[image-N:`
  //     markers, regardless of vector embedding state)
  return null;
}

/**
 * Map a text-embedding provider preference to a usable multimodal
 * embedding provider. Voyage is the only currently-supported option
 * (Vertex AI requires service-account auth we don't wire up).
 *
 * Returns null when no multimodal provider is usable. Callers must
 * gracefully fall back to caption-text retrieval (works for all
 * users) and chat-stream's text-chunk-anchored image attachment
 * fallback (works for vision-capable chat models regardless of
 * embedding provider).
 */
export function pickMultimodalProvider(textProvider) {
  if (textProvider === 'voyage') return 'voyage';
  // Gemini / OpenAI users: no multimodal vector search. Image
  // attachment to chat still works via the text-chunk fallback in
  // workspace-chat-stream.ts.
  return null;
}

// ---------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------

/**
 * Split a long text into ~maxTokens-sized chunks with overlap. Tries
 * to break on paragraph boundaries (\n\n) first, then sentence
 * boundaries, then word boundaries. Token count is approximated as
 * 4 chars/token (good enough for chunk sizing; we don't need perfect
 * token alignment because embedding models truncate gracefully).
 *
 * @param {string} text
 * @param {{ maxTokens?: number, overlapTokens?: number }} [opts]
 * @returns {string[]}
 */
export function chunkText(text, { maxTokens = 500, overlapTokens = 50 } = {}) {
  const s = String(text || '');
  if (!s.trim()) return [];

  const CHARS_PER_TOKEN = 4;
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * CHARS_PER_TOKEN;

  // Fast path — short content fits in one chunk
  if (s.length <= maxChars) {
    return [s.trim()];
  }

  // 1. Split on paragraph breaks first.
  const paragraphs = s.split(/\n{2,}/g).map((p) => p.trim()).filter(Boolean);

  const chunks = [];
  let current = '';

  function flush() {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  }

  for (const p of paragraphs) {
    // If a single paragraph is bigger than maxChars, split it further
    // by sentences and then by hard char limits.
    if (p.length > maxChars) {
      flush();
      const sentences = p.split(/(?<=[.!?])\s+(?=[A-Z(0-9])/g);
      let inner = '';
      for (const sent of sentences) {
        if (sent.length > maxChars) {
          // Last resort: hard char split
          if (inner.trim()) { chunks.push(inner.trim()); inner = ''; }
          for (let i = 0; i < sent.length; i += maxChars - overlapChars) {
            const slice = sent.slice(Math.max(0, i - overlapChars), i + maxChars);
            chunks.push(slice.trim());
          }
          continue;
        }
        if ((inner + ' ' + sent).length > maxChars) {
          if (inner.trim()) chunks.push(inner.trim());
          // Carry overlap: keep the tail of the previous chunk as a head
          inner = inner.length > overlapChars ? inner.slice(-overlapChars) + ' ' + sent : sent;
        } else {
          inner = inner ? inner + ' ' + sent : sent;
        }
      }
      if (inner.trim()) chunks.push(inner.trim());
      continue;
    }

    if ((current + '\n\n' + p).length > maxChars) {
      flush();
      // Carry overlap so the start of this paragraph can reference the
      // tail of the previous chunk.
      // (We just start fresh — overlap handled by sentence-level split
      // above when paragraphs are large.)
      current = p;
    } else {
      current = current ? current + '\n\n' + p : p;
    }
  }
  flush();

  return chunks;
}

// ---------------------------------------------------------------
// pgvector serialization
// ---------------------------------------------------------------

/**
 * Convert an embedding array into the pgvector text-literal form:
 *   "[0.123, -0.456, ...]"
 * Supabase's PostgREST accepts this verbatim when inserting into a
 * vector(N) column.
 */
export function vectorLiteral(embedding) {
  if (!embedding) return null;
  const arr = Array.isArray(embedding) ? embedding : Array.from(embedding);
  return '[' + arr.map((n) => Number(n).toFixed(7)).join(',') + ']';
}
