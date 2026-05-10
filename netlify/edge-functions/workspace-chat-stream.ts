// Workspace chat — streaming via Netlify Edge Function (Deno).
//
// Edge Functions stream Web Response bodies natively without the
// chunk-batching that regular Netlify Functions can introduce, which
// gives the frontend smooth token-by-token updates.
//
// Path: registered in netlify.toml under [[edge_functions]] as
//   path = "/api/workspace-chat-stream"
//
// All Supabase / Anthropic / OpenAI / Google calls go through the
// public REST APIs — no Node-only libs are imported here. The Deno
// runtime ships fetch, TextDecoder, ReadableStream natively.

import type { Context } from 'https://edge.netlify.com/';

// Research-mode helpers (statutes / case law / LegiScan toggles).
// Plain ESM imports — Netlify bundles relative .js files into the
// edge function at deploy time.
import {
  findState,
  buildStatuteSystemBlock,
  buildAllowedDomains,
  STATE_TO_CL_COURTS,
  STATE_TO_FEDERAL_COURTS,
} from '../lib/state-statutes.js';
import { fetchStatuteRoot } from '../lib/statute-fetcher.js';
import {
  searchCourtListenerOpinions,
  buildCaseLawSystemBlock,
} from '../lib/courtlistener-search.js';
import {
  searchLegiscanBills,
  buildLegiscanSystemBlock,
} from '../lib/legiscan-client.js';
import { makeSupabaseREST } from '../lib/supabase-rest.js';
import { generateContextualBeats, FALLBACK_BEATS } from '../lib/beat-generator.js';
import { abstractContent } from '../lib/privacy-abstractor.js';

// Provider inferred from model id prefix. New models from any
// provider work without a code change as long as they follow the
// existing naming conventions.
function providerFromModel(id: string): 'anthropic' | 'openai' | 'google' | 'xai' | null {
  if (/^claude-/i.test(id)) return 'anthropic';
  if (/^(gpt-|o\d|chatgpt-)/i.test(id)) return 'openai';
  if (/^gemini-/i.test(id)) return 'google';
  if (/^grok-/i.test(id)) return 'xai';
  return null;
}

// Same pattern as Anthropic: Netlify's AI Gateway also auto-injects
// OPENAI_API_KEY with a JWT proxy token that fails 401 against
// api.openai.com directly. Read LO_OPENAI_API_KEY first; if absent,
// fall back to OPENAI_API_KEY only when it looks like a real OpenAI
// key (starts with sk-).
const SERVER_KEY_ENV: Record<string, string[]> = {
  anthropic: ['LO_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'],
  openai:    ['LO_OPENAI_API_KEY', 'OPENAI_API_KEY'],
  google:    ['GOOGLE_AI_API_KEY'],
  xai:       ['XAI_API_KEY'],
};

const SYSTEM_PROMPT = `You are a helpful AI legal research assistant for a U.S. attorney. The user is your professional peer.

Tone and format:
- Write in flowing conversational prose, the way a senior associate would explain something at the office. No corporate-memo voice.
- Do NOT use markdown headings (#, ##, ###) — ever. Don't use bullet lists or numbered lists unless the user explicitly asks for one. No tables.
- It is fine to use **bold** sparingly for a key term or rule name, and *italics* for case names.
- Be concise. No filler, no padding, no closing summary that just repeats what you already said.

Substance:
- Identify the governing rule, statute, or doctrine. Note the jurisdiction if it matters.
- Flag any open factual questions before opining.
- If you cite a case, statute, or rule, give the formal citation. If you do not have a verified citation, say so plainly and offer the underlying point in your own words. Never invent a citation.

Citation formatting:
- NEVER paste raw URLs into your prose. Long URLs look ugly and break readability.
- When you have a source URL, use markdown link syntax: \`[descriptive text](url)\` for inline links, OR footnote-style: \`[1](url)\`, \`[2](url)\` for source references after a sentence.
- When discussing a website by name, refer to it by hostname only ("at leg.state.fl.us" not "at https://www.leg.state.fl.us/statutes/index.cfm?...").
- Prefer footnote-style superscript references over inline mentions of URLs whenever possible — keep the prose clean.

You are not the user's lawyer and do not produce final-form legal advice. Treat the user as a peer who will independently verify what you give them.`;

// ----- Supabase helpers (REST, no client lib needed) -----

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

async function sbAuth(token: string) {
  const r = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SB_SERVICE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  return await r.json();
}

async function sbSelect(path: string) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SB_SERVICE_KEY,
      Authorization: `Bearer ${SB_SERVICE_KEY}`,
      Accept: 'application/json',
    },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return await r.json();
}

async function sbInsert(table: string, body: any) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?select=*`, {
    method: 'POST',
    headers: {
      apikey: SB_SERVICE_KEY,
      Authorization: `Bearer ${SB_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Supabase insert ${r.status}: ${await r.text()}`);
  const rows = await r.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

async function sbUpdate(table: string, filter: string, patch: any) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: {
      apikey: SB_SERVICE_KEY,
      Authorization: `Bearer ${SB_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`Supabase update ${r.status}: ${await r.text()}`);
}

// ----- BYOK key resolution (decrypt happens with WebCrypto) -----

async function decryptBYOK(b64: string): Promise<string | null> {
  const hex = Deno.env.get('BYOK_ENCRYPTION_KEY');
  if (!hex || hex.length !== 64) return null;
  const keyBytes = new Uint8Array(hex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  // WebCrypto AES-GCM expects ciphertext+tag concatenated.
  const ctWithTag = new Uint8Array(ct.length + tag.length);
  ctWithTag.set(ct, 0);
  ctWithTag.set(tag, ct.length);
  try {
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ctWithTag);
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

async function resolveProviderKey(userId: string, provider: string): Promise<{ key: string | null; source: string }> {
  // 1. user BYOK
  try {
    const rows = await sbSelect(`workspace_user_api_keys?user_id=eq.${userId}&provider=eq.${provider}&select=ciphertext`);
    console.log(`[chat-stream] BYOK lookup user=${userId} provider=${provider} found=${rows.length}`);
    if (rows[0]?.ciphertext) {
      const k = await decryptBYOK(rows[0].ciphertext);
      console.log(`[chat-stream] BYOK decrypt provider=${provider} success=${!!k} keyPrefix=${k?.slice(0, 6) || 'n/a'}`);
      if (k) return { key: k, source: 'user' };
    }
  } catch (err) {
    console.error(`[chat-stream] BYOK lookup error:`, err);
  }
  // 2. server fallback. Skip Netlify AI Gateway JWT proxies — they
  // fail 401 against the provider's API directly. Real keys have
  // recognizable prefixes (sk-ant-, sk-, AIza). Anything else is
  // likely a Gateway proxy token to skip.
  for (const name of SERVER_KEY_ENV[provider] || []) {
    const v = Deno.env.get(name);
    if (!v) continue;
    if (provider === 'anthropic' && !v.startsWith('sk-ant-')) continue;
    if (provider === 'openai'    && !v.startsWith('sk-'))     continue;
    if (provider === 'google'    && !v.startsWith('AIza'))    continue;
    if (provider === 'xai'       && !v.startsWith('xai-'))    continue;
    console.log(`[chat-stream] using server key for ${provider} from env=${name}`);
    return { key: v, source: 'server' };
  }
  console.warn(`[chat-stream] no key found for ${provider}`);
  return { key: null, source: 'none' };
}

// ----- Vault embedding (edge-runtime variant) -----
//
// The full embeddings library lives in netlify/lib/embeddings.js but
// uses Node's process.env via byok-keys.js, which doesn't load cleanly
// in the Deno edge runtime. We inline a single-text embed here that
// matches the same provider routing.

async function embedSingleForVault(provider: string, apiKey: string, text: string): Promise<number[] | null> {
  try {
    if (provider === 'gemini') {
      // gemini-embedding-001 (text-embedding-004's successor). Request
      // 768-dim output to match the workspace_vault_chunks.embedding_gemini
      // column.
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${encodeURIComponent(apiKey)}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'models/gemini-embedding-001',
          content: { parts: [{ text }] },
          outputDimensionality: 768,
        }),
      });
      if (!r.ok) return null;
      const j = await r.json();
      return j.embedding?.values || null;
    }
    if (provider === 'openai') {
      const r = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'text-embedding-3-small', input: [text] }),
      });
      if (!r.ok) return null;
      const j = await r.json();
      return j.data?.[0]?.embedding || null;
    }
    if (provider === 'voyage') {
      const r = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'voyage-3', input: [text], input_type: 'query' }),
      });
      if (!r.ok) return null;
      const j = await r.json();
      return j.data?.[0]?.embedding || null;
    }
  } catch (err) {
    console.warn('[chat-stream] vault embed failed:', (err as any)?.message);
  }
  return null;
}

// Resolve the embedding-API key for a user. Mirrors the BYOK ladder:
// user's own key first (via the existing resolveProviderKey lookup),
// then a server env fallback (Deno.env.get).
async function resolveVaultEmbedKey(userId: string, vaultProvider: string): Promise<string | null> {
  const byokSlot = vaultProvider === 'gemini' ? 'google'
                  : vaultProvider === 'openai' ? 'openai'
                  : null;
  if (byokSlot) {
    const { key } = await resolveProviderKey(userId, byokSlot);
    if (key) return key;
  }
  if (vaultProvider === 'voyage') {
    return Deno.env.get('VOYAGE_API_KEY') || null;
  }
  return null;
}

// ----- Streaming generators (provider-specific, all yield {type, delta}) -----

async function* parseSSE(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  // Find the next event terminator. SSE allows either "\n\n" or
  // "\r\n\r\n"; some servers (Google's streamGenerateContent among
  // them) actually send single-newline-separated records that lack
  // the proper double-newline terminator entirely. We accept any of
  // these so we don't lose events.
  const findTerminator = (s: string): { idx: number; len: number } | null => {
    const a = s.indexOf('\r\n\r\n');
    const b = s.indexOf('\n\n');
    if (a !== -1 && (b === -1 || a < b)) return { idx: a, len: 4 };
    if (b !== -1) return { idx: b, len: 2 };
    return null;
  };
  const emitRecord = function* (rec: string): Generator<{ event: string; data: string }> {
    let event = 'message';
    let data = '';
    for (const rawLine of rec.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trimStart();
    }
    if (data) yield { event, data };
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let term = findTerminator(buf);
      while (term) {
        const rec = buf.slice(0, term.idx);
        buf = buf.slice(term.idx + term.len);
        for (const ev of emitRecord(rec)) yield ev;
        term = findTerminator(buf);
      }
    }
    // Flush any final partial record (servers that don't send the
    // closing terminator).
    if (buf.trim().length > 0) {
      for (const ev of emitRecord(buf)) yield ev;
    }
  } finally {
    reader.releaseLock();
  }
}

async function* streamAnthropic(opts: { key: string; model: string; system: string; messages: any[]; webSearch?: { enabled: boolean; allowedDomains?: string[] }; deepThink?: boolean }) {
  const body: any = {
    model: opts.model,
    system: opts.system,
    messages: opts.messages,
    max_tokens: opts.deepThink ? 16000 : 4096,   // bump output budget when thinking is enabled
    temperature: 0.4,
    stream: true,
  };
  // Anthropic extended thinking — Claude 3.7+ and Claude 4+ support
  // a private scratchpad before the visible answer. budget_tokens
  // governs how much the model reasons; 10k is a good middle ground
  // (stronger than default, doesn't blow latency through the roof).
  // When deep-think is off, we send no thinking field so the model
  // uses its standard fast-response mode.
  if (opts.deepThink) {
    body.thinking = { type: 'enabled', budget_tokens: 10_000 };
    // Extended thinking REQUIRES temperature=1 per Anthropic's API.
    body.temperature = 1;
  }
  // Anthropic's server-side web_search tool. When enabled, the model
  // can issue searches on its own; results stream back as
  // server_tool_use + web_search_tool_result content blocks. We
  // intercept those to emit live status events to the user, so the
  // indicator keeps updating ("Searching the web…", "Reading
  // results…") instead of stalling on "Reasoning over sources".
  if (opts.webSearch?.enabled) {
    body.tools = [{
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 8,
      ...(opts.webSearch.allowedDomains?.length
        ? { allowed_domains: opts.webSearch.allowedDomains }
        : {}),
    }];
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': opts.key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 400)}`);
  // Track in-progress tool blocks so we can decode the search query
  // from streamed input_json_delta chunks. A `server_tool_use` block
  // emits its `input` field as a JSON-fragment stream; we accumulate
  // until content_block_stop and then parse to grab `query`.
  let activeToolBlock: { type: 'server_tool_use' | 'web_search_tool_result'; index: number; jsonAcc: string; resultCount?: number } | null = null;
  for await (const ev of parseSSE(res.body!)) {
    if (!ev.data) continue;
    let d: any;
    try { d = JSON.parse(ev.data); } catch { continue; }
    // ---- Web-search tool lifecycle ----
    if (d.type === 'content_block_start' && d.content_block?.type === 'server_tool_use' && d.content_block?.name === 'web_search') {
      activeToolBlock = { type: 'server_tool_use', index: d.index, jsonAcc: '' };
      // Generic "starting" message; will be replaced when we parse
      // out the actual query below.
      yield { type: 'status', message: 'Searching the web for relevant authority…' };
      continue;
    }
    if (d.type === 'content_block_start' && d.content_block?.type === 'web_search_tool_result') {
      // The actual content is in d.content_block.content (an array of
      // results). Surface a count if available.
      const results = Array.isArray(d.content_block?.content) ? d.content_block.content : [];
      activeToolBlock = { type: 'web_search_tool_result', index: d.index, jsonAcc: '', resultCount: results.length };
      yield {
        type: 'status',
        message: results.length
          ? `Reading ${results.length} search result${results.length === 1 ? '' : 's'}…`
          : 'Reading search results…',
      };
      continue;
    }
    if (d.type === 'content_block_delta' && d.delta?.type === 'input_json_delta' && activeToolBlock?.type === 'server_tool_use') {
      activeToolBlock.jsonAcc += d.delta.partial_json || '';
      continue;
    }
    if (d.type === 'content_block_stop' && activeToolBlock && d.index === activeToolBlock.index) {
      // Tool input is complete — try to parse the JSON to extract
      // the query so we can show "Searching for: <query>" instead of
      // a generic message.
      if (activeToolBlock.type === 'server_tool_use' && activeToolBlock.jsonAcc) {
        try {
          const input = JSON.parse(activeToolBlock.jsonAcc);
          if (input?.query) {
            const q = String(input.query).slice(0, 80);
            yield { type: 'status', message: `Searching for "${q}"…` };
          }
        } catch { /* non-JSON or partial — ignore */ }
      }
      activeToolBlock = null;
      continue;
    }
    if (d.type === 'content_block_delta' && d.delta?.type === 'text_delta') {
      yield { type: 'text', delta: d.delta.text };
    }
  }
}

// True when the OpenAI model ID requires the Responses API
// (/v1/responses) instead of Chat Completions (/v1/chat/completions).
// OpenAI returns 404 "this is not a chat model" on Chat Completions
// for o1/o3/o4 reasoning models and the GPT-5 Pro / heavy variants.
// Pattern: o-series and any gpt-5 with "pro" or "reasoning" in name.
// Plain gpt-5 / gpt-5-mini still work on Chat Completions today.
function openaiNeedsResponsesApi(model: string): boolean {
  const s = (model || '').toLowerCase();
  if (/^o[1-9]/.test(s)) return true;
  if (/^gpt-5.*-pro\b/.test(s)) return true;
  if (/^gpt-5.*-reasoning\b/.test(s)) return true;
  if (/^gpt-5\.5/.test(s)) return true;          // gpt-5.5 family
  return false;
}

async function* streamOpenAI(opts: { key: string; model: string; system: string; messages: any[]; webSearch?: { enabled: boolean; allowedDomains?: string[] }; deepThink?: boolean }) {
  // Route newer reasoning-heavy models to the Responses API; older
  // gpt-4* / gpt-5 base / gpt-5-mini stay on Chat Completions.
  if (openaiNeedsResponsesApi(opts.model)) {
    yield* streamOpenAIResponses(opts);
    return;
  }
  const msgs: any[] = [];
  if (opts.system) msgs.push({ role: 'system', content: opts.system });
  msgs.push(...opts.messages);
  // GPT-5 era models require max_completion_tokens; older models accept
  // max_tokens. Use the new name for everything modern; OpenAI accepts
  // it for older models too as a graceful fallback.
  //
  // reasoning_effort applies to o1/o3/o4 and GPT-5 reasoning models.
  // When deep-think is on we set 'high'; otherwise omit so the API
  // uses its default ('medium' for reasoning models, n/a for non).
  const body: any = {
    model: opts.model,
    messages: msgs,
    max_completion_tokens: opts.deepThink ? 16000 : 4096,
    stream: true,
  };
  if (opts.deepThink) {
    body.reasoning_effort = 'high';
  }
  // OpenAI Chat Completions web search is model-specific. Only attach
  // the tool for models that explicitly support it (gpt-4o-search-*,
  // gpt-5-search-*, etc.). For non-search models the system prompt
  // still nudges toward authoritative sources.
  if (opts.webSearch?.enabled && /(-search-|search-preview|gpt-4o-search|gpt-5-search)/i.test(opts.model)) {
    body.tools = [{ type: 'web_search_preview' }];
  }
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 400)}`);
  for await (const ev of parseSSE(res.body!)) {
    if (!ev.data || ev.data === '[DONE]') continue;
    let d: any;
    try { d = JSON.parse(ev.data); } catch { continue; }
    const t = d.choices?.[0]?.delta?.content;
    if (t) yield { delta: t };
  }
}

// OpenAI Responses API — required for o1/o3/o4 reasoning models and
// gpt-5 reasoning-heavy variants (Pro, Reasoning, 5.5). Same shape
// as xAI's Responses path: instructions for system, input array of
// {role, content}, content blocks use input_text / input_image.
//
// CRITICAL: when an upstream caller has rewritten the user message
// to OpenAI Chat Completions image format ({type: 'image_url',
// image_url: {url}}), we re-shape it here to Responses format
// ({type: 'input_image', image_url: '<url-string>'}). The chat
// pipeline doesn't know in advance which OpenAI endpoint will be
// used — it builds Chat Completions blocks and we adapt here.
async function* streamOpenAIResponses(opts: { key: string; model: string; system: string; messages: any[]; webSearch?: { enabled: boolean; allowedDomains?: string[] }; deepThink?: boolean }) {
  const input = opts.messages.map((m: any) => {
    if (Array.isArray(m.content)) {
      // Adapt Chat Completions content blocks → Responses blocks
      const parts = m.content.map((b: any) => {
        if (b?.type === 'text')  return { type: 'input_text',  text: b.text || '' };
        if (b?.type === 'image_url') {
          const url = typeof b.image_url === 'string' ? b.image_url : (b.image_url?.url || '');
          return { type: 'input_image', image_url: url, detail: 'high' };
        }
        // input_* blocks pass through unchanged (already correct shape)
        if (b?.type === 'input_text' || b?.type === 'input_image') return b;
        return { type: 'input_text', text: String(b?.text || '') };
      });
      return { role: m.role, content: parts };
    }
    // Plain string content stays a string
    return { role: m.role, content: m.content };
  });
  const body: any = {
    model: opts.model,
    instructions: opts.system,
    input,
    max_output_tokens: opts.deepThink ? 16000 : 4096,
    stream: true,
  };
  if (opts.webSearch?.enabled) {
    body.tools = [{ type: 'web_search' }];
  }
  if (opts.deepThink) {
    body.reasoning = { effort: 'high' };
  }
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OpenAI Responses ${res.status}: ${(await res.text()).slice(0, 400)}`);
  for await (const ev of parseSSE(res.body!)) {
    if (!ev.data || ev.data === '[DONE]') continue;
    let d: any;
    try { d = JSON.parse(ev.data); } catch { continue; }
    if (d.type === 'response.web_search_call.in_progress' || d.type === 'response.web_search_call.searching') {
      yield { type: 'status', message: 'Searching the web for relevant authority…' };
      continue;
    }
    if (d.type === 'response.web_search_call.completed') {
      yield { type: 'status', message: 'Reading search results…' };
      continue;
    }
    if (d.type === 'response.output_text.delta' && typeof d.delta === 'string') {
      yield { type: 'text', delta: d.delta };
    }
  }
}

async function* streamXAI(opts: { key: string; model: string; system: string; messages: any[]; webSearch?: { enabled: boolean; allowedDomains?: string[] }; deepThink?: boolean }) {
  // xAI's Responses API (/v1/responses) — replaces the deprecated
  // Live Search on /v1/chat/completions. Mirrors OpenAI's Responses
  // shape closely:
  //   - `instructions` carries the system prompt
  //   - `input` is an array of {role, content} turns (or a string)
  //   - `tools: [{ type: 'web_search' }]` opts into the built-in
  //     web search tool. Note: any `search_parameters` field on
  //     this endpoint is rejected with a 410 ("Live search is
  //     deprecated"). Domain filtering for Grok falls back to the
  //     system prompt's authoritative-source instructions.
  //   - Streaming events are OpenAI-style: response.output_text.delta
  //     carries the user-visible text deltas; other events (web search
  //     in_progress / completed, reasoning, output_item lifecycle) are
  //     silently consumed.
  const input = opts.messages.map((m: any) => ({
    role: m.role,
    content: m.content,
  }));
  const body: any = {
    model: opts.model,
    instructions: opts.system,
    input,
    max_output_tokens: opts.deepThink ? 16000 : 4096,
    temperature: 0.4,
    stream: true,
  };
  if (opts.webSearch?.enabled) {
    body.tools = [{ type: 'web_search' }];
  }
  // xAI Responses API exposes reasoning effort via a `reasoning`
  // object, mirroring OpenAI's Responses API. high = max scratchpad,
  // medium = default, low = quick. Omitted entirely when deep-think
  // is off so non-reasoning Grok variants don't get a payload they
  // don't understand.
  //
  // CRITICAL: Grok "*-reasoning" SKUs (e.g. grok-4.20-0309-reasoning,
  // grok-4-fast-reasoning) are dedicated reasoning models that
  // ALWAYS reason at max effort. They REJECT the explicit
  // reasoning_effort parameter with a 400. Skip the param for them;
  // they're already doing what deep-think requests.
  if (opts.deepThink && !/-reasoning(?:-|$)/.test(opts.model)) {
    body.reasoning = { effort: 'high' };
  }
  const res = await fetch('https://api.x.ai/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`xAI ${res.status}: ${(await res.text()).slice(0, 400)}`);
  for await (const ev of parseSSE(res.body!)) {
    if (!ev.data || ev.data === '[DONE]') continue;
    let d: any;
    try { d = JSON.parse(ev.data); } catch { continue; }
    // Surface live web-search activity as status events so the
    // phase indicator stays current during the LLM's reasoning.
    if (d.type === 'response.web_search_call.in_progress' || d.type === 'response.web_search_call.searching') {
      yield { type: 'status', message: 'Searching the web for relevant authority…' };
      continue;
    }
    if (d.type === 'response.web_search_call.completed') {
      yield { type: 'status', message: 'Reading search results…' };
      continue;
    }
    // User-visible text delta.
    if (d.type === 'response.output_text.delta' && typeof d.delta === 'string') {
      yield { type: 'text', delta: d.delta };
    }
  }
}

async function* streamGoogle(opts: { key: string; model: string; system: string; messages: any[]; webSearch?: { enabled: boolean; allowedDomains?: string[] }; deepThink?: boolean }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(opts.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(opts.key)}`;
  console.log(`[chat-stream] Google URL: ${url.replace(opts.key, '<REDACTED>')}`);
  const contents = opts.messages.map((m: any) => {
    // Google's parts[] format mixes text + inline_data (images)
    // freely. When the upstream chat-stream attached `images` to a
    // user message (vision-capable Gemini models), expand them into
    // inline_data parts alongside the text.
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts: any[] = [];
    if (Array.isArray(m.images) && m.images.length) {
      for (const img of m.images) {
        parts.push({ inline_data: { mime_type: img.mimeType, data: img.data } });
      }
    }
    parts.push({ text: typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map((c: any) => c.text || '').filter(Boolean).join('\n') : '') });
    return { role, parts };
  });
  const body: any = {
    contents,
    generationConfig: {
      maxOutputTokens: opts.deepThink ? 16000 : 4096,
      temperature: 0.4,
      // Gemini 2.5+ thinkingConfig — the model spends extra tokens
      // reasoning before producing visible text. thinkingBudget=10k
      // gives a strong scratchpad without absurd latency. Field is
      // ignored by older Gemini versions, so it's safe even if
      // detectReasoning misclassifies (additive only).
      ...(opts.deepThink ? { thinkingConfig: { thinkingBudget: 10_000 } } : {}),
    },
    // Google Search grounding. No domain restriction available; the
    // system prompt's domain preferences carry the constraint.
    ...(opts.webSearch?.enabled ? { tools: [{ google_search: {} }] } : {}),
    // Disable Gemini's default safety filters as fully as the API
    // allows. Their filters block legitimate legal content (case
    // discussions, criminal procedure questions, regulatory work)
    // and return empty bodies instead of explanatory errors. The
    // user is a licensed attorney; Claude/OpenAI handle this fine
    // with default filters, Gemini does not.
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_CIVIC_INTEGRITY',   threshold: 'BLOCK_NONE' },
    ],
  };
  if (opts.system) body.systemInstruction = { role: 'user', parts: [{ text: opts.system }] };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  console.log(`[chat-stream] Google HTTP ${res.status} content-type=${res.headers.get('content-type')}`);
  if (!res.ok) throw new Error(`Google ${res.status}: ${(await res.text()).slice(0, 400)}`);
  let yielded = 0;
  let lastFinish: string | null = null;
  let lastBlock: string | null = null;
  for await (const ev of parseSSE(res.body!)) {
    if (!ev.data) continue;
    let d: any;
    try { d = JSON.parse(ev.data); } catch { continue; }
    const cand = d.candidates?.[0];
    if (cand?.finishReason) lastFinish = cand.finishReason;
    if (d.promptFeedback?.blockReason) lastBlock = d.promptFeedback.blockReason;
    const parts = cand?.content?.parts || [];
    for (const p of parts) if (p.text) { yielded += p.text.length; yield { delta: p.text }; }
  }
  if (yielded === 0) {
    console.error(`[chat-stream] Gemini empty response. finishReason=${lastFinish} blockReason=${lastBlock} model=${opts.model}`);
    // Surface a clear reason instead of silently returning empty.
    const reason = lastBlock
      ? `Gemini blocked the prompt (${lastBlock}). Try rephrasing.`
      : lastFinish && lastFinish !== 'STOP'
        ? `Gemini stopped early (reason: ${lastFinish}). This is often a safety filter on legal content. Try rephrasing or switch to Claude.`
        : 'Gemini returned empty content. This is usually a safety filter on legal queries. Try rephrasing or switch to Claude.';
    throw new Error(reason);
  }
}

// ----- Title generation (small non-streaming call) -----

async function generateTitle(provider: string, key: string, model: string, userMsg: string, asstReply: string): Promise<string | null> {
  const prompt = `Summarize this exchange as a title of 3-7 words. No quotes, no period.\n\nUSER: ${userMsg.slice(0, 500)}\nASSISTANT: ${asstReply.slice(0, 800)}\n\nTitle:`;
  try {
    if (provider === 'anthropic') {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 30, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!r.ok) return null;
      const j = await r.json();
      const text = j.content?.[0]?.text || '';
      return cleanTitle(text);
    } else if (provider === 'openai') {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, max_completion_tokens: 30, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!r.ok) return null;
      const j = await r.json();
      return cleanTitle(j.choices?.[0]?.message?.content || '');
    } else if (provider === 'xai') {
      const r = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, max_tokens: 30, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!r.ok) return null;
      const j = await r.json();
      return cleanTitle(j.choices?.[0]?.message?.content || '');
    } else {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 30 } }),
      });
      if (!r.ok) return null;
      const j = await r.json();
      return cleanTitle(j.candidates?.[0]?.content?.parts?.[0]?.text || '');
    }
  } catch {
    return null;
  }
}

function cleanTitle(s: string): string | null {
  const cleaned = (s || '').trim().replace(/^["']|["']$/g, '').replace(/\.$/, '').slice(0, 100);
  return cleaned || null;
}

// ----- Main handler -----

export default async (req: Request, _ctx: Context): Promise<Response> => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });

  // Auth
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Missing Authorization header' }, 401);
  const token = authHeader.slice(7);
  const user = await sbAuth(token);
  if (!user?.id) return json({ error: 'Invalid or expired session' }, 401);

  // Approval check
  const profileRows = await sbSelect(`profiles?id=eq.${user.id}&select=approved_at`);
  if (!profileRows[0]?.approved_at) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  // Body
  const body = await req.json().catch(() => ({}));
  const chatId = body.chat_id;
  const content = String(body.content || '').trim();
  const requestedModel = body.model;
  const attachmentIds: string[] = Array.isArray(body.attachments) ? body.attachments.filter((x: any) => typeof x === 'string') : [];
  // Deep-think toggle — when true AND the selected model supports
  // extended reasoning, we pass the provider's reasoning-effort knob
  // set high. Models that don't support reasoning silently ignore it
  // (we omit the param in their respective stream functions).
  const deepThink: boolean = body.deep_think === true;
  // Research-mode toggles — { statutes_enabled, case_law_enabled,
  // legiscan_enabled, state }. All optional; default to off.
  const lawSettingsRaw = body.law_settings && typeof body.law_settings === 'object' ? body.law_settings : {};
  if (!chatId) return json({ error: 'Missing chat_id' }, 400);
  // Allow an empty message body WHEN at least one attachment is
  // present — user can drop a file and hit send with no typed text.
  // The model still has the attachment context to react to.
  if (!content && attachmentIds.length === 0) return json({ error: 'Empty message' }, 400);
  if (content.length > 50_000) return json({ error: 'Message too long' }, 400);

  // Verify chat ownership; also pull anchored_item_ids so the vault
  // retrieval below can guarantee chunks + images from pinned docs.
  const chats = await sbSelect(`workspace_chats?id=eq.${chatId}&user_id=eq.${user.id}&select=id,title,model,workflow_id,law_settings,anchored_item_ids`);
  const chat = chats[0];
  if (!chat) return json({ error: 'Chat not found' }, 404);

  // Resolve law_settings — incoming body wins over the persisted row.
  const persistedLaw = (chat.law_settings && typeof chat.law_settings === 'object') ? chat.law_settings : {};
  const lawSrc = Object.keys(lawSettingsRaw).length ? lawSettingsRaw : persistedLaw;
  const stateMeta = findState(lawSrc.state);
  // New six-toggle shape. Backward-compat: legacy boolean fields
  // (statutes_enabled / case_law_enabled / legiscan_enabled) map
  // to BOTH state + federal of the same kind so older chats keep
  // their previous behavior.
  const legacyStat = lawSrc.statutes_enabled !== undefined ? !!lawSrc.statutes_enabled : false;
  const legacyCase = lawSrc.case_law_enabled !== undefined ? !!lawSrc.case_law_enabled : false;
  const legacyBill = lawSrc.legiscan_enabled !== undefined ? !!lawSrc.legiscan_enabled : false;
  const lawSettings = {
    state: stateMeta ? stateMeta.code : 'FL',
    state_statutes_enabled:   lawSrc.state_statutes_enabled   !== undefined ? !!lawSrc.state_statutes_enabled   : legacyStat,
    federal_statutes_enabled: lawSrc.federal_statutes_enabled !== undefined ? !!lawSrc.federal_statutes_enabled : legacyStat,
    state_caselaw_enabled:    lawSrc.state_caselaw_enabled    !== undefined ? !!lawSrc.state_caselaw_enabled    : legacyCase,
    federal_caselaw_enabled:  lawSrc.federal_caselaw_enabled  !== undefined ? !!lawSrc.federal_caselaw_enabled  : legacyCase,
    state_bills_enabled:      lawSrc.state_bills_enabled      !== undefined ? !!lawSrc.state_bills_enabled      : legacyBill,
    federal_bills_enabled:    lawSrc.federal_bills_enabled    !== undefined ? !!lawSrc.federal_bills_enabled    : legacyBill,
    privacy_enabled:          !!lawSrc.privacy_enabled,
    // null = defer to user-level vault_auto_use_in_chats. true/false
    // = explicit per-chat override.
    vault_enabled: typeof lawSrc.vault_enabled === 'boolean' ? lawSrc.vault_enabled : null,
  };
  const privacyEnabled = lawSettings.privacy_enabled;
  const anyToggleOn =
    lawSettings.state_statutes_enabled || lawSettings.federal_statutes_enabled ||
    lawSettings.state_caselaw_enabled  || lawSettings.federal_caselaw_enabled  ||
    lawSettings.state_bills_enabled    || lawSettings.federal_bills_enabled;

  // Resolve vault use for this chat. The chat's per-chat flag wins;
  // null defers to the user's global vault_auto_use_in_chats setting.
  let vaultEnabled = false;
  try {
    const settingsRows = await sbSelect(
      `workspace_user_settings?user_id=eq.${user.id}&select=vault_auto_use_in_chats`,
    );
    const userVaultDefault = settingsRows.length > 0
      ? !!settingsRows[0].vault_auto_use_in_chats
      : true;
    vaultEnabled = lawSettings.vault_enabled === null
      ? userVaultDefault
      : !!lawSettings.vault_enabled;
  } catch (err) {
    console.warn('[chat-stream] vault settings lookup failed:', (err as any)?.message);
    vaultEnabled = lawSettings.vault_enabled !== false;   // fail-open to default-on
  }
  // Persist the resolved settings on the chat row (idempotent —
  // every send updates so the chat remembers the latest).
  if (Object.keys(lawSettingsRaw).length) {
    sbUpdate('workspace_chats', `id=eq.${chatId}`, { law_settings: lawSettings }).catch(() => {});
  }

  // If the chat is bound to a workflow, fetch its prompt_md and use
  // it as the system prompt instead of the default. The workflow must
  // be visible to this user (own or system+published).
  let workflowSystemPrompt: string | null = null;
  if (chat.workflow_id) {
    try {
      const wfRows = await sbSelect(`workspace_workflows?id=eq.${chat.workflow_id}&or=(user_id.eq.${user.id},and(user_id.is.null,is_published.eq.true))&select=prompt_md,kind,is_prompt_pack`);
      const wf = wfRows[0];
      if (wf?.kind === 'chat' && wf.prompt_md) {
        // For homepage-imported prompt packs, wrap the raw pack
        // content with a conversational instruction. Without this,
        // the model sees a multi-step methodology in its system
        // prompt and dumps the entire final deliverable in one
        // response — the user can't follow along or correct
        // course. The wrapper instructs the model to walk through
        // the methodology step by step, conversationally.
        // User-created workflows skip the wrapper — those authors
        // wrote the prompt assuming direct execution.
        if (wf.is_prompt_pack) {
          workflowSystemPrompt = `You are guiding the user through a piece of legal work as a back-and-forth conversation. You have a methodology (below) that you follow internally, but the user should NEVER see the seams of that methodology. Talk like a colleague who happens to know what to do next, not a script reading itself out loud.

CONVERSATION STYLE — ABSOLUTE RULES:

1. NEVER reference the methodology's internal structure in user-facing text. Don't say "Prompt 5", "Step 3", "Phase 2", "the next step in the workflow", "per the methodology", "let's run X next", etc. The user does not know there's a script.

2. Talk naturally. "Want me to look at the liability cap next?" — yes. "Would you like me to run Prompt 5 (limitation-of-liability deep-read) next?" — no, that's robotic.

3. Acknowledge briefly what the user just shared, then move forward — don't recap or summarize what they said back to them in formal language.

4. Take ONE step forward per turn — the smallest concrete unit of progress that produces something the user can react to (a finding, an observation, a question, a draft suggestion).

5. Ask a focused clarifying question whenever something is ambiguous or a real decision-point appears. Don't ask permission for every step — only when there's a genuine choice the user should make.

6. Show your work as you go — quote the relevant clause or fact you're operating on so the user can follow along. Use light formatting (a quoted sentence, a short list) but no heavy headings or numbered playbooks.

7. Use first-person plural sparingly ("we", "let's") and second-person freely ("you"). Avoid stilted hedges like "I would suggest that we consider..." — just say "I'd push back on..." or "Worth flagging that..."

8. When you've gathered all the inputs the methodology needs, produce the final deliverable in one clear response and offer to refine specific parts.

9. If the user explicitly says "just give me the final output" or similar, you may produce it directly — but otherwise default to the conversational mode.

You're a sharp colleague working through this with them. Not a chatbot. Not a tutorial. Not a script.

YOUR METHODOLOGY (the user does NOT see this — internal-only guide for what to cover):
====================
${wf.prompt_md}
====================`;
        } else {
          workflowSystemPrompt = wf.prompt_md;
        }
      }
    } catch (err) {
      console.error('[chat-stream] workflow lookup failed:', err);
    }
  }

  // Resolve model. Provider is inferred from the id prefix so any new
  // model the providers ship works without a code change.
  const modelId = requestedModel || chat.model || 'claude-sonnet-4-5';
  const provider = providerFromModel(modelId);
  if (!provider) return json({ error: `Unknown model: ${modelId}` }, 400);

  const { key, source } = await resolveProviderKey(user.id, provider);
  if (!key) return json({ error: `No API key for ${provider}. Add yours in /account/.` }, 400);

  // ---- Resolve attached library documents ----
  // For each attachment id we look up the current_version's
  // extracted_text and inline it as system context. Cap each doc at
  // 200k chars so a single huge upload can't blow up the context
  // window. The extraction was done at upload time so this is just a
  // quick DB read.
  // When Privacy mode is on, every doc's extracted_text gets passed
  // through the abstractor before being inlined; if abstraction
  // fails we abort the whole request rather than leak raw content.
  let attachmentContext = '';
  const attachmentMeta: { id: string; filename: string; chars: number }[] = [];
  // Hold raw doc texts so we can abstract them in batch after the
  // loop, then build attachmentContext from the abstracted versions.
  const rawDocs: { id: string; filename: string; text: string }[] = [];
  if (attachmentIds.length > 0) {
    try {
      // Get the docs (filtered to user-owned). PostgREST `in.()`
      // wants UUIDs UNQUOTED — quoted form sometimes silently
      // returns empty result, which would make the attachment
      // chip render but the model never see the doc text.
      const idList = attachmentIds.join(',');
      const docs = await sbSelect(`workspace_documents?id=in.(${idList})&user_id=eq.${user.id}&deleted_at=is.null&select=id,filename,current_version_id`);
      console.log(`[chat-stream] attachment lookup: ${attachmentIds.length} requested, ${(docs as any[])?.length || 0} resolved`);
      for (const d of docs as any[]) {
        if (!d.current_version_id) continue;
        const versions = await sbSelect(`workspace_document_versions?id=eq.${d.current_version_id}&select=extracted_text,extraction_status`);
        const v = versions[0];
        if (!v?.extracted_text) {
          attachmentMeta.push({ id: d.id, filename: d.filename, chars: 0 });
          continue;
        }
        const PER_DOC_CAP = 200_000;
        let text = v.extracted_text;
        if (text.length > PER_DOC_CAP) text = text.slice(0, PER_DOC_CAP) + '\n[...truncated]';
        attachmentMeta.push({ id: d.id, filename: d.filename, chars: text.length });
        rawDocs.push({ id: d.id, filename: d.filename, text });
      }
    } catch (err) {
      console.error('[chat-stream] attachment resolve failed:', err);
    }
  }

  // ---- Privacy mode abstraction (fail-closed) ----
  // When Privacy mode is on, the user's raw message and each
  // attached doc's extracted_text are rewritten as abstract
  // hypotheticals before any of it is persisted or sent to the
  // main LLM. Abstraction uses the same provider+model the user
  // selected (so the raw text only crosses to one provider).
  // If abstraction fails for ANY input, we abort the request
  // entirely with an error — the original raw text never makes it
  // to storage or to the LLM.
  let privacyContent = content;
  let privacyAbstractedDocCount = 0;
  if (privacyEnabled) {
    console.log(`[chat-stream] privacy ON — abstracting message (${content.length} chars) + ${rawDocs.length} doc(s)`);
    try {
      // Abstract the user's typed message
      privacyContent = await abstractContent({
        text: content, provider, model: modelId, apiKey: key,
      });
      console.log(`[chat-stream] privacy: msg abstracted ${content.length} → ${privacyContent.length} chars`);
      // Abstract each attached doc's text in parallel
      if (rawDocs.length) {
        const abstractedTexts = await Promise.all(
          rawDocs.map((d) => abstractContent({
            text: d.text, provider, model: modelId, apiKey: key,
          })),
        );
        for (let i = 0; i < rawDocs.length; i++) {
          console.log(`[chat-stream] privacy: doc "${rawDocs[i].filename}" abstracted ${rawDocs[i].text.length} → ${abstractedTexts[i].length} chars`);
          rawDocs[i].text = abstractedTexts[i];
          privacyAbstractedDocCount++;
        }
      }
    } catch (err) {
      // Don't leak abstractor-LLM error details to the browser — the
      // upstream provider's error body can contain key fragments,
      // request IDs, or model-internal hints. Log full error server-
      // side; send a generic actionable message to the client.
      console.error('[chat-stream] privacy abstractor failed:', err);
      return json({
        error: 'Privacy mode could not abstract your message or attachments. Try again, or disable Privacy mode in the toolbar if you need to send this content verbatim.',
        privacy_failed: true,
      }, 502);
    }
  }

  // Build attachment context from the (now abstracted, when applicable) docs.
  // Privacy mode: mask the filename too. Filenames often contain client
  // names, case captions, or matter numbers (e.g., "Smith_v_Jones_2024.docx",
  // "Acme_MSA_v3.docx"). Replace with a neutral "Document N" label so the
  // LLM never sees the original filename.
  rawDocs.forEach((d, i) => {
    const labelForLLM = privacyEnabled ? `Document ${String.fromCharCode(65 + i)}` : d.filename;
    attachmentContext += `\n\n=== ATTACHED DOCUMENT: ${labelForLLM} ===\n\n${d.text}\n\n=== END OF ${labelForLLM} ===\n`;
  });

  // Persist user message + create assistant placeholder.
  // CRITICAL: when Privacy mode is on, we store the ABSTRACTED
  // content, never the original. The original is held in memory
  // only as long as this request runs; nothing else writes it
  // anywhere. This is the heart of the privacy guarantee.
  const userMsgRow = await sbInsert('workspace_chat_messages', {
    chat_id: chatId, role: 'user',
    content: privacyContent,           // <-- abstracted when privacy is on
    status: 'complete',
    attachments: attachmentMeta,
    privacy_applied: privacyEnabled,
  });

  // Load history (excluding the just-inserted user msg, we'll add it explicitly)
  const histRows = await sbSelect(`workspace_chat_messages?chat_id=eq.${chatId}&id=neq.${userMsgRow.id}&status=eq.complete&order=created_at.asc&limit=40&select=role,content`);
  // Filter history rows: skip any with truly empty content (these
  // are user attachment-only turns where the chip is the message).
  // The model will see the attachment context via the system prompt's
  // attachmentContext block — no need for a placeholder per turn,
  // and including empty content here would 400 most LLM APIs.
  // EXCEPT for the just-being-sent turn (handled below) where we
  // synthesize a minimal placeholder so the LLM accepts the request.
  const messages = (histRows as any[])
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .filter((m) => (m.content && String(m.content).trim().length > 0))
    .map((m) => ({ role: m.role, content: m.content || '' }));
  // Use the abstracted content as the current user turn for the
  // model — so the LLM only ever sees the hypothetical form. When
  // the user sent ONLY an attachment (no typed text), the
  // privacyContent / content is empty. The LLM APIs require
  // non-empty user content, so we substitute a minimal placeholder.
  // The user does not see this — only the LLM does. They see the
  // attachment chip in their bubble; the model gets the file text
  // via the attachmentContext block in the system prompt.
  const llmUserContent = (privacyContent && privacyContent.trim())
    ? privacyContent
    : '(The user sent an attached document with no message. Please review the document and respond conversationally.)';
  messages.push({ role: 'user', content: llmUserContent });

  // ---- Research-mode pre-grounding ----
  // Pre-grounding now runs INSIDE the stream's start() callback below
  // so we can emit per-phase 'status' SSE events to the frontend
  // while the user waits. The grounded context blocks are
  // populated by the closures and read after Promise.all settles.
  let statuteBlock = '';
  let caseLawBlock = '';
  let legiscanBlock = '';
  let vaultBlock = '';
  // Image hits captured from the vault retrieval. Used after the
  // promise settles to attach pixel bytes to the user message when
  // the chat model is vision-capable. Each entry has the storage_path
  // we'll download from + caption text we'll surface even for
  // non-vision models. Capped to 3 by the time we attach (cost +
  // latency control).
  let vaultImageHits: any[] = [];

  const asstRow = await sbInsert('workspace_chat_messages', {
    chat_id: chatId, role: 'assistant', content: '', status: 'streaming', model_used: modelId,
    // Mark verification pending only when toggles are on, so the
    // chat page knows to poll. Off-mode messages skip verification.
    verification: anyToggleOn ? { status: 'pending', started_at: new Date().toISOString(), cites: [] } : null,
  });

  if (modelId !== chat.model) {
    sbUpdate('workspace_chats', `id=eq.${chatId}`, { model: modelId }).catch(() => {});
  }

  // Stream
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Guarded SSE send — once the stream has been closed (e.g. an
      // LLM-call error fired its own send→close sequence), further
      // enqueue calls throw "stream controller cannot close or
      // enqueue". Catch + log so a single late event doesn't bubble
      // up as an uncaught exception in the edge runtime.
      let _streamClosed = false;
      const send = (event: string, data: any) => {
        if (_streamClosed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch (err) {
          _streamClosed = true;
          console.warn(`[chat-stream] send(${event}) after close: ${(err as any)?.message}`);
        }
      };
      send('start', {
        message_id: asstRow.id,
        model: modelId,
        key_source: source,
        // user_msg_content / privacy_applied let the frontend display
        // the abstracted version of the user's message in the bubble
        // (so the user sees what was actually sent, not what they
        // typed). When privacy is off, both fields are absent and the
        // frontend keeps showing the user's typed text.
        user_msg_content: privacyEnabled ? privacyContent : undefined,
        privacy_applied: privacyEnabled,
        user_msg_id: userMsgRow.id,
      });
      if (privacyEnabled) {
        const docsNote = privacyAbstractedDocCount
          ? ` (and ${privacyAbstractedDocCount} doc${privacyAbstractedDocCount === 1 ? '' : 's'})`
          : '';
        send('status', { phase: 'privacy_done', message: `🔒 Question abstracted${docsNote}; client identifiers removed before sending` });
      }

      // ---- Vault retrieval (parallel with pre-grounding) ----
      //
      // The user's personal vault is a continuously-growing knowledge
      // base of saved docs, chat highlights, review findings, and
      // manual notes. We semantically retrieve the top relevant
      // chunks here and inline them into the system prompt as a
      // `=== YOUR VAULT ===` block.
      //
      // Privacy mode interaction: vault items are stored RAW (no
      // abstraction at insert time). When privacy mode is on, each
      // retrieved chunk is run through abstractContent() before being
      // inlined. Per-chunk fail-open: if abstraction fails for one
      // chunk, drop it but keep the rest; the user's typed message is
      // still privacy-protected at the request-level fail-closed.
      const vaultPromise: Promise<string> = vaultEnabled
        ? (async () => {
            try {
              // 1. User's vault provider preference
              const settingsRows = await sbSelect(
                `workspace_user_settings?user_id=eq.${user.id}&select=vault_embedding_provider`,
              );
              const vaultProvider = settingsRows[0]?.vault_embedding_provider || 'gemini';

              // 2. Resolve embedding key (BYOK → server fallback)
              const embedKey = await resolveVaultEmbedKey(user.id, vaultProvider);
              if (!embedKey) {
                send('status', { phase: 'vault_skip', message: '🗂️ Vault: no embedding key — skipping' });
                return '';
              }

              // 3. Embed the query. Use the abstracted message under
              //    privacy mode so we don't send raw client text to
              //    the embedding provider (matches privacy invariant).
              send('status', { phase: 'vault', message: '🗂️ Searching your vault…' });
              const queryText = privacyEnabled ? privacyContent : content;
              const queryVec = await embedSingleForVault(vaultProvider, embedKey, queryText);
              if (!queryVec || queryVec.length === 0) {
                send('status', { phase: 'vault_done', message: '🗂️ Vault embed failed' });
                return '';
              }

              // 4. RPC the vector search (workspace_vault_search) AND
              //    in parallel, the image-vector search (added in
              //    migration 0032). Image hits surface alongside text
              //    chunks so the chat model can answer "what's in the
              //    diagram on page 4?" via captions even when no text
              //    chunk mentions the image. The image RPC silently
              //    returns nothing if migration 0032 isn't applied,
              //    keeping this code safe to ship before the migration.
              const lit = '[' + queryVec.map((n: number) => Number(n).toFixed(7)).join(',') + ']';
              const textRpcPromise = fetch(`${SB_URL}/rest/v1/rpc/workspace_vault_search`, {
                method: 'POST',
                headers: {
                  apikey: SB_SERVICE_KEY,
                  Authorization: `Bearer ${SB_SERVICE_KEY}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  p_user_id: user.id,
                  p_query_vec: lit,
                  p_top_k: 6,
                  p_kinds: null,
                  p_provider: vaultProvider,
                  p_include_archived: false,
                }),
              });
              // Map text-embedding provider → multimodal-capable
              // provider for the image RPC. Voyage / Gemini share
              // vector spaces with their multimodal siblings (we use
              // matching dimensions); OpenAI users get an empty image
              // result (no public OpenAI multimodal embedding API).
              const mmProvider = vaultProvider === 'voyage' ? 'voyage'
                : vaultProvider === 'gemini' ? 'gemini'
                : null;
              const imageRpcPromise = mmProvider
                ? fetch(`${SB_URL}/rest/v1/rpc/workspace_vault_image_search`, {
                    method: 'POST',
                    headers: {
                      apikey: SB_SERVICE_KEY,
                      Authorization: `Bearer ${SB_SERVICE_KEY}`,
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                      p_user_id: user.id,
                      p_query_vec: lit,
                      p_top_k: 4,
                      p_provider: mmProvider,
                      p_include_archived: false,
                    }),
                  }).catch(() => null)
                : Promise.resolve(null);

              const [rpc, imageRpc] = await Promise.all([textRpcPromise, imageRpcPromise]);
              if (!rpc.ok) {
                send('status', { phase: 'vault_done', message: '🗂️ Vault search RPC failed' });
                return '';
              }
              const rows: any[] = await rpc.json();
              const imageRows: any[] = (imageRpc && imageRpc.ok) ? await imageRpc.json().catch(() => []) : [];

              // ---- Anchored items ----
              // Pinned vault items get a guaranteed seat at the table:
              //   - Top 3 chunks per anchored item ALWAYS go into rows
              //     (sorted by chunk_index ASC for predictability),
              //     letting the model see the doc's opening + key
              //     content even when the user's query text doesn't
              //     match anything semantically.
              //   - All images from anchored items always go into the
              //     image-attachment lookup, so vision-capable models
              //     re-see the diagrams the user is following up on.
              // anchored_item_ids is missing on chats created before
              // migration 0033 — Array.isArray check handles that case.
              const anchoredIds: string[] = Array.isArray((chat as any).anchored_item_ids)
                ? (chat as any).anchored_item_ids.filter((x: any) => typeof x === 'string')
                : [];
              if (anchoredIds.length > 0) {
                try {
                  // Pull chunks for every anchored item. Cap at 3 per
                  // item to keep prompt size bounded with multiple
                  // anchors. Hydrate item metadata in parallel.
                  const idList = anchoredIds.join(',');
                  const [chunkRes, itemRes] = await Promise.all([
                    fetch(
                      `${SB_URL}/rest/v1/workspace_vault_chunks?item_id=in.(${idList})&select=item_id,chunk_index,content&order=item_id.asc,chunk_index.asc&limit=${anchoredIds.length * 3}`,
                      { headers: { apikey: SB_SERVICE_KEY, Authorization: `Bearer ${SB_SERVICE_KEY}` } },
                    ),
                    fetch(
                      `${SB_URL}/rest/v1/workspace_vault_items?id=in.(${idList})&select=id,title,summary,source_kind,source_doc_id,created_at,pinned`,
                      { headers: { apikey: SB_SERVICE_KEY, Authorization: `Bearer ${SB_SERVICE_KEY}` } },
                    ),
                  ]);
                  const anchoredChunks: any[] = chunkRes.ok ? await chunkRes.json() : [];
                  const anchoredItemsArr: any[] = itemRes.ok ? await itemRes.json() : [];
                  const itemById = new Map(anchoredItemsArr.map((it) => [it.id, it]));
                  const seenChunkKeys = new Set(rows.map((r: any) => `${r.item_id}#${r.chunk_index}`));
                  for (const c of anchoredChunks) {
                    const key = `${c.item_id}#${c.chunk_index}`;
                    if (seenChunkKeys.has(key)) continue;
                    seenChunkKeys.add(key);
                    const it = itemById.get(c.item_id);
                    if (!it) continue;
                    rows.push({
                      chunk_id: null,
                      item_id: c.item_id,
                      chunk_index: c.chunk_index,
                      chunk_content: c.content,
                      distance: 0,
                      item_title: `${it.title} 📌`,    // pin-marked so chat sees it as anchor context
                      item_summary: it.summary,
                      item_source_kind: it.source_kind,
                      item_source_doc_id: it.source_doc_id,
                      item_created_at: it.created_at,
                      item_pinned: !!it.pinned,
                      _anchored: true,
                    });
                  }
                  console.log(`[chat-stream] anchors: pulled ${anchoredChunks.length} chunks across ${anchoredIds.length} anchored item(s)`);
                } catch (err) {
                  console.warn('[chat-stream] anchor chunk pull failed:', (err as any)?.message);
                }
              }

              // ---- Image attachment fallback ----
              // For users on Gemini/OpenAI text embeddings, the image
              // RPC returns nothing because we have no multimodal
              // vector for them (Vertex AI auth required and we don't
              // wire it). But the doc's text chunks DO contain
              // [image-N: <caption>] markers wherever an image lives.
              // When a retrieved chunk references an image, look up
              // the actual image rows by item_id from
              // workspace_vault_images so chat-stream can attach the
              // bytes downstream. This is the path that makes vision
              // attachments work for ALL users, not just Voyage ones.
              // Match both forms:
              //   `[image]`        → uncaptioned (caption job failed or skipped)
              //   `[image-1: ...]` → captioned numbered marker
              // Either form signals "this item has at least one image
              // worth attaching for vision-capable models".
              const IMG_MARKER_RE = /\[image(\]|-\d+)/;
              const itemsWithImageMarkers = new Set<string>();
              for (const r of rows) {
                if (typeof r.chunk_content === 'string' && IMG_MARKER_RE.test(r.chunk_content) && r.item_id) {
                  itemsWithImageMarkers.add(r.item_id);
                }
              }
              // Anchored items get images attached regardless of
              // whether the chunk text happens to mention an image
              // marker. This is the whole point of anchoring — the
              // pinned doc's full multimodal context follows the
              // conversation.
              for (const aid of anchoredIds) {
                if (aid) itemsWithImageMarkers.add(aid);
              }
              let fallbackImageRows: any[] = [];
              if (itemsWithImageMarkers.size > 0) {
                try {
                  // PostgREST `in.()` filter — UUIDs go in plain
                  // (unquoted) since they have no special chars.
                  // Quoting them was causing the request to fail
                  // silently with an empty result, which is why the
                  // fallback path looked dead.
                  const ids = Array.from(itemsWithImageMarkers).join(',');
                  const fbUrl = `${SB_URL}/rest/v1/workspace_vault_images?item_id=in.(${ids})&select=id,item_id,storage_path,mime_type,description,source_page,source_paragraph&limit=10`;
                  const r = await fetch(fbUrl, {
                    headers: {
                      apikey: SB_SERVICE_KEY,
                      Authorization: `Bearer ${SB_SERVICE_KEY}`,
                    },
                  });
                  if (!r.ok) {
                    console.warn(`[chat-stream] image fallback HTTP ${r.status} from ${fbUrl}`);
                  } else {
                    const fb: any[] = await r.json().catch(() => []);
                    console.log(`[chat-stream] image fallback found ${fb.length} image(s) for ${itemsWithImageMarkers.size} item(s) with markers; itemIds=${ids}`);
                    // Hydrate with item-level fields so the merge
                    // below treats them like vector-search hits.
                    for (const img of fb) {
                      const matchingChunk = rows.find((row) => row.item_id === img.item_id);
                      fallbackImageRows.push({
                        image_id: img.id,
                        item_id: img.item_id,
                        storage_path: img.storage_path,
                        mime_type: img.mime_type,
                        description: img.description,
                        source_page: img.source_page,
                        source_paragraph: img.source_paragraph,
                        item_title: matchingChunk?.item_title,
                        item_summary: matchingChunk?.item_summary,
                      });
                    }
                  }
                } catch (err) {
                  console.warn('[chat-stream] image fallback lookup failed:', (err as any)?.message);
                }
              }

              // Merge vector-search hits and fallback hits, dedup by
              // image_id, cap at 3 for cost/latency.
              const seenImg = new Set<string>();
              const mergedImages: any[] = [];
              for (const list of [imageRows, fallbackImageRows]) {
                if (!Array.isArray(list)) continue;
                for (const img of list) {
                  const id = img?.image_id || img?.id;
                  if (!id || seenImg.has(id)) continue;
                  seenImg.add(id);
                  mergedImages.push(img);
                  if (mergedImages.length >= 3) break;
                }
                if (mergedImages.length >= 3) break;
              }
              // Publish to outer scope for the chat-attachment step.
              vaultImageHits = mergedImages;
              if ((!Array.isArray(rows) || rows.length === 0) && (!Array.isArray(imageRows) || imageRows.length === 0)) {
                send('status', { phase: 'vault_done', message: '🗂️ No relevant vault snippets' });
                return '';
              }

              // 5. Privacy mode: clean each retrieved chunk on the way
              //    out. Per-chunk fail-open — drop the chunk if
              //    abstraction errors, keep the rest.
              let snippets = rows;
              if (privacyEnabled) {
                const abstractedSnips = await Promise.all(
                  rows.map(async (row) => {
                    try {
                      const abstracted = await abstractContent({
                        text: row.chunk_content || '',
                        provider, model: modelId, apiKey: key,
                      });
                      return { ...row, chunk_content: abstracted };
                    } catch (err) {
                      console.warn('[chat-stream] vault chunk abstract failed:', (err as any)?.message);
                      return null;
                    }
                  }),
                );
                snippets = abstractedSnips.filter(Boolean) as any[];
                if (snippets.length === 0) {
                  send('status', { phase: 'vault_done', message: '🗂️ All vault snippets failed abstraction; skipped' });
                  return '';
                }
                if (snippets.length < rows.length) {
                  send('status', {
                    phase: 'vault_warn',
                    message: `🗂️ ${rows.length - snippets.length} vault snippet${rows.length - snippets.length === 1 ? '' : 's'} skipped (abstraction failed)`,
                  });
                }
              }

              // 6. Build the inline block
              const lines: string[] = [
                '=== YOUR VAULT (relevant context from your prior work) ===',
                '',
              ];
              snippets.forEach((row: any, i: number) => {
                const src = String(row.item_source_kind || '').replace(/_/g, ' ');
                const title = row.item_title || 'Untitled';
                lines.push(`[${i + 1}] ${title}  (${src})`);
                lines.push(String(row.chunk_content || '').trim());
                lines.push('');
              });
              // Append image hits (Phase 6 multimodal RAG). Captions
              // are inlined as text — every chat model, multimodal or
              // not, can read them. Vision-capable models also get
              // the actual bytes attached to the user message
              // downstream (see "Vault image attachment" block).
              // Use the merged image set so users on any embedding
              // provider see their image content here, not just
              // Voyage users with a populated vector index.
              if (mergedImages.length > 0) {
                lines.push('--- Image references (captioned by AI) ---');
                lines.push('');
                mergedImages.forEach((row: any, i: number) => {
                  const title = row.item_title || 'Untitled';
                  const pageBit = row.source_page ? ` p.${row.source_page}` : '';
                  const desc = (row.description || '(no caption)').toString().trim();
                  lines.push(`[img ${i + 1}] ${title}${pageBit}: ${desc}`);
                });
                lines.push('');
              }
              lines.push('=== END VAULT ===');
              const totalHits = snippets.length + mergedImages.length;
              const imgBit = mergedImages.length ? ` + ${mergedImages.length} image${mergedImages.length === 1 ? '' : 's'}` : '';
              send('status', {
                phase: 'vault_done',
                message: `🗂️ Pulled ${snippets.length} vault snippet${snippets.length === 1 ? '' : 's'}${imgBit}`,
              });
              // Surface which vault items contributed to this turn so
              // the UI can offer "Anchor this doc?" suggestions after
              // the assistant's response. Dedup by item_id; tag
              // already-anchored items so the UI hides the anchor
              // pill for those (it'd be a no-op).
              try {
                const seenItems = new Map<string, any>();
                for (const r of rows) {
                  if (!r.item_id || seenItems.has(r.item_id)) continue;
                  seenItems.set(r.item_id, {
                    item_id: r.item_id,
                    title: String(r.item_title || '').replace(/ 📌$/, ''),
                    source_kind: r.item_source_kind,
                    anchored: anchoredIds.includes(r.item_id),
                  });
                }
                for (const img of mergedImages) {
                  const id = img.item_id || img.item?.id;
                  if (!id || seenItems.has(id)) continue;
                  seenItems.set(id, {
                    item_id: id,
                    title: String(img.item_title || '').replace(/ 📌$/, ''),
                    source_kind: img.item_source_kind,
                    anchored: anchoredIds.includes(id),
                  });
                }
                if (seenItems.size > 0) {
                  send('vault_items', { items: Array.from(seenItems.values()) });
                }
              } catch {}
              return lines.join('\n');
            } catch (err) {
              console.warn('[chat-stream] vault retrieval failed:', (err as any)?.message);
              send('status', { phase: 'vault_done', message: '🗂️ Vault retrieval failed' });
              return '';
            }
          })()
        : Promise.resolve('');

      // ---- Heartbeat beat-generator (always on) ----
      // Runs for EVERY chat message, regardless of research-mode
      // toggles. Generates tailored "what we're doing now" phrases
      // for this specific question; falls back to generic phrases
      // on failure. Result is awaited just before the streaming
      // loop and used to populate REASONING_BEATS.
      const stateInfoForBeats = findState(lawSettings.state);
      const beatsPromise: Promise<string[]> = generateContextualBeats({
        query: content,
        state: stateInfoForBeats?.code || null,
        provider,
        model: modelId,
        apiKey: key,
      })
      .then((beats) => {
        const isFallback = beats === FALLBACK_BEATS || (Array.isArray(beats) && beats.length === FALLBACK_BEATS.length && beats[0] === FALLBACK_BEATS[0]);
        console.log(`[chat-stream] beat-gen ${isFallback ? 'fell back to generic' : 'tailored'} beats (${beats?.length || 0}): ${JSON.stringify(beats?.slice(0, 3))}`);
        return beats;
      })
      .catch((err) => {
        console.warn('[chat-stream] beat-gen rejected:', (err as any)?.message);
        return FALLBACK_BEATS;
      });

      // ---- Research-mode pre-grounding (with progress events) ----
      // Only runs when toggles are on. The heartbeat above runs
      // regardless, so non-research chats also get the spinner +
      // rotating phrases. State filtering is conditional on the
      // jurisdiction toggle: when off, case law and bills run
      // without a state filter (broader search) and statutes is
      // skipped entirely (statutes inherently need a jurisdiction).
      if (anyToggleOn) {
        const stateInfo = findState(lawSettings.state);
        const fedInfo = findState('US');
        send('status', { phase: 'pregrounding', message: 'Starting research mode…' });
        const sb = makeSupabaseREST({ url: SB_URL, serviceKey: SB_SERVICE_KEY });
        const clKey = Deno.env.get('COURTLISTENER_TOKEN') || Deno.env.get('COURTLISTENER_API_KEY') || null;
        const lsKey = Deno.env.get('LEGISCAN_API_KEY') || null;
        const tasks: Promise<void>[] = [];
        let statuteBlocks: string[] = [];     // accumulate state + federal statute blocks
        let caseLawBlocks: string[] = [];     // accumulate state + federal case-law blocks
        let legiscanBlocks: string[] = [];    // accumulate state + federal bill blocks

        // ---- State Statutes ----
        if (lawSettings.state_statutes_enabled && stateInfo) {
          send('status', { phase: 'state_statutes', message: `Fetching ${stateInfo.name} statute sources…` });
          tasks.push((async () => {
            try {
              const fetched = await fetchStatuteRoot({ state: stateInfo.code, sb });
              statuteBlocks.push(buildStatuteSystemBlock(stateInfo, fetched));
              send('status', {
                phase: 'state_statutes_done',
                message: fetched
                  ? `${stateInfo.name} statute source ready (${fetched.primary})`
                  : `${stateInfo.name} statute fetch fell through; will use web search`,
              });
            } catch (err) {
              console.warn('[chat-stream] state statute failed:', (err as any)?.message);
              statuteBlocks.push(buildStatuteSystemBlock(stateInfo, null));
              send('status', { phase: 'state_statutes_done', message: `${stateInfo.name} statute fetch failed; using web search` });
            }
          })());
        }

        // ---- Federal Statutes ----
        if (lawSettings.federal_statutes_enabled && fedInfo) {
          send('status', { phase: 'fed_statutes', message: `Fetching U.S. Code (Cornell + uscode.house.gov)…` });
          tasks.push((async () => {
            try {
              const fetched = await fetchStatuteRoot({ state: 'US', sb });
              statuteBlocks.push(buildStatuteSystemBlock(fedInfo, fetched));
              send('status', {
                phase: 'fed_statutes_done',
                message: fetched
                  ? `U.S. Code source ready (${fetched.primary})`
                  : `U.S. Code fetch fell through; will use web search`,
              });
            } catch (err) {
              console.warn('[chat-stream] federal statute failed:', (err as any)?.message);
              statuteBlocks.push(buildStatuteSystemBlock(fedInfo, null));
              send('status', { phase: 'fed_statutes_done', message: `U.S. Code fetch failed; using web search` });
            }
          })());
        }

        // ---- State Case Law ----
        if (lawSettings.state_caselaw_enabled && stateInfo && clKey) {
          const courts = STATE_TO_CL_COURTS[stateInfo.code] || [];
          send('status', { phase: 'state_caselaw', message: `Searching CourtListener (${stateInfo.name} courts)…` });
          tasks.push((async () => {
            try {
              const opinions = await searchCourtListenerOpinions({ query: content, courts, limit: 5, apiKey: clKey });
              if (opinions.length) {
                caseLawBlocks.push(buildCaseLawSystemBlock({ query: content, results: opinions, source: `courtlistener (${stateInfo.code} state courts)` }));
              }
              send('status', {
                phase: 'state_caselaw_done',
                message: opinions.length
                  ? `Found ${opinions.length} ${stateInfo.name} opinion${opinions.length === 1 ? '' : 's'}`
                  : `No CourtListener matches in ${stateInfo.name} courts`,
              });
            } catch (err) {
              console.warn('[chat-stream] state case-law failed:', (err as any)?.message);
              send('status', { phase: 'state_caselaw_done', message: `${stateInfo.name} case-law fetch failed` });
            }
          })());
        }

        // ---- Federal Case Law ----
        if (lawSettings.federal_caselaw_enabled && clKey) {
          const fedCourts = STATE_TO_CL_COURTS['US'] || ['scotus'];
          send('status', { phase: 'fed_caselaw', message: `Searching CourtListener (SCOTUS + all federal circuits)…` });
          tasks.push((async () => {
            try {
              const opinions = await searchCourtListenerOpinions({ query: content, courts: fedCourts, limit: 5, apiKey: clKey });
              if (opinions.length) {
                caseLawBlocks.push(buildCaseLawSystemBlock({ query: content, results: opinions, source: 'courtlistener (federal courts)' }));
              }
              send('status', {
                phase: 'fed_caselaw_done',
                message: opinions.length
                  ? `Found ${opinions.length} federal opinion${opinions.length === 1 ? '' : 's'}`
                  : `No CourtListener matches in federal courts`,
              });
            } catch (err) {
              console.warn('[chat-stream] federal case-law failed:', (err as any)?.message);
              send('status', { phase: 'fed_caselaw_done', message: `Federal case-law fetch failed` });
            }
          })());
        }

        // ---- State Bills ----
        if (lawSettings.state_bills_enabled && stateInfo && lsKey) {
          send('status', { phase: 'state_bills', message: `Pulling recent ${stateInfo.name} bills from LegiScan…` });
          tasks.push((async () => {
            try {
              const bills = await searchLegiscanBills({ query: content, state: stateInfo.code, apiKey: lsKey, limit: 6 });
              legiscanBlocks.push(buildLegiscanSystemBlock({ query: content, state: stateInfo.code, results: bills }));
              send('status', {
                phase: 'state_bills_done',
                message: bills.length
                  ? `Found ${bills.length} recent ${stateInfo.name} bill${bills.length === 1 ? '' : 's'}`
                  : `No matching ${stateInfo.name} bills`,
              });
            } catch (err) {
              console.warn('[chat-stream] state bills failed:', (err as any)?.message);
              send('status', { phase: 'state_bills_done', message: `LegiScan ${stateInfo.code} lookup failed` });
            }
          })());
        }

        // ---- Federal Bills ----
        if (lawSettings.federal_bills_enabled && lsKey) {
          send('status', { phase: 'fed_bills', message: `Pulling recent Congress bills from LegiScan…` });
          tasks.push((async () => {
            try {
              const bills = await searchLegiscanBills({ query: content, state: 'US', apiKey: lsKey, limit: 6 });
              legiscanBlocks.push(buildLegiscanSystemBlock({ query: content, state: 'US (Congress)', results: bills }));
              send('status', {
                phase: 'fed_bills_done',
                message: bills.length
                  ? `Found ${bills.length} recent Congress bill${bills.length === 1 ? '' : 's'}`
                  : `No matching Congress bills`,
              });
            } catch (err) {
              console.warn('[chat-stream] federal bills failed:', (err as any)?.message);
              send('status', { phase: 'fed_bills_done', message: `LegiScan Congress lookup failed` });
            }
          })());
        }

        await Promise.all(tasks);
        statuteBlock = statuteBlocks.join('\n\n---\n\n');
        caseLawBlock = caseLawBlocks.join('\n\n---\n\n');
        legiscanBlock = legiscanBlocks.join('\n\n---\n\n');
        send('status', { phase: 'thinking', message: 'Reasoning over sources…' });
      }

      // Await the vault retrieval (kicked off above, runs in parallel
      // with pre-grounding when both are on; runs alone otherwise).
      vaultBlock = await vaultPromise;

      // ---- Vault image attachment (Phase 6.5 multimodal) ----
      // For vision-capable chat models, fetch the actual image bytes
      // for each top vault-image hit and attach them to the LAST user
      // message as a content-array block. The chat model then "sees"
      // the diagram/signature/etc. instead of only reading its caption.
      //
      // Vision-capable detection — pattern-matched per provider so
      // new models auto-classify without a code edit. Mirrors the
      // logic in netlify/functions/workspace-models-list.js.
      //   Anthropic — Claude 3+, sonnet-4*, opus-4*, haiku-3-5* / haiku-4*
      //   OpenAI    — gpt-4o, gpt-4-turbo, gpt-4.1, gpt-5 family
      //   Google    — gemini-1.5+, 2.x (all natively multimodal)
      //   xAI       — grok-4*, grok-2-vision, grok-3-vision
      // For text-only models we skip the byte fetch; captions in
      // vaultBlock still give semantic awareness.
      function detectVision(p: string, id: string): boolean {
        const s = (id || '').toLowerCase();
        if (p === 'anthropic') return /^claude-(3|sonnet-4|opus-4|haiku-(3-5|4))/.test(s);
        if (p === 'openai')    return /^gpt-(4o|4-turbo|4\.1|5)/.test(s);
        if (p === 'google')    return /^gemini-(1\.5|2\.0|2\.5|3|exp)/.test(s);
        // xAI: grok-4+ is multimodal via the /v1/responses endpoint
        // when the request uses the right content-block schema
        // (input_text / input_image). Earlier 422s came from sending
        // OpenAI Chat-Completions-style blocks to a Responses API.
        // Now that the message builder emits the correct shape, all
        // grok-4 variants and explicit vision SKUs work.
        // The "-non-reasoning" suffix is text-only by design.
        if (p === 'xai') {
          if (/non-reasoning/.test(s)) return false;
          if (/(.*-vision|.*-fast-vision)/.test(s)) return true;
          if (/^grok-(4|3-vision|2-vision)/.test(s)) return true;
          return false;
        }
        return false;
      }
      const isVisionCapable = detectVision(provider, modelId);

      // Each entry: { mimeType, data (base64), title, page }
      let attachedImages: Array<{ mimeType: string; data: string; title: string; page: number | null }> = [];

      if (isVisionCapable && vaultImageHits.length > 0) {
        send('status', { phase: 'vault_images', message: `Attaching ${vaultImageHits.length} vault image${vaultImageHits.length === 1 ? '' : 's'} to chat…` });
        const fetched = await Promise.all(
          vaultImageHits.map(async (hit) => {
            try {
              // Supabase Storage signed-URL download. We use the service
              // role to get the bytes since chat-stream runs server-side.
              const url = `${SB_URL}/storage/v1/object/library/${encodeURI(hit.storage_path)}`;
              const r = await fetch(url, {
                headers: {
                  apikey: SB_SERVICE_KEY,
                  Authorization: `Bearer ${SB_SERVICE_KEY}`,
                },
              });
              if (!r.ok) {
                console.warn(`[chat-stream] image fetch ${hit.storage_path} → ${r.status}`);
                return null;
              }
              const ab = await r.arrayBuffer();
              // Anthropic / OpenAI / Google all accept base64. Keep
              // bytes uniform, transform per-provider downstream.
              const u8 = new Uint8Array(ab);
              let bin = '';
              for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
              const data = btoa(bin);
              return {
                mimeType: hit.mime_type || 'image/jpeg',
                data,
                title: String(hit.item_title || 'Document'),
                page: hit.source_page ?? null,
              };
            } catch (err) {
              console.warn('[chat-stream] image attach failed:', (err as any)?.message);
              return null;
            }
          }),
        );
        attachedImages = fetched.filter((x): x is { mimeType: string; data: string; title: string; page: number | null } => !!x);
        if (attachedImages.length > 0) {
          send('status', { phase: 'vault_images_done', message: `Vision: ${attachedImages.length} image${attachedImages.length === 1 ? '' : 's'} attached for inspection` });
        }
      }

      // Rewrite the LAST user message into a per-provider content-
      // array form when we have images to attach. Each streamX
      // function understands its native format already (Anthropic
      // accepts Anthropic-style; OpenAI accepts OpenAI-style; Google
      // gets transformed inside streamGoogle). We branch by provider
      // here so each function gets exactly what it expects.
      if (attachedImages.length > 0 && messages.length > 0) {
        const last = messages[messages.length - 1];
        const userText = String(last.content || '');
        if (provider === 'anthropic') {
          // Anthropic Messages API — content array of typed blocks.
          // Image first, text last is conventional but order is free.
          const blocks: any[] = attachedImages.map((img) => ({
            type: 'image',
            source: { type: 'base64', media_type: img.mimeType, data: img.data },
          }));
          blocks.push({ type: 'text', text: userText });
          last.content = blocks;
        } else if (provider === 'openai') {
          // OpenAI Chat Completions schema — content array with
          // { type: 'text', text } and { type: 'image_url', image_url: { url } }.
          const blocks: any[] = attachedImages.map((img) => ({
            type: 'image_url',
            image_url: { url: `data:${img.mimeType};base64,${img.data}`, detail: 'high' },
          }));
          blocks.unshift({ type: 'text', text: userText });
          last.content = blocks;
        } else if (provider === 'xai') {
          // xAI uses the OpenAI RESPONSES API (/v1/responses), NOT
          // Chat Completions. The Responses API has a different
          // content-block schema:
          //   text  → { type: 'input_text',  text: '...' }
          //   image → { type: 'input_image', image_url: 'data:...', detail: 'high' }
          // Note image_url is a STRING here (not nested object).
          // The Chat Completions shape (type: 'image_url' with
          // nested object) returns 422 from xAI's deserializer, which
          // is why earlier attempts failed on every grok-4 variant.
          const blocks: any[] = attachedImages.map((img) => ({
            type: 'input_image',
            image_url: `data:${img.mimeType};base64,${img.data}`,
            detail: 'high',
          }));
          blocks.unshift({ type: 'input_text', text: userText });
          last.content = blocks;
        } else {
          // Google: streamGoogle does its own transformation. Stash a
          // sidecar field so it can build parts[] correctly.
          (last as any).images = attachedImages.map((img) => ({
            mimeType: img.mimeType,
            data: img.data,
          }));
        }
      }

      let acc = '';
      try {
        // Compose the system prompt. Order:
        //   1. Workflow override if the chat is bound to one, else the
        //      default conversational legal-research prompt.
        //   2. Attached document context inlined verbatim.
        //   3. Research-mode context blocks (statute / case law /
        //      LegiScan) when the corresponding toggles are on.
        const baseSystem = workflowSystemPrompt || SYSTEM_PROMPT;
        const promptParts: string[] = [baseSystem];
        if (attachmentContext) {
          promptParts.push(`The user has attached the following documents to this conversation. Read them carefully before answering. When citing them, use the document filename:\n${attachmentContext}`);
        }
        if (statuteBlock)  promptParts.push(statuteBlock);
        if (caseLawBlock)  promptParts.push(caseLawBlock);
        if (legiscanBlock) promptParts.push(legiscanBlock);
        if (vaultBlock)    promptParts.push(vaultBlock);
        const fullSystem = promptParts.join('\n\n---\n\n');

        // Web-search opts piped to provider-specific tools when any
        // research toggle is on. Allowed-domains list scopes search
        // to the selected state + universal authoritative sources.
        // The state is always honored for allowed_domains; federal
        // domains are added unconditionally inside buildAllowedDomains.
        const stateInfoLocal = findState(lawSettings.state);
        const anyStatutes = lawSettings.state_statutes_enabled || lawSettings.federal_statutes_enabled;
        const anyCaseLaw  = lawSettings.state_caselaw_enabled  || lawSettings.federal_caselaw_enabled;
        const anyBills    = lawSettings.state_bills_enabled    || lawSettings.federal_bills_enabled;
        const webSearch = anyToggleOn
          ? {
              enabled: true,
              allowedDomains: buildAllowedDomains({
                statutesOn: anyStatutes,
                caseLawOn:  anyCaseLaw,
                legiscanOn: anyBills,
                state: stateInfoLocal,
              }),
            }
          : undefined;

        console.log(`[chat-stream] starting model=${modelId} provider=${provider} keySource=${source} messages=${messages.length} attachments=${attachmentMeta.length} attachChars=${attachmentContext.length} privacy=${lawSettings.privacy_enabled} toggles=${JSON.stringify({sSt:lawSettings.state_statutes_enabled,fSt:lawSettings.federal_statutes_enabled,sCa:lawSettings.state_caselaw_enabled,fCa:lawSettings.federal_caselaw_enabled,sBi:lawSettings.state_bills_enabled,fBi:lawSettings.federal_bills_enabled,st:lawSettings.state})}`);
        let gen: AsyncGenerator<{ delta: string }>;
        // Deep-think compatibility — only true when the model
        // ACCEPTS the reasoning param (i.e. the toggle does something).
        // Mirror of modelSupportsReasoning() in workspace-models-list.js.
        // CRITICAL: xAI's "*-reasoning" SKUs always reason at max
        // effort and REJECT explicit reasoning_effort with a 400
        // ("Model X does not support parameter reasoningEffort"),
        // so we exclude them here. Same for "-non-reasoning"
        // (no reasoning at all) and any non-Grok-4 base.
        function detectReasoning(p: string, id: string): boolean {
          const s = (id || '').toLowerCase();
          if (p === 'anthropic') return /^claude-(3-7|sonnet-4|opus-4|haiku-4)/.test(s);
          if (p === 'openai')    return /^(o[1-9]|gpt-5)/.test(s);
          if (p === 'google')    return /^gemini-(2\.5|3|exp)/.test(s);
          if (p === 'xai') {
            if (/-reasoning(?:-|$)/.test(s)) return false;     // already reasoning, param 400s
            if (/-non-reasoning/.test(s))    return false;     // text-only
            return /^grok-4/.test(s);
          }
          return false;
        }
        const reasoningOn = deepThink && detectReasoning(provider, modelId);
        if (reasoningOn) {
          send('status', { phase: 'deep_think', message: 'Deep think on — model has a longer scratchpad…' });
        }
        if (provider === 'anthropic') gen = streamAnthropic({ key, model: modelId, system: fullSystem, messages, webSearch, deepThink: reasoningOn });
        else if (provider === 'openai') gen = streamOpenAI({ key, model: modelId, system: fullSystem, messages, webSearch, deepThink: reasoningOn });
        else if (provider === 'xai') gen = streamXAI({ key, model: modelId, system: fullSystem, messages, webSearch, deepThink: reasoningOn });
        else gen = streamGoogle({ key, model: modelId, system: fullSystem, messages, webSearch, deepThink: reasoningOn });

        // Heartbeat: rotate a sequence of "what we're doing now"
        // messages every few seconds while waiting for the model's
        // first token. ALWAYS on — fires for both research-mode and
        // regular chats. Tailored to THIS specific question via the
        // beat-generator; falls back to FALLBACK_BEATS while the
        // tailored set is still pending or on generation failure.
        let REASONING_BEATS: string[] = [...FALLBACK_BEATS];
        let beatsResolved = false;
        beatsPromise.then((beats) => { REASONING_BEATS = beats; beatsResolved = true; });
        let beatIdx = 0;
        let beatTimer: number | undefined;
        let firstTextSent = false;
        // Show the first phrase IMMEDIATELY so the user sees activity
        // right away, even before the parallel beat-gen finishes.
        // Pre-grounding may already have sent an earlier status; this
        // overrides it with the heartbeat phrase, which is the right
        // signal once pre-grounding is done.
        send('status', { phase: 'thinking', message: REASONING_BEATS[0] });
        const scheduleBeat = () => {
          if (!REASONING_BEATS.length) return;
          beatTimer = setTimeout(() => {
            if (firstTextSent) return;
            beatIdx = (beatIdx + 1) % REASONING_BEATS.length;
            send('status', { phase: 'thinking', message: REASONING_BEATS[beatIdx] });
            scheduleBeat();
          }, 3800) as unknown as number;
        };
        const cancelBeat = () => {
          if (beatTimer) { clearTimeout(beatTimer); beatTimer = undefined; }
        };
        scheduleBeat();

        for await (const chunk of gen as AsyncGenerator<any>) {
          // Streamers may yield two flavors:
          //   { type: 'text', delta }    or legacy { delta }    — visible text
          //   { type: 'status', message } — mid-flight tool /
          //                                 search activity surfaced
          //                                 to the user as a phase
          //                                 indicator update.
          if (chunk.type === 'status' && chunk.message) {
            // Real tool activity arrived — pause the heartbeat (it
            // would compete with the actual signal), forward, and
            // restart so the rotation resumes after the tool finishes.
            cancelBeat();
            send('status', { phase: 'mid_search', message: chunk.message });
            scheduleBeat();
            continue;
          }
          const delta = chunk.delta || (chunk.type === 'text' ? chunk.delta : null);
          if (delta) {
            if (!firstTextSent) {
              firstTextSent = true;
              cancelBeat();
              // Always send streaming status so the frontend hides
              // the spinner indicator when text begins, regardless
              // of research mode.
              send('status', { phase: 'streaming', message: '' });
            }
            acc += delta;
            send('text', { delta });
          }
        }
        cancelBeat();
        console.log(`[chat-stream] complete model=${modelId} chars=${acc.length}`);
      } catch (err) {
        const msg = (err as any)?.message || String(err);
        console.error(`[chat-stream] streaming error model=${modelId}:`, msg);
        send('error', { error: msg });
        sbUpdate('workspace_chat_messages', `id=eq.${asstRow.id}`, { status: 'error', status_detail: msg.slice(0, 1000) }).catch(() => {});
        controller.close();
        return;
      }

      // Persist final + maybe title
      sbUpdate('workspace_chat_messages', `id=eq.${asstRow.id}`, { content: acc, status: 'complete' }).catch(() => {});

      // Fire-and-forget the post-hoc verification when any toggle
      // is on. The chat page polls workspace-chat-message-get for
      // the result and renders inline badges as cites resolve.
      if (anyToggleOn) {
        const baseUrl = Deno.env.get('URL') || Deno.env.get('DEPLOY_URL') || 'http://localhost:8888';
        fetch(`${baseUrl}/.netlify/functions/workspace-chat-verify-background`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Internal-Trigger': 'chat-verify' },
          body: JSON.stringify({ message_id: asstRow.id, law_settings: lawSettings }),
        }).catch((err) => console.warn('[chat-stream] verify trigger failed:', err?.message));
      }

      let title: string | null = chat.title;
      if (!title) {
        title = await generateTitle(provider, key, modelId, content, acc);
        if (title) sbUpdate('workspace_chats', `id=eq.${chatId}`, { title }).catch(() => {});
      }
      sbUpdate('workspace_chats', `id=eq.${chatId}`, { updated_at: new Date().toISOString() }).catch(() => {});

      send('done', { message_id: asstRow.id, title, verifying: anyToggleOn });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    },
  });
};

function json(obj: any, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const config = { path: '/api/workspace-chat-stream' };
