/**
 * GET /api/workspace-models-list
 *
 * Returns the current list of chat-capable models from all three
 * providers. Pulled from each provider's models API live, so when
 * Anthropic/OpenAI/Google ship a new model it shows up automatically
 * on next refresh — no code changes required.
 *
 * Response: { models: [{ id, label, provider }], cached_at }
 *
 * Auth-gated; approval-gated. Cached in memory per cold-start for 1h
 * to avoid hammering provider APIs and to keep response time fast.
 */
import { requireUser, checkUserApproval } from '../lib/supabase-admin.js';
import { resolveProviderKey } from '../lib/byok-keys.js';

const CACHE_TTL_MS = 60 * 60 * 1000;   // 1 hour
// Per-user cache so users with their own BYOK keys see their own
// reachable model list. Keyed by `${userId}:${provider}` so each
// (user, provider) pair caches independently. Bounded — old keys
// fall off naturally on cold-start. Memory cost is trivial since
// the value is a small array of model objects.
const cache = new Map();              // key → { models, ts }

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return e;
}

function cacheSet(key, models) {
  cache.set(key, { models, ts: Date.now() });
}

// ---------- Provider model fetchers ----------
// Each returns [{ id, label, provider }] or [] on failure.

// ---- Vision capability detection ----
// True when a model ID supports image inputs alongside text. Used by
// the chat UI to badge vision-capable models so users know which
// models will read embedded images from their vault docs.
//
// Anthropic — all post-Claude-2 generations (3+) accept vision.
// OpenAI   — GPT-4o family, GPT-4 Turbo, GPT-4.1, GPT-5 family.
// Google   — Gemini 1.5+, 2.0+, 2.5+ are natively multimodal.
// xAI      — grok-4 vision variants, grok-2-vision.
//
// Conservative defaults: when unclear, return false. Callers should
// surface the badge only when this returns true so we don't over-claim.
function modelSupportsVision(id, provider) {
  const s = (id || '').toLowerCase();
  if (provider === 'anthropic') {
    // claude-3-*, claude-3-5-*, claude-3-7-*, claude-sonnet-4-*,
    // claude-opus-4-*, claude-haiku-4-*, claude-haiku-3-5-* all
    // support vision. Claude-2 / claude-instant don't (deprecated).
    if (/^claude-(3|sonnet-4|opus-4|haiku-(3-5|4))/.test(s)) return true;
    return false;
  }
  if (provider === 'openai') {
    // gpt-4o, gpt-4-turbo, gpt-4.1, gpt-5* all support vision.
    // o1 / o3 (reasoning models) historically don't accept image
    // input directly — be conservative.
    if (/^gpt-(4o|4-turbo|4\.1|5)/.test(s)) return true;
    return false;
  }
  if (provider === 'google') {
    // Gemini 1.5+, 2.x — all multimodal. Gemma is text-only.
    if (/^gemini-(1\.5|2\.0|2\.5|3|exp)/.test(s)) return true;
    return false;
  }
  if (provider === 'xai') {
    // grok-4+ is multimodal via the /v1/responses endpoint when the
    // request uses the input_text / input_image content schema
    // (different from OpenAI Chat Completions' image_url nested
    // object). The chat-stream now emits the right shape per
    // provider, so grok-4 variants without "non-reasoning" are
    // vision-capable.
    if (/non-reasoning/.test(s)) return false;
    if (/(.*-vision|.*-fast-vision)/.test(s)) return true;
    if (/^grok-(4|3-vision|2-vision)/.test(s)) return true;
    return false;
  }
  return false;
}

// Reasoning capability detection — true when the model supports
// extended-thinking / high-reasoning-effort knobs via its API.
//   Anthropic — Claude 3.7+, sonnet-4*, opus-4*, haiku-4* (extended thinking)
//   OpenAI    — o1*, o3*, o4*, gpt-5* family (reasoning_effort)
//   Google    — Gemini 2.5+ (thinkingConfig)
//   xAI       — Grok 3+/4* (reasoning_effort), excluding "-non-reasoning" suffix
// When the toggle is off, none of these knobs are sent and the
// model uses its default behavior. When on, we pass a "high" /
// generous-budget setting so the model thinks harder before
// responding.
// Returns true ONLY when the deep-think toggle has a real effect:
// either the model accepts an explicit reasoning-effort knob OR
// supports an extended-thinking budget. We deliberately EXCLUDE
// "always-reasoning" SKUs (e.g. grok-*-reasoning) because they
// reject the param at the API layer — the toggle would just 400.
//
// Per-provider reality (verified against current API docs):
//   Anthropic — Claude 3.7+ / Claude 4* / Claude 4.5* accept
//               `thinking: {type:'enabled', budget_tokens}`. No
//               always-on reasoning SKUs to exclude.
//   OpenAI    — o1/o3/o4 + GPT-5 family accept `reasoning_effort`.
//               OpenAI exposes the knob on every reasoning model
//               (no exclusions).
//   Google    — Gemini 2.5+ accepts `thinkingConfig.thinkingBudget`.
//               Older Gemini versions ignore it; safe to send but
//               ineffective, so we hide the toggle.
//   xAI       — grok-4 base variants accept `reasoning.effort` via
//               Responses API. EXCLUDE:
//                 - "*-reasoning" suffixes — always reason; param 400s
//                 - "*-non-reasoning" — text-only, no reasoning at all
//                 - "*-vision" without 4-base — not reasoning models
function modelSupportsReasoning(id, provider) {
  const s = (id || '').toLowerCase();
  if (provider === 'anthropic') {
    return /^claude-(3-7|sonnet-4|opus-4|haiku-4)/.test(s);
  }
  if (provider === 'openai') {
    return /^(o[1-9]|gpt-5)/.test(s);
  }
  if (provider === 'google') {
    return /^gemini-(2\.5|3|exp)/.test(s);
  }
  if (provider === 'xai') {
    // Always-on reasoning SKUs reject the explicit param.
    if (/-reasoning(?:-|$)/.test(s)) return false;
    // Non-reasoning text-only SKUs don't reason at all.
    if (/-non-reasoning/.test(s)) return false;
    // Vision-only / mini SKUs without 4-series base aren't on the
    // Responses API reasoning path.
    return /^grok-4/.test(s);
  }
  return false;
}

async function fetchAnthropicModels(key) {
  if (!key) return [];
  try {
    const r = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.data || [])
      .filter((m) => /^claude-/.test(m.id))
      .map((m) => ({
        id: m.id,
        label: m.display_name || prettifyClaude(m.id),
        provider: 'anthropic',
        vision: modelSupportsVision(m.id, 'anthropic'),
        reasoning: modelSupportsReasoning(m.id, 'anthropic'),
        created: m.created_at ? Date.parse(m.created_at) : 0,
      }));
  } catch (err) {
    console.warn('Anthropic models fetch failed:', err.message);
    return [];
  }
}

async function fetchOpenAIModels(key) {
  if (!key) return [];
  try {
    const r = await fetch('https://api.openai.com/v1/models', {
      headers: { authorization: `Bearer ${key}` },
    });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.data || [])
      // Keep only chat-capable models. Filter out embeddings,
      // whisper, tts, image, moderation, fine-tunes, and old aliases.
      .filter((m) => {
        const id = m.id || '';
        if (!/^(gpt-|o1|o3|o4|chatgpt-)/i.test(id)) return false;
        if (/embed|whisper|tts|dall-e|image|moderation|audio|realtime|search|transcribe|computer-use/i.test(id)) return false;
        return true;
      })
      .map((m) => ({
        id: m.id,
        label: prettifyOpenAI(m.id),
        provider: 'openai',
        vision: modelSupportsVision(m.id, 'openai'),
        reasoning: modelSupportsReasoning(m.id, 'openai'),
        created: (m.created || 0) * 1000,
      }));
  } catch (err) {
    console.warn('OpenAI models fetch failed:', err.message);
    return [];
  }
}

async function fetchXAIModels(key) {
  if (!key) return [];
  try {
    // xAI is OpenAI-compatible; same /v1/models endpoint shape.
    const r = await fetch('https://api.x.ai/v1/models', {
      headers: { authorization: `Bearer ${key}` },
    });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.data || [])
      .filter((m) => /^grok-/i.test(m.id || ''))
      // Strip image-generation / non-chat SKUs that show up alongside
      // chat models in xAI's /models response. "grok-imagine" is an
      // image generator (text → image), not a chat model — including
      // it in the chat picker confuses users since it can't answer
      // questions. Same defensive cut for any future "image-only"
      // variant ids.
      .filter((m) => !/imagine|image-quality|image-gen|^grok-image/i.test(m.id || ''))
      .map((m) => ({
        id: m.id,
        label: prettifyGrok(m.id),
        provider: 'xai',
        vision: modelSupportsVision(m.id, 'xai'),
        reasoning: modelSupportsReasoning(m.id, 'xai'),
        created: (m.created || 0) * 1000,
      }));
  } catch (err) {
    console.warn('xAI models fetch failed:', err.message);
    return [];
  }
}

async function fetchGoogleModels(key) {
  if (!key) return [];
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=100`);
    if (!r.ok) return [];
    const j = await r.json();
    return (j.models || [])
      .filter((m) => {
        const name = m.name || '';
        // models/gemini-... or models/gemma-...
        if (!/models\/gemini-/.test(name)) return false;
        // Must support generateContent
        const methods = m.supportedGenerationMethods || [];
        if (!methods.includes('generateContent')) return false;
        // Skip embedding-only and image-generation models. The
        // "*-image*" pattern catches gemini-2.5-flash-image-preview
        // (Google's "Nano Banana" image generator) and any future
        // image-output SKUs that masquerade as chat models. They
        // technically respond on generateContent but their output
        // is image data, not text — useless in the chat picker.
        if (/embedding|aqa|imagen/i.test(name)) return false;
        if (/-image\b|-image-/i.test(name)) return false;
        if (/nano-banana/i.test(name)) return false;
        // Skip TTS / audio / live / video models that some accounts
        // see in the gemini family listing.
        if (/tts|audio|live|native-audio|video/i.test(name)) return false;
        // Skip models Google has flagged as "no longer available to
        // new users" — they appear in the /models list but return
        // 404 on generateContent. Add new IDs here as Google retires
        // them. (gemini-2.0-flash-lite confirmed deprecated 2026.)
        const id = name.replace(/^models\//, '').toLowerCase();
        const DEPRECATED = [
          'gemini-2.0-flash-lite',
          'gemini-pro',                  // 1.0 alias, replaced by 2.5
          'gemini-1.0-pro',
          'gemini-1.0-pro-vision',
          'gemini-pro-vision',
        ];
        if (DEPRECATED.includes(id)) return false;
        // Defensive: also drop any "*-001" variants of deprecated IDs
        // (e.g. gemini-2.0-flash-lite-001) since Google often keeps
        // the dated snapshot listed even after the alias is dead.
        if (DEPRECATED.some((d) => id.startsWith(d + '-'))) return false;
        // Drop dated preview snapshots (`*-preview-05-06`) and
        // specialty preview variants (`*-preview-tts`,
        // `*-preview-native-audio`, `*-preview-image-generation`).
        // The bare canonical `*-preview` alias is allowed downstream
        // by isPreviewOrSnapshot so users see Gemini 3 etc. as soon
        // as Google ships them (often as preview for months before
        // stable).
        if (/-preview-/.test(id)) return false;
        return true;
      })
      .map((m) => {
        const id = (m.name || '').replace(/^models\//, '');
        return {
          id,
          label: m.displayName || prettifyGemini(id),
          provider: 'google',
          vision: modelSupportsVision(id, 'google'),
          reasoning: modelSupportsReasoning(id, 'google'),
          created: 0,   // Google doesn't expose a created_at
        };
      });
  } catch (err) {
    console.warn('Google models fetch failed:', err.message);
    return [];
  }
}

// ---------- Pretty-print id → label fallbacks ----------

function prettifyClaude(id) {
  // claude-sonnet-4-5 → "Claude Sonnet 4.5"
  // claude-3-5-sonnet-20241022 → "Claude 3.5 Sonnet"
  return 'Claude ' + id
    .replace(/^claude-?/, '')
    .replace(/-(\d+)-(\d+)/g, '-$1.$2')
    .replace(/-\d{8}$/, '')   // strip date suffix
    .split('-')
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}
function prettifyOpenAI(id) {
  // gpt-5 → "GPT-5"; gpt-4.1 → "GPT-4.1"; gpt-5-mini → "GPT-5 mini"
  if (/^gpt-/i.test(id)) {
    const rest = id.replace(/^gpt-/i, '');
    return 'GPT-' + rest.replace(/-/g, ' ');
  }
  if (/^o\d/i.test(id)) return id.toUpperCase();
  return id;
}
function prettifyGrok(id) {
  // grok-4 → "Grok 4", grok-3-mini → "Grok 3 mini"
  return 'Grok ' + id.replace(/^grok-?/i, '').replace(/-/g, ' ');
}
function prettifyGemini(id) {
  // gemini-2.5-pro → "Gemini 2.5 Pro"
  return 'Gemini ' + id
    .replace(/^gemini-?/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------- Generation-score parser ----------
// Pulls a numeric "version" from a model ID so we can sort latest-
// first even when the provider doesn't expose a created_at timestamp
// (Google in particular always returns created=0). Higher score = newer.
//
//   claude-sonnet-4-5     → 4.5
//   claude-3-5-sonnet     → 3.5
//   gpt-5-mini            → 5.0
//   gpt-4.1               → 4.1
//   o3-mini               → 3.0  (o-series uses generation digit)
//   gemini-2.5-pro        → 2.5
//   gemini-1.5-flash      → 1.5
//   grok-4.3              → 4.3
//   grok-2-vision         → 2.0
//
// Returns 0 when no version can be extracted — safe fallback so the
// alphabetical comparator below kicks in for anything weird.
function genScore(id, provider) {
  const s = String(id || '').toLowerCase();
  if (provider === 'anthropic') {
    // Match "claude-<word>-N-M" or "claude-N-M-<word>" forms.
    let m = s.match(/claude-(?:sonnet|opus|haiku)-(\d+)(?:-(\d+))?/);
    if (m) return parseFloat(`${m[1]}.${m[2] || 0}`);
    m = s.match(/claude-(\d+)-(\d+)/);
    if (m) return parseFloat(`${m[1]}.${m[2]}`);
    return 0;
  }
  if (provider === 'openai') {
    // gpt-N or gpt-N.M, plus o-series (o1/o3/o4) which scores by digit.
    let m = s.match(/^gpt-(\d+(?:\.\d+)?)/);
    if (m) return parseFloat(m[1]);
    m = s.match(/^o(\d+)/);
    if (m) return parseFloat(m[1]);
    return 0;
  }
  if (provider === 'google') {
    const m = s.match(/^gemini-(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : 0;
  }
  if (provider === 'xai') {
    const m = s.match(/^grok-(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : 0;
  }
  return 0;
}

// ---------- Sort: provider → created-desc → genScore-desc → id ----------
// genScore is a critical tiebreaker for Google (created always 0) and
// useful for any provider whose timestamps lie. Highest version wins
// when timestamps tie or are missing.
function sortModels(models) {
  const order = { anthropic: 0, openai: 1, google: 2, xai: 3 };
  return models.sort((a, b) => {
    const op = (order[a.provider] ?? 9) - (order[b.provider] ?? 9);
    if (op !== 0) return op;
    if (a.created !== b.created) return b.created - a.created;
    const gs = genScore(b.id, b.provider) - genScore(a.id, a.provider);
    if (gs !== 0) return gs;
    return a.id.localeCompare(b.id);
  });
}

// ---------- Per-provider top-N filter ----------
// Keep the dropdown manageable by surfacing only the most relevant
// recent models per provider. We strip date-stamped snapshots and
// preview/experimental variants in favor of clean canonical aliases,
// then take the newest N. Currently 3 — easy knob if you want more.
const TOP_N_PER_PROVIDER = 3;

function isPreviewOrSnapshot(id, provider) {
  // Anthropic dated snapshot: claude-3-5-sonnet-20241022 — these are
  // duplicates of the canonical alias.
  if (/-\d{8}$/.test(id)) return true;
  // OpenAI dated snapshots like o1-2024-12-17 — duplicates of canonical.
  if (/-\d{4}-\d{2}-\d{2}$/.test(id)) return true;
  // Google version-suffixed snapshots like gemini-2.5-flash-001 —
  // duplicates of the canonical alias gemini-2.5-flash.
  if (/-\d{3}$/.test(id)) return true;
  // -preview tag handling. Google ships new generations (Gemini 3
  // family) under `*-preview` aliases for months before stable —
  // blocking ALL previews would hide Gemini 3 from users entirely.
  // Compromise: for Google, accept the bare canonical preview alias
  // (e.g. `gemini-3-pro-preview`) but reject dated snapshots
  // (`*-preview-05-06`) and specialty variants (`*-preview-tts`,
  // `*-preview-native-audio`). For non-Google providers, all -preview
  // remains filtered (those are usually short-lived test SKUs).
  if (/-preview\b/i.test(id)) {
    if (provider === 'google') {
      return /-preview-/.test(id);
    }
    return true;
  }
  if (/-exp\b|-experimental\b/i.test(id)) {
    // Same logic for -exp: allow for Google (the bare canonical),
    // block for everyone else.
    if (provider === 'google') return /-exp-/.test(id);
    return true;
  }
  if (/-vision\b/i.test(id)) return true;
  // OpenAI search-tool variants (gpt-4o-search-preview etc.) — keep
  // base models in the picker; search variants surface only when the
  // user enables web search on the chat header.
  if (/-search\b/i.test(id)) return true;
  return false;
}

function topNPerProvider(models, n = TOP_N_PER_PROVIDER) {
  const buckets = new Map();
  for (const m of models) {
    if (isPreviewOrSnapshot(m.id, m.provider)) continue;
    const arr = buckets.get(m.provider) || [];
    if (arr.length < n) arr.push(m);
    buckets.set(m.provider, arr);
  }
  // Re-flatten in original sorted order (provider order preserved by sortModels).
  const out = [];
  for (const m of models) {
    const bucket = buckets.get(m.provider) || [];
    if (bucket.includes(m)) out.push(m);
  }
  return out;
}

// ---------- Handler ----------

export default async (req) => {
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const userId = auth.user.id;
  const force = new URL(req.url).searchParams.get('refresh') === '1';

  // Resolve per-user BYOK keys (with server-env fallback). One
  // resolveProviderKey call per provider. If the user has stored their
  // own key, that wins; otherwise the server env key is used. If a
  // particular provider has neither, that provider contributes zero
  // models to the merged list — same behavior as before BYOK landed.
  const [aRes, oRes, gRes, xRes] = await Promise.all([
    resolveProviderKey({ userId, provider: 'anthropic' }),
    resolveProviderKey({ userId, provider: 'openai' }),
    resolveProviderKey({ userId, provider: 'google' }),
    resolveProviderKey({ userId, provider: 'xai' }),
  ]);
  const aKey = aRes.key, oKey = oRes.key, gKey = gRes.key, xKey = xRes.key;

  // Per-user cache key: list of (provider, source) fingerprints so a
  // user adding/removing their BYOK key automatically busts the cache
  // for that provider only. The fingerprint doesn't include the raw
  // key value — just whether it came from user storage vs server env.
  const cacheKey = `${userId}|${aRes.source}|${oRes.source}|${gRes.source}|${xRes.source}`;
  if (!force) {
    const hit = cacheGet(cacheKey);
    if (hit) {
      return json({ models: hit.models, cached_at: hit.ts, cache_age_ms: Date.now() - hit.ts });
    }
  }

  const [a, o, g, x] = await Promise.all([
    fetchAnthropicModels(aKey),
    fetchOpenAIModels(oKey),
    fetchGoogleModels(gKey),
    fetchXAIModels(xKey),
  ]);
  const sorted = sortModels([...a, ...o, ...g, ...x]);
  const models = topNPerProvider(sorted);
  cacheSet(cacheKey, models);
  return json({ models, cached_at: Date.now(), cache_age_ms: 0 });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
