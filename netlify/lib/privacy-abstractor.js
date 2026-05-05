/**
 * Privacy abstractor — rewrites client-specific legal text as an
 * abstract hypothetical for LLM research.
 *
 * The lawyer types raw client facts ("My client Joe Smith was fired
 * by Acme Corp last March…"); this module converts to abstract
 * hypothetical form ("An employee at a corporation was terminated
 * last year…") before any of it touches the main research LLM.
 *
 * Critical invariants:
 *   - FAIL CLOSED on any error. The caller is responsible for
 *     rejecting the user's request rather than falling through to
 *     send the raw message. This module throws — it never returns
 *     the original text.
 *   - Uses the same provider/model as the user's main chat so the
 *     raw text only crosses to ONE provider (the one they BYOK'd).
 *   - 15s timeout. Reasoning models (Grok-reasoning, OpenAI o-series)
 *     burn time on internal thinking; budget accordingly.
 *
 * Pure ESM, runtime-portable (Deno edge + Node functions).
 */

const SYSTEM = `You are a legal-research privacy filter. Rewrite legal questions and documents into ABSTRACT HYPOTHETICALS that preserve the legal issue but strip every detail that could identify a specific client, party, matter, or dispute.

REMOVE every:
- Person name → replace with role ("the CFO", "the plaintiff", "the buyer", "the employee", "the trustee")
- Entity name (companies, firms, agencies) → replace with generic ("a corporation", "an insurance company", "a Tampa-area employer", "a federal agency", "a midsize tech firm")
- Street address, building name, neighborhood → replace with regional descriptor only when locale matters legally ("a Florida residence", "a commercial property in a major city")
- Specific date → replace with relative reference ("last year", "earlier this year", "in 2023")
- Specific dollar amount → replace with order of magnitude ("a six-figure sum", "approximately $1M", "a substantial settlement")
- Phone number, email, SSN, EIN, account number, license number, case caption, docket number, file number → strip entirely; do not replace
- Any other detail that, if disclosed, would identify the client or matter

PRESERVE:
- The legal issue and cause of action
- Jurisdiction (state matters legally)
- Statutes, regulations, rules, treaties cited
- Procedural posture
- General industry context if relevant
- Roles and relationships ("the employer", "the contractor", "the trustee", "the licensee")
- General fact pattern (sequence of events, with abstracted details)

The result must read as a clean legal hypothetical — the kind a junior associate would phrase when discussing a matter with a senior partner without revealing client identity.

Output only the rewritten text. No preamble, no explanation, no notes about what you removed, no "here is the rewritten version" framing. Just the hypothetical.`;

// Generous timeout — reasoning models can take time, and we're
// asking for a substantive rewrite, not a short classification.
const TIMEOUT_MS = 30_000;

async function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('abstractor timeout')), ms)),
  ]);
}

/**
 * Abstract a single piece of text. Throws on any failure.
 *
 * @param {object} opts
 * @param {string} opts.text         — raw text to abstract
 * @param {string} opts.provider     — 'anthropic' | 'openai' | 'google' | 'xai'
 * @param {string} opts.model        — model id to use (same as the user's main chat)
 * @param {string} opts.apiKey
 * @param {function} [opts.fetchImpl]
 * @returns {Promise<string>}        — the abstracted text
 * @throws on any error (network / HTTP / parse / empty output)
 */
export async function abstractContent({ text, provider, model, apiKey, fetchImpl }) {
  if (!text || !text.trim()) {
    // Nothing to abstract — return empty (safe).
    return '';
  }
  if (!provider || !apiKey) {
    throw new Error('abstractor requires provider + apiKey');
  }
  const f = fetchImpl || globalThis.fetch;
  const userMsg = `Rewrite the following as an abstract legal hypothetical per the rules above. Keep the rewrite roughly the same length unless removing identifiers makes it shorter.\n\n${text}`;

  let raw = '';
  if (provider === 'anthropic') {
    const r = await withTimeout(f('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        temperature: 0.2,        // low — we want consistent rewrites
        system: SYSTEM,
        messages: [{ role: 'user', content: userMsg }],
      }),
    }), TIMEOUT_MS);
    if (!r.ok) {
      throw new Error(`abstractor anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    const j = await r.json();
    raw = (j.content || []).map((b) => b.text || '').join('\n');
  } else if (provider === 'openai') {
    const r = await withTimeout(f('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_completion_tokens: 4096,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: userMsg },
        ],
      }),
    }), TIMEOUT_MS);
    if (!r.ok) {
      throw new Error(`abstractor openai ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    const j = await r.json();
    raw = j.choices?.[0]?.message?.content || '';
  } else if (provider === 'xai') {
    const r = await withTimeout(f('https://api.x.ai/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        instructions: SYSTEM,
        input: userMsg,
        max_output_tokens: 4096,
        temperature: 0.2,
      }),
    }), TIMEOUT_MS);
    if (!r.ok) {
      throw new Error(`abstractor xai ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    const j = await r.json();
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
    if (!raw && typeof j.output_text === 'string') raw = j.output_text;
  } else if (provider === 'google') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const r = await withTimeout(f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { role: 'user', parts: [{ text: SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: userMsg }] }],
        generationConfig: { maxOutputTokens: 4096, temperature: 0.2 },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_CIVIC_INTEGRITY',   threshold: 'BLOCK_NONE' },
        ],
      }),
    }), TIMEOUT_MS);
    if (!r.ok) {
      throw new Error(`abstractor google ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    const j = await r.json();
    raw = j.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  } else {
    throw new Error(`abstractor: unknown provider ${provider}`);
  }

  const cleaned = String(raw || '').trim();
  if (!cleaned) {
    throw new Error('abstractor returned empty output');
  }
  // Defensive sanity check: the rewrite shouldn't be vastly longer
  // than the input (sign of model misbehaving and adding commentary).
  // Allow up to 1.5× original length.
  if (cleaned.length > Math.max(2000, text.length * 1.5)) {
    // Trim any model preamble like "Here is the rewrite:" if present.
    const trimmed = cleaned.replace(/^(?:here(?:'s| is)|the rewritten|rewrite|abstracted version)[^:]*:\s*/i, '').trim();
    return trimmed.slice(0, Math.max(2500, text.length * 1.5));
  }
  return cleaned;
}
