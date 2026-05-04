/**
 * Unified LLM client across Anthropic / OpenAI / Google.
 *
 * Two entry points:
 *   - completeText(...)        — non-streaming, returns full text
 *   - streamText(...)          — async iterator over text deltas
 *
 * Same input shape for both:
 *   {
 *     provider: 'anthropic' | 'openai' | 'google',
 *     model:    string (provider-specific id),
 *     apiKey:   string,
 *     system:   string (optional system prompt),
 *     messages: [{ role: 'user'|'assistant', content: string }],
 *     maxTokens: number (optional),
 *     temperature: number (optional, default 0.4),
 *   }
 *
 * Streaming yields { type: 'text', delta: string } chunks then a final
 * { type: 'done', usage: {input,output} } chunk.
 *
 * Heads-up: this file is imported from BOTH regular Netlify Functions
 * (Node 20) and the Edge Function (Deno). Don't add Node-specific
 * imports here. Use Web APIs (fetch, ReadableStream) only.
 */

// ---- Model catalog ---------------------------------------------------------
// Display name + provider-specific id. The UI's model toggle uses this list.
// Add models here; nothing else needs to change.
export const MODELS = [
  // Anthropic
  { id: 'claude-sonnet-4-5',  label: 'Claude Sonnet 4.5',  provider: 'anthropic', context: 200_000, default: true },
  { id: 'claude-opus-4-5',    label: 'Claude Opus 4.5',    provider: 'anthropic', context: 200_000 },
  { id: 'claude-haiku-4-5',   label: 'Claude Haiku 4.5',   provider: 'anthropic', context: 200_000 },
  // OpenAI
  { id: 'gpt-5',              label: 'GPT-5',              provider: 'openai',    context: 256_000 },
  { id: 'gpt-5-mini',         label: 'GPT-5 mini',         provider: 'openai',    context: 256_000 },
  { id: 'gpt-4.1',            label: 'GPT-4.1',            provider: 'openai',    context: 1_000_000 },
  // Google
  { id: 'gemini-2.5-pro',     label: 'Gemini 2.5 Pro',     provider: 'google',    context: 2_000_000 },
  { id: 'gemini-2.5-flash',   label: 'Gemini 2.5 Flash',   provider: 'google',    context: 1_000_000 },
];

export function findModel(id) {
  return MODELS.find((m) => m.id === id) || MODELS.find((m) => m.default);
}

// ---- Anthropic -------------------------------------------------------------

async function* streamAnthropic({ apiKey, model, system, messages, maxTokens, temperature }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      system,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: maxTokens ?? 4096,
      temperature: temperature ?? 0.4,
      stream: true,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Anthropic ${res.status}: ${text.slice(0, 500)}`);
  }
  let usage = { input: 0, output: 0 };
  for await (const chunk of parseSseStream(res.body)) {
    if (!chunk.data) continue;
    let evt;
    try { evt = JSON.parse(chunk.data); } catch { continue; }
    if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
      yield { type: 'text', delta: evt.delta.text };
    } else if (evt.type === 'message_start' && evt.message?.usage) {
      usage.input = evt.message.usage.input_tokens || 0;
    } else if (evt.type === 'message_delta' && evt.usage) {
      usage.output = evt.usage.output_tokens || 0;
    }
  }
  yield { type: 'done', usage };
}

// ---- OpenAI ---------------------------------------------------------------

async function* streamOpenAI({ apiKey, model, system, messages, maxTokens, temperature }) {
  const oaMessages = [];
  if (system) oaMessages.push({ role: 'system', content: system });
  for (const m of messages) oaMessages.push({ role: m.role, content: m.content });

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: oaMessages,
      max_tokens: maxTokens ?? 4096,
      temperature: temperature ?? 0.4,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenAI ${res.status}: ${text.slice(0, 500)}`);
  }
  let usage = { input: 0, output: 0 };
  for await (const chunk of parseSseStream(res.body)) {
    if (!chunk.data || chunk.data === '[DONE]') continue;
    let evt;
    try { evt = JSON.parse(chunk.data); } catch { continue; }
    const delta = evt.choices?.[0]?.delta?.content;
    if (delta) yield { type: 'text', delta };
    if (evt.usage) {
      usage.input = evt.usage.prompt_tokens || 0;
      usage.output = evt.usage.completion_tokens || 0;
    }
  }
  yield { type: 'done', usage };
}

// ---- Google Gemini -------------------------------------------------------

async function* streamGoogle({ apiKey, model, system, messages, maxTokens, temperature }) {
  // Gemini's REST endpoint: streamGenerateContent with alt=sse for SSE.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
  // Map our internal messages to Gemini's contents shape.
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const body = {
    contents,
    generationConfig: {
      maxOutputTokens: maxTokens ?? 4096,
      temperature: temperature ?? 0.4,
    },
  };
  if (system) {
    body.systemInstruction = { role: 'user', parts: [{ text: system }] };
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Google ${res.status}: ${text.slice(0, 500)}`);
  }
  let usage = { input: 0, output: 0 };
  for await (const chunk of parseSseStream(res.body)) {
    if (!chunk.data) continue;
    let evt;
    try { evt = JSON.parse(chunk.data); } catch { continue; }
    const parts = evt.candidates?.[0]?.content?.parts || [];
    for (const p of parts) if (p.text) yield { type: 'text', delta: p.text };
    if (evt.usageMetadata) {
      usage.input = evt.usageMetadata.promptTokenCount || 0;
      usage.output = evt.usageMetadata.candidatesTokenCount || 0;
    }
  }
  yield { type: 'done', usage };
}

// ---- Public API ----------------------------------------------------------

export async function* streamText(opts) {
  const { provider } = opts;
  if (provider === 'anthropic') yield* streamAnthropic(opts);
  else if (provider === 'openai') yield* streamOpenAI(opts);
  else if (provider === 'google') yield* streamGoogle(opts);
  else throw new Error(`Unknown provider: ${provider}`);
}

export async function completeText(opts) {
  let text = '';
  let usage = { input: 0, output: 0 };
  for await (const chunk of streamText(opts)) {
    if (chunk.type === 'text') text += chunk.delta;
    else if (chunk.type === 'done') usage = chunk.usage;
  }
  return { text, usage };
}

// ---- SSE parser ----------------------------------------------------------
// Parses a Server-Sent Events stream from a fetch ReadableStream.
// Yields { event, data } per record.
async function* parseSseStream(body) {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n\n')) !== -1) {
        const record = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const lines = record.split('\n');
        let event = 'message';
        let data = '';
        for (const line of lines) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trimStart();
        }
        if (data) yield { event, data };
      }
    }
  } finally {
    reader.releaseLock();
  }
}
