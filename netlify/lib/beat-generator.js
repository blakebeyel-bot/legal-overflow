/**
 * Beat generator — produces 6 short status phrases tailored to the
 * user's specific legal-research question. The phrases rotate as
 * the spinner indicator's heartbeat while the model is reasoning,
 * giving the user a sense of "what the LLM is actually doing"
 * instead of generic stand-in text.
 *
 * Trade-offs:
 *   - Adds one small LLM call per chat send (~50–200 tokens out).
 *     Negligible cost, ~500-1200ms latency, but runs IN PARALLEL
 *     with pre-grounding so it doesn't extend the user-visible wait.
 *   - On any failure (network, parse, timeout) the caller falls back
 *     to a static generic list. Never blocks the chat.
 *
 * Pure ESM, runtime-portable. Caller passes provider + model + key.
 */

const SYSTEM = `You generate short status phrases describing what an AI legal-research assistant is currently working on while answering a user's question. The phrases will rotate as a "what we're doing right now" indicator in a chat UI — like Claude's or ChatGPT's animated thinking line.

Output exactly 6 phrases. Each phrase:
- 4–9 words
- Ends with an ellipsis (…)
- Uses legal-research vocabulary specifically tied to the question
- Describes a distinct internal phase: issue spotting → primary-authority retrieval → case-law cross-reference → analysis → drafting → polishing
- Reads like the internal monologue of an associate working through the question
- Mentions specific statutes, doctrines, or topics from the question when relevant
- NO numbering, NO bullet points, NO preamble, NO explanation, NO closing text

Example for "What's the statute of limitations for negligence in Florida?":
Identifying the governing limitations statute…
Locating Fla. Stat. § 95.11 within Chapter 95…
Cross-referencing tort-tolling case law…
Analyzing accrual rules for negligence claims…
Drafting the limitations analysis…
Polishing the citation form…`;

// Reasoning models (Grok 4 reasoning, OpenAI o-series, etc.) burn
// time on internal thought before responding. Generous timeout so
// the beat-gen call can finish even when the user's main model is
// a slow reasoner.
const TIMEOUT_MS = 15_000;

const FALLBACK_BEATS = [
  'Cross-referencing primary authority…',
  'Drafting the response…',
  'Composing the analysis…',
  'Reading across sources…',
  'Polishing the draft…',
  'Reasoning over the question…',
];

function buildUserPrompt(query, state) {
  return `User question: "${String(query).slice(0, 1500)}"\n${state ? `Jurisdiction: ${state}\n` : ''}\nOutput the 6 phrases, one per line.`;
}

function parseBeats(text) {
  if (!text) return null;
  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    // Strip any leading numbering, bullets, or quotes
    .map((l) => l.replace(/^[\d.\-*•"'\s]+/, '').replace(/["'\s]+$/, '').trim())
    .filter((l) => l.length >= 4 && l.length <= 100);
  if (lines.length < 4) return null;
  // Ensure trailing ellipsis on each
  return lines.slice(0, 6).map((l) => /[…\.]\s*$/.test(l) ? l.replace(/\.{1,3}\s*$/, '…') : `${l}…`);
}

async function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

/**
 * Generate 6 status phrases tailored to the user's question.
 * Returns FALLBACK_BEATS on any failure.
 */
export async function generateContextualBeats({ query, state, provider, model, apiKey, fetchImpl }) {
  if (!query || !provider || !apiKey) return FALLBACK_BEATS;
  const f = fetchImpl || globalThis.fetch;
  const userPrompt = buildUserPrompt(query, state);

  try {
    let raw = '';
    if (provider === 'anthropic') {
      const r = await withTimeout(f('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          temperature: 0.7,
          system: SYSTEM,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      }), TIMEOUT_MS);
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        console.warn(`[beat-gen] anthropic ${r.status}: ${txt.slice(0, 200)}`);
        return FALLBACK_BEATS;
      }
      const j = await r.json();
      raw = (j.content || []).map((b) => b.text || '').join('\n');
    } else if (provider === 'openai') {
      const r = await withTimeout(f('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          max_completion_tokens: 1024,
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: userPrompt },
          ],
        }),
      }), TIMEOUT_MS);
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        console.warn(`[beat-gen] openai ${r.status}: ${txt.slice(0, 200)}`);
        return FALLBACK_BEATS;
      }
      const j = await r.json();
      raw = j.choices?.[0]?.message?.content || '';
    } else if (provider === 'xai') {
      // xAI Responses API — single non-streaming call. Reasoning
      // models eat tokens for internal thinking, so budget bigger.
      const r = await withTimeout(f('https://api.x.ai/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          instructions: SYSTEM,
          input: userPrompt,
          max_output_tokens: 1024,
          temperature: 0.7,
        }),
      }), TIMEOUT_MS);
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        console.warn(`[beat-gen] xai ${r.status}: ${txt.slice(0, 200)}`);
        return FALLBACK_BEATS;
      }
      const j = await r.json();
      // Responses API output is in `output` array of items, each with content array
      const output = j.output || [];
      for (const item of output) {
        if (item?.content) {
          for (const c of item.content) {
            if ((c.type === 'output_text' || c.type === 'text') && c.text) raw += c.text;
          }
        } else if (typeof item?.text === 'string') {
          raw += item.text;
        }
      }
      // Some non-streaming Responses-API shapes put text under
      // `output_text` directly — handle that too.
      if (!raw && typeof j.output_text === 'string') raw = j.output_text;
      if (!raw) {
        console.warn('[beat-gen] xai output empty. shape:', JSON.stringify(j).slice(0, 400));
      }
    } else if (provider === 'google') {
      const r = await withTimeout(f(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { role: 'user', parts: [{ text: SYSTEM }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: { maxOutputTokens: 240, temperature: 0.7 },
          safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_CIVIC_INTEGRITY',   threshold: 'BLOCK_NONE' },
          ],
        }),
      }), TIMEOUT_MS);
      if (!r.ok) return FALLBACK_BEATS;
      const j = await r.json();
      raw = j.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    }
    const parsed = parseBeats(raw);
    if (!parsed || parsed.length < 4) {
      console.warn(`[beat-gen] parse failed for provider=${provider} model=${model}. raw=${JSON.stringify(raw).slice(0, 300)}`);
      return FALLBACK_BEATS;
    }
    return parsed;
  } catch (err) {
    console.warn(`[beat-gen] threw for provider=${provider} model=${model}: ${err?.message || err}`);
    return FALLBACK_BEATS;
  }
}

export { FALLBACK_BEATS };
