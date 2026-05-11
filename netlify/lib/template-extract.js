/**
 * Template extraction — given a piece of source content (typically a
 * chat assistant message) and a template's variable schema, ask a fast
 * model to map content → field values, returning strict JSON.
 *
 * Used by the template-render endpoint after the user clicks
 * "Use in template" on a chat bubble. Also used at refinement time
 * when the user asks to update specific fields.
 *
 * Returns: { values: { key: value, ... }, model_used: string|null }
 */

const EXTRACT_MODEL_ANTHROPIC = 'claude-haiku-4-5';
const EXTRACT_MODEL_GEMINI = 'gemini-2.5-flash';
const EXTRACT_TIMEOUT_MS = 30_000;

function buildExtractPrompt({ vars, content, existingValues, focusKey }) {
  const fieldList = vars.map((v) => {
    const typeHint = v.type === 'longtext'
      ? 'multi-paragraph text'
      : v.type === 'date'
        ? 'date in YYYY-MM-DD form'
        : v.type === 'currency'
          ? 'dollar amount as a string with no comma separators (e.g. "5000.00")'
          : v.type === 'percent'
            ? 'percentage as a number (e.g. "8.5")'
            : v.type === 'state'
              ? 'US state name or 2-letter postal code'
              : v.type === 'party_block'
                ? 'full party block (name + address + role) as a single string with line breaks'
                : v.type === 'signature_block'
                  ? 'a signature block with name + title + date'
                  : 'single line of text';
    return `  - "${v.key}" (${v.type}, ${typeHint}): ${v.label}${v.hint ? ` — ${v.hint}` : ''}`;
  }).join('\n');

  const existingNote = existingValues && Object.keys(existingValues).length
    ? `\n\nVALUES ALREADY PROVIDED — do NOT overwrite unless the source content clearly supersedes them:\n${JSON.stringify(existingValues, null, 2)}\n`
    : '';

  const focusNote = focusKey
    ? `\n\nFOCUS: The user wants to refine ONE field — "${focusKey}". Only return a value for that field. Leave all others null.\n`
    : '';

  return `You are extracting structured values from source content to fill a legal-document template.

TEMPLATE FIELDS:
${fieldList}

SOURCE CONTENT (chat response or user-provided text):
<<<
${String(content || '').slice(0, 8000)}
>>>${existingNote}${focusNote}

INSTRUCTIONS:
1. Read the source content and decide what value each template field should have.
2. ONLY use information present in the source content. Do NOT invent.
3. If the source doesn't speak to a field, return null for that key.
4. Format types correctly per the field type (dates as YYYY-MM-DD, currency as plain number-strings, etc.).
5. Return STRICT JSON only — no markdown fences, no preamble:

{
  "values": {
    "field_key_1": "value or null",
    "field_key_2": "value or null"
  }
}

Respond with the JSON only.`;
}

async function callAnthropic({ prompt, apiKey }) {
  if (!apiKey) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), EXTRACT_TIMEOUT_MS);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: EXTRACT_MODEL_ANTHROPIC,
        max_tokens: 4000,
        temperature: 0.1,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: ctl.signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.warn(`[template-extract] Anthropic ${r.status}: ${txt.slice(0, 200)}`);
      return null;
    }
    const j = await r.json();
    return j?.content?.[0]?.text || null;
  } catch (err) {
    console.warn('[template-extract] Anthropic failed:', err?.message || err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function callGemini({ prompt, apiKey }) {
  if (!apiKey) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EXTRACT_MODEL_GEMINI}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), EXTRACT_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 4000,
          responseMimeType: 'application/json',
        },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_CIVIC_INTEGRITY',   threshold: 'BLOCK_NONE' },
        ],
      }),
      signal: ctl.signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.warn(`[template-extract] Gemini ${r.status}: ${txt.slice(0, 200)}`);
      return null;
    }
    const j = await r.json();
    return j?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (err) {
    console.warn('[template-extract] Gemini failed:', err?.message || err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseValues(rawText, vars) {
  if (!rawText) return null;
  const cleaned = String(rawText)
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  const incoming = parsed && parsed.values && typeof parsed.values === 'object' ? parsed.values : parsed;
  if (!incoming || typeof incoming !== 'object') return null;
  // Whitelist to the schema keys + light type coercion.
  const out = {};
  const validKeys = new Set((vars || []).map((v) => v.key));
  for (const k of Object.keys(incoming)) {
    if (!validKeys.has(k)) continue;
    let v = incoming[k];
    if (v === null || v === undefined) {
      out[k] = null;
      continue;
    }
    if (typeof v === 'object') v = JSON.stringify(v);
    out[k] = String(v).slice(0, 10000);
  }
  return out;
}

/**
 * Extract values from content using the schema.
 *
 * @param {object} opts
 * @param {Array}  opts.vars             — template_schema.vars
 * @param {string} opts.content          — source text to read from
 * @param {object} [opts.existingValues] — values already filled (won't overwrite)
 * @param {string} [opts.focusKey]       — only fill this one key (refinement)
 * @returns {Promise<{ values: object, model_used: string|null }>}
 */
export async function extractValues({ vars, content, existingValues = null, focusKey = null }) {
  if (!Array.isArray(vars) || vars.length === 0) {
    return { values: {}, model_used: null };
  }
  if (!content || !String(content).trim()) {
    return { values: existingValues || {}, model_used: null };
  }

  const prompt = buildExtractPrompt({ vars, content, existingValues, focusKey });
  const anthropicKey = process.env.LO_ANTHROPIC_API_KEY
    || process.env.ANTHROPIC_API_KEY
    || '';
  const geminiKey = process.env.GOOGLE_AI_API_KEY || '';

  let rawText = null;
  let modelUsed = null;
  if (anthropicKey) {
    rawText = await callAnthropic({ prompt, apiKey: anthropicKey });
    if (rawText) modelUsed = EXTRACT_MODEL_ANTHROPIC;
  }
  if (!rawText && geminiKey) {
    rawText = await callGemini({ prompt, apiKey: geminiKey });
    if (rawText) modelUsed = EXTRACT_MODEL_GEMINI;
  }

  if (!rawText) {
    return { values: existingValues || {}, model_used: null };
  }

  const parsed = parseValues(rawText, vars);
  if (!parsed) {
    return { values: existingValues || {}, model_used: modelUsed };
  }

  // Merge with existing: NEW non-null values win, but never wipe an
  // existing value with null unless the caller is focusing a key.
  const merged = { ...(existingValues || {}) };
  for (const [k, v] of Object.entries(parsed)) {
    if (v === null && !focusKey) continue;       // don't blank existing
    if (v !== null && v !== undefined) merged[k] = v;
    else if (focusKey && k === focusKey) merged[k] = null;
  }
  return { values: merged, model_used: modelUsed };
}
