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

async function* streamAnthropic(opts: { key: string; model: string; system: string; messages: any[] }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': opts.key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: opts.model,
      system: opts.system,
      messages: opts.messages,
      max_tokens: 4096,
      temperature: 0.4,
      stream: true,
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 400)}`);
  for await (const ev of parseSSE(res.body!)) {
    if (!ev.data) continue;
    let d: any;
    try { d = JSON.parse(ev.data); } catch { continue; }
    if (d.type === 'content_block_delta' && d.delta?.type === 'text_delta') {
      yield { delta: d.delta.text };
    }
  }
}

async function* streamOpenAI(opts: { key: string; model: string; system: string; messages: any[] }) {
  const msgs: any[] = [];
  if (opts.system) msgs.push({ role: 'system', content: opts.system });
  msgs.push(...opts.messages);
  // GPT-5 era models require max_completion_tokens; older models accept
  // max_tokens. Use the new name for everything modern; OpenAI accepts
  // it for older models too as a graceful fallback.
  //
  // We do NOT cap reasoning_effort. This site is built around legal
  // reasoning — users WANT the model to think hard. Default effort
  // (medium) is fine; if a user needs faster turnaround they can pick
  // a non-reasoning model like gpt-4.1.
  const body: any = {
    model: opts.model,
    messages: msgs,
    max_completion_tokens: 4096,
    stream: true,
  };
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

async function* streamXAI(opts: { key: string; model: string; system: string; messages: any[] }) {
  // xAI is OpenAI-compatible. Same chat-completions schema, same SSE
  // format. Different base URL and key prefix (xai-).
  //
  // Grok 4+ are reasoning models with internal "thinking" before
  // emitting tokens — feels like a long delay in chat. Pass
  // reasoning_effort='low' so the model skips extended reasoning and
  // streams quickly. Earlier Grok 3 doesn't accept this param so we
  // gate it on grok-4+.
  const msgs: any[] = [];
  if (opts.system) msgs.push({ role: 'system', content: opts.system });
  msgs.push(...opts.messages);
  // No reasoning_effort override for xAI either — let Grok reason at
  // its natural pace. Legal reasoning is the value proposition; the
  // delay is acceptable.
  const body: any = {
    model: opts.model,
    messages: msgs,
    max_tokens: 4096,
    temperature: 0.4,
    stream: true,
  };
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`xAI ${res.status}: ${(await res.text()).slice(0, 400)}`);
  for await (const ev of parseSSE(res.body!)) {
    if (!ev.data || ev.data === '[DONE]') continue;
    let d: any;
    try { d = JSON.parse(ev.data); } catch { continue; }
    const t = d.choices?.[0]?.delta?.content;
    if (t) yield { delta: t };
  }
}

async function* streamGoogle(opts: { key: string; model: string; system: string; messages: any[] }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(opts.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(opts.key)}`;
  console.log(`[chat-stream] Google URL: ${url.replace(opts.key, '<REDACTED>')}`);
  const contents = opts.messages.map((m: any) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const body: any = {
    contents,
    generationConfig: { maxOutputTokens: 4096, temperature: 0.4 },
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
  if (!chatId) return json({ error: 'Missing chat_id' }, 400);
  if (!content) return json({ error: 'Empty message' }, 400);
  if (content.length > 50_000) return json({ error: 'Message too long' }, 400);

  // Verify chat ownership
  const chats = await sbSelect(`workspace_chats?id=eq.${chatId}&user_id=eq.${user.id}&select=id,title,model,workflow_id`);
  const chat = chats[0];
  if (!chat) return json({ error: 'Chat not found' }, 404);

  // If the chat is bound to a workflow, fetch its prompt_md and use
  // it as the system prompt instead of the default. The workflow must
  // be visible to this user (own or system+published).
  let workflowSystemPrompt: string | null = null;
  if (chat.workflow_id) {
    try {
      const wfRows = await sbSelect(`workspace_workflows?id=eq.${chat.workflow_id}&or=(user_id.eq.${user.id},and(user_id.is.null,is_published.eq.true))&select=prompt_md,kind`);
      const wf = wfRows[0];
      if (wf?.kind === 'chat' && wf.prompt_md) workflowSystemPrompt = wf.prompt_md;
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
  let attachmentContext = '';
  const attachmentMeta: { id: string; filename: string; chars: number }[] = [];
  if (attachmentIds.length > 0) {
    try {
      // Get the docs (filtered to user-owned)
      const idList = attachmentIds.map((id) => `"${id}"`).join(',');
      const docs = await sbSelect(`workspace_documents?id=in.(${idList})&user_id=eq.${user.id}&deleted_at=is.null&select=id,filename,current_version_id`);
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
        attachmentContext += `\n\n=== ATTACHED DOCUMENT: ${d.filename} ===\n\n${text}\n\n=== END OF ${d.filename} ===\n`;
      }
    } catch (err) {
      console.error('[chat-stream] attachment resolve failed:', err);
    }
  }

  // Persist user message + create assistant placeholder
  const userMsgRow = await sbInsert('workspace_chat_messages', {
    chat_id: chatId, role: 'user', content, status: 'complete',
    attachments: attachmentMeta,
  });

  // Load history (excluding the just-inserted user msg, we'll add it explicitly)
  const histRows = await sbSelect(`workspace_chat_messages?chat_id=eq.${chatId}&id=neq.${userMsgRow.id}&status=eq.complete&order=created_at.asc&limit=40&select=role,content`);
  const messages = (histRows as any[])
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content || '' }));
  messages.push({ role: 'user', content });

  const asstRow = await sbInsert('workspace_chat_messages', {
    chat_id: chatId, role: 'assistant', content: '', status: 'streaming', model_used: modelId,
  });

  if (modelId !== chat.model) {
    sbUpdate('workspace_chats', `id=eq.${chatId}`, { model: modelId }).catch(() => {});
  }

  // Stream
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: any) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send('start', { message_id: asstRow.id, model: modelId, key_source: source });

      let acc = '';
      try {
        // Compose the system prompt. Order:
        //   1. Workflow override if the chat is bound to one, else the
        //      default conversational legal-research prompt.
        //   2. Plus any attached document context inlined verbatim.
        const baseSystem = workflowSystemPrompt || SYSTEM_PROMPT;
        const fullSystem = attachmentContext
          ? `${baseSystem}\n\nThe user has attached the following documents to this conversation. Read them carefully before answering. When citing them, use the document filename:\n${attachmentContext}`
          : baseSystem;
        console.log(`[chat-stream] starting model=${modelId} provider=${provider} keySource=${source} messages=${messages.length} attachments=${attachmentMeta.length} attachChars=${attachmentContext.length}`);
        let gen: AsyncGenerator<{ delta: string }>;
        if (provider === 'anthropic') gen = streamAnthropic({ key, model: modelId, system: fullSystem, messages });
        else if (provider === 'openai') gen = streamOpenAI({ key, model: modelId, system: fullSystem, messages });
        else if (provider === 'xai') gen = streamXAI({ key, model: modelId, system: fullSystem, messages });
        else gen = streamGoogle({ key, model: modelId, system: fullSystem, messages });

        for await (const chunk of gen) {
          if (chunk.delta) {
            acc += chunk.delta;
            send('text', { delta: chunk.delta });
          }
        }
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

      let title: string | null = chat.title;
      if (!title) {
        title = await generateTitle(provider, key, modelId, content, acc);
        if (title) sbUpdate('workspace_chats', `id=eq.${chatId}`, { title }).catch(() => {});
      }
      sbUpdate('workspace_chats', `id=eq.${chatId}`, { updated_at: new Date().toISOString() }).catch(() => {});

      send('done', { message_id: asstRow.id, title });
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
