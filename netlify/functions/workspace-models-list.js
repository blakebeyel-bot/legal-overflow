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

const CACHE_TTL_MS = 60 * 60 * 1000;   // 1 hour
let cache = null;                       // { models, ts }

const SERVER_KEY_ENV = {
  anthropic: ['LO_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'],
  openai:    ['LO_OPENAI_API_KEY',    'OPENAI_API_KEY'],
  google:    ['GOOGLE_AI_API_KEY'],
  xai:       ['XAI_API_KEY'],
};

function pickKey(provider) {
  for (const name of SERVER_KEY_ENV[provider] || []) {
    const v = process.env[name];
    if (!v) continue;
    if (provider === 'anthropic' && !v.startsWith('sk-ant-')) continue;
    if (provider === 'openai'    && !v.startsWith('sk-'))     continue;
    if (provider === 'google'    && !v.startsWith('AIza'))    continue;
    if (provider === 'xai'       && !v.startsWith('xai-'))    continue;
    return v;
  }
  return null;
}

// ---------- Provider model fetchers ----------
// Each returns [{ id, label, provider }] or [] on failure.

async function fetchAnthropicModels() {
  const key = pickKey('anthropic');
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
        created: m.created_at ? Date.parse(m.created_at) : 0,
      }));
  } catch (err) {
    console.warn('Anthropic models fetch failed:', err.message);
    return [];
  }
}

async function fetchOpenAIModels() {
  const key = pickKey('openai');
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
        created: (m.created || 0) * 1000,
      }));
  } catch (err) {
    console.warn('OpenAI models fetch failed:', err.message);
    return [];
  }
}

async function fetchXAIModels() {
  const key = pickKey('xai');
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
      .map((m) => ({
        id: m.id,
        label: prettifyGrok(m.id),
        provider: 'xai',
        created: (m.created || 0) * 1000,
      }));
  } catch (err) {
    console.warn('xAI models fetch failed:', err.message);
    return [];
  }
}

async function fetchGoogleModels() {
  const key = pickKey('google');
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
        // Skip embedding-only and image models
        if (/embedding|aqa|imagen/i.test(name)) return false;
        return true;
      })
      .map((m) => {
        const id = (m.name || '').replace(/^models\//, '');
        return {
          id,
          label: m.displayName || prettifyGemini(id),
          provider: 'google',
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

// ---------- Sort: provider → newest first → id ----------
function sortModels(models) {
  const order = { anthropic: 0, openai: 1, google: 2, xai: 3 };
  return models.sort((a, b) => {
    const op = (order[a.provider] ?? 9) - (order[b.provider] ?? 9);
    if (op !== 0) return op;
    if (a.created !== b.created) return b.created - a.created;
    return a.id.localeCompare(b.id);
  });
}

// ---------- Per-provider top-N filter ----------
// Keep the dropdown manageable by surfacing only the most relevant
// recent models per provider. We strip date-stamped snapshots and
// preview/experimental variants in favor of clean canonical aliases,
// then take the newest N. Currently 3 — easy knob if you want more.
const TOP_N_PER_PROVIDER = 3;

function isPreviewOrSnapshot(id) {
  // Anthropic dated snapshot: claude-3-5-sonnet-20241022 — these are
  // duplicates of the canonical alias.
  if (/-\d{8}$/.test(id)) return true;
  // OpenAI dated snapshots like o1-2024-12-17 — duplicates of canonical.
  if (/-\d{4}-\d{2}-\d{2}$/.test(id)) return true;
  // Preview/experimental tags. We keep -reasoning and -thinking
  // because the whole point of this site is legal reasoning.
  if (/-preview\b/i.test(id)) return true;
  if (/-exp\b|-experimental\b/i.test(id)) return true;
  if (/-vision\b/i.test(id)) return true;
  return false;
}

function topNPerProvider(models, n = TOP_N_PER_PROVIDER) {
  const buckets = new Map();
  for (const m of models) {
    if (isPreviewOrSnapshot(m.id)) continue;
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

  // Cache the merged list for one hour so we don't hammer provider
  // APIs on every page load. URL ?refresh=1 forces a refetch.
  const force = new URL(req.url).searchParams.get('refresh') === '1';
  const now = Date.now();
  if (!force && cache && now - cache.ts < CACHE_TTL_MS) {
    return json({ models: cache.models, cached_at: cache.ts, cache_age_ms: now - cache.ts });
  }

  const [a, o, g, x] = await Promise.all([
    fetchAnthropicModels(),
    fetchOpenAIModels(),
    fetchGoogleModels(),
    fetchXAIModels(),
  ]);
  const sorted = sortModels([...a, ...o, ...g, ...x]);
  const models = topNPerProvider(sorted);
  cache = { models, ts: now };
  return json({ models, cached_at: now, cache_age_ms: 0 });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
