/**
 * Template detection — given a vault item's text content, decide
 * whether it looks like a fillable legal template, and if so what its
 * variable fields are.
 *
 * Two-stage pipeline:
 *   1. CHEAP HEURISTIC — regex scan for placeholder syntax + structural
 *      signals. If hits exceed a threshold we already know it's a
 *      template AND we have a starter list of fields. The model pass
 *      then ONLY runs to clean up labels / types / hints. If the
 *      heuristic finds zero hits, the model pass acts as a fallback
 *      for templates that use plain English ("Insert client name
 *      here") with no obvious markers.
 *
 *   2. MODEL PASS (Claude Haiku 4.5, Gemini Flash 2.5 fallback) on
 *      the first ~3000 chars of content. Returns the canonical
 *      schema we'll store on the vault row.
 *
 * Failure mode: any error here is logged and swallowed. The vault
 * item stays as a regular document. Auto-detect is a UX upgrade, not
 * a blocker.
 */

import { resolveProviderKey } from './byok-keys.js';

const DETECT_MODEL_ANTHROPIC = 'claude-haiku-4-5';
const DETECT_MODEL_GEMINI = 'gemini-2.5-flash';
const DETECT_TIMEOUT_MS = 30_000;
const SAMPLE_CHARS = 3000;

// Heuristic markers — both the literal placeholder forms users write
// AND the structural signals that almost always indicate a template
// rather than a finished document.
const PLACEHOLDER_PATTERNS = [
  /\{\{\s*[\w.\-]+\s*\}\}/g,           // {{var}}
  /\[\s*[A-Z][A-Z _\-/]{2,40}\s*\]/g,  // [CLIENT NAME], [INSERT DATE]
  /<<\s*[\w.\-\s]+\s*>>/g,             // <<var>>
  /_{4,}/g,                            // ____________
  /\bN\/A\b/g,                         // weak signal — not counted alone
];

const STRUCTURAL_SIGNALS = [
  /\bINSERT\b/i,
  /\bSIGNATURE\b/i,
  /\bDATED:\s*$/m,
  /\bBY:\s*$/m,
  /\bATTORNEYS? FOR\b/i,
  /\bSTATE OF\b\s*[_]+/i,
  /\bCOUNTY OF\b\s*[_]+/i,
  /__________\s*\n\s*Print(ed)? Name/i,
];

const ANTI_SIGNALS = [
  /\bEXECUTED VERSION\b/i,
  /\bFINAL\b/i,
  /\bv\d+\.\d+\b/i,                    // version markers
];

/**
 * Run the heuristic phase against text. Returns hit counts + a list
 * of placeholder strings found. Cheap — no model call.
 */
export function heuristicScan(text) {
  if (!text) return { hits: 0, structural: 0, antiHits: 0, placeholders: [] };
  const sample = text.slice(0, 20_000);
  let hits = 0;
  const placeholders = new Set();
  for (const pat of PLACEHOLDER_PATTERNS) {
    const matches = sample.match(pat) || [];
    hits += matches.length;
    for (const m of matches) placeholders.add(m.trim());
  }
  let structural = 0;
  for (const pat of STRUCTURAL_SIGNALS) {
    if (pat.test(sample)) structural += 1;
  }
  let antiHits = 0;
  for (const pat of ANTI_SIGNALS) {
    if (pat.test(sample)) antiHits += 1;
  }
  return { hits, structural, antiHits, placeholders: [...placeholders] };
}

/**
 * Decide whether to call the model. Returns:
 *   { proceed: bool, confidence: 0-1, reason: string }
 *
 * Logic:
 *   - >=3 placeholder hits + structural signals → high confidence template
 *   - >=1 placeholder hit + low anti-signals → worth a model check
 *   - Zero hits + multiple structural signals → could be a template without
 *     explicit markers; let the model decide
 *   - Anti-signals dominant → skip; almost certainly a finished doc
 */
export function shouldDetect(scan) {
  const { hits, structural, antiHits } = scan;
  if (antiHits >= 2 && hits === 0) {
    return { proceed: false, confidence: 0.05, reason: 'finished-doc signals dominate' };
  }
  if (hits >= 3) {
    return { proceed: true, confidence: 0.85, reason: `${hits} placeholder hits` };
  }
  if (hits >= 1 || structural >= 2) {
    return { proceed: true, confidence: 0.4, reason: 'partial signals' };
  }
  return { proceed: false, confidence: 0.1, reason: 'no template signals' };
}

function buildDetectPrompt({ text, heuristicPlaceholders }) {
  const sample = String(text || '').slice(0, SAMPLE_CHARS);
  const phHint = heuristicPlaceholders.length
    ? `\n\nHEURISTIC ALREADY FOUND THESE PLACEHOLDER STRINGS — incorporate them into your "vars" output if relevant:\n${heuristicPlaceholders.slice(0, 30).join(', ')}\n`
    : '';
  return `You're inspecting a document the user just uploaded to a legal-document vault, to decide whether it's a TEMPLATE meant to be filled in for each new matter, vs. a finished one-off document.

Strong template signals:
- Repeated placeholder patterns: {{var}}, [BRACKETED CAPS], <<var>>, or _______ blanks
- Letterhead at top with no client-specific details below
- Signature blocks with empty signature/date/printed-name lines
- Phrases like "[Insert ...]" or "[Client to provide ...]"
- Generic section headings with no actual specifics filled in

Anti-signals (point AWAY from template):
- Specific dates, dollar amounts, real party names sprinkled throughout
- Page numbers indicating a multi-revision finished document
- "EXECUTED VERSION", "FINAL", or version numbers in the header

Return STRICT JSON only — no markdown, no preamble:
{
  "is_template": boolean,
  "confidence": number between 0 and 1,
  "vars": [
    {
      "key": "snake_case_identifier",
      "label": "Human-readable label (Title Case)",
      "type": "text" | "longtext" | "date" | "currency" | "percent" | "state" | "party_block" | "signature_block",
      "hint": "Where this appears or what it represents (one short sentence)",
      "placeholder_text": "The exact placeholder text as it appears in the document",
      "occurrences": integer
    }
  ]
}

Rules for vars:
- 0 to 25 entries — quality over coverage
- Sort by importance (the variable that matters most first)
- Deduplicate (don't list the same field twice)
- "longtext" for multi-paragraph clauses; "text" for single line values
- "party_block" for a full name+address+role group
- "signature_block" for a signature+printed-name+date trio
- Pick the type that most cleanly maps to the field's role${phHint}

DOCUMENT CONTENT (first ${SAMPLE_CHARS} chars):
<<<
${sample}
>>>

Respond with the JSON only.`;
}

async function callDetectAnthropic({ prompt, apiKey }) {
  if (!apiKey) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), DETECT_TIMEOUT_MS);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: DETECT_MODEL_ANTHROPIC,
        max_tokens: 2000,
        temperature: 0.1,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: ctl.signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.warn(`[template-detect] Anthropic ${r.status}: ${txt.slice(0, 200)}`);
      return null;
    }
    const j = await r.json();
    return j?.content?.[0]?.text || null;
  } catch (err) {
    console.warn('[template-detect] Anthropic failed:', err?.message || err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function callDetectGemini({ prompt, apiKey }) {
  if (!apiKey) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${DETECT_MODEL_GEMINI}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), DETECT_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 2000,
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
      console.warn(`[template-detect] Gemini ${r.status}: ${txt.slice(0, 200)}`);
      return null;
    }
    const j = await r.json();
    return j?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (err) {
    console.warn('[template-detect] Gemini failed:', err?.message || err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse + sanitize the model's JSON output. Returns either a clean
 * schema object or null on any parse failure.
 */
function parseSchema(rawText) {
  if (!rawText) return null;
  // Models occasionally wrap JSON in markdown fences despite being told
  // not to. Strip the fences before parse.
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
  if (!parsed || typeof parsed !== 'object') return null;

  const isTemplate = !!parsed.is_template;
  const confidence = Math.min(1, Math.max(0, Number(parsed.confidence) || 0));
  const vars = Array.isArray(parsed.vars) ? parsed.vars : [];

  const validTypes = new Set(['text', 'longtext', 'date', 'currency', 'percent', 'state', 'party_block', 'signature_block']);
  const seenKeys = new Set();
  const cleanVars = [];
  for (const v of vars.slice(0, 25)) {
    if (!v || typeof v !== 'object') continue;
    let key = String(v.key || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    if (!key) continue;
    if (seenKeys.has(key)) {
      // De-dup by suffixing — preserves the model's intent without dropping
      let i = 2;
      while (seenKeys.has(`${key}_${i}`)) i += 1;
      key = `${key}_${i}`;
    }
    seenKeys.add(key);
    const type = validTypes.has(v.type) ? v.type : 'text';
    cleanVars.push({
      key,
      label: String(v.label || key).trim().slice(0, 120),
      type,
      hint: String(v.hint || '').trim().slice(0, 300),
      placeholder_text: String(v.placeholder_text || '').trim().slice(0, 200),
      occurrences: Math.max(1, Math.min(999, parseInt(v.occurrences, 10) || 1)),
    });
  }

  return {
    is_template: isTemplate,
    confidence,
    vars: cleanVars,
  };
}

/**
 * Main entry — detect whether a piece of content is a template and
 * return the canonical schema. Returns:
 *   {
 *     is_template: boolean,
 *     confidence: 0-1,
 *     vars: [...],
 *     model_used: string | null,
 *     heuristic: { hits, structural, antiHits, placeholders }
 *   }
 *
 * Always returns an object even on failure — the caller can decide
 * whether to act on it based on confidence.
 */
export async function detectTemplate({ text, userId = null }) {
  const scan = heuristicScan(text);
  const gate = shouldDetect(scan);

  // Hard skip — finished-doc signals dominate, save the model call.
  if (!gate.proceed) {
    return {
      is_template: false,
      confidence: gate.confidence,
      vars: [],
      model_used: null,
      heuristic: scan,
      skip_reason: gate.reason,
    };
  }

  const prompt = buildDetectPrompt({ text, heuristicPlaceholders: scan.placeholders });
  // BYOK-first: try the user's stored Anthropic / Google keys, then
  // fall back to server env via resolveProviderKey. If userId is null
  // (legacy callers), resolveProviderKey transparently skips the user
  // lookup and returns the server key.
  const anthropicResolved = await resolveProviderKey({ userId, provider: 'anthropic' });
  const geminiResolved = await resolveProviderKey({ userId, provider: 'google' });
  const anthropicKey = anthropicResolved.key || '';
  const geminiKey = geminiResolved.key || '';

  let rawText = null;
  let modelUsed = null;
  if (anthropicKey) {
    rawText = await callDetectAnthropic({ prompt, apiKey: anthropicKey });
    if (rawText) modelUsed = DETECT_MODEL_ANTHROPIC;
  }
  if (!rawText && geminiKey) {
    rawText = await callDetectGemini({ prompt, apiKey: geminiKey });
    if (rawText) modelUsed = DETECT_MODEL_GEMINI;
  }

  if (!rawText) {
    return {
      is_template: false,
      confidence: 0,
      vars: [],
      model_used: null,
      heuristic: scan,
      skip_reason: 'no model key available or call failed',
    };
  }

  const parsed = parseSchema(rawText);
  if (!parsed) {
    return {
      is_template: false,
      confidence: 0,
      vars: [],
      model_used: modelUsed,
      heuristic: scan,
      skip_reason: 'unparseable model output',
    };
  }

  // Blend the heuristic confidence with the model's. Heuristic floor
  // catches obvious templates the model might wobble on.
  const blended = Math.max(parsed.confidence, gate.confidence * 0.9);

  return {
    is_template: parsed.is_template,
    confidence: blended,
    vars: parsed.vars,
    model_used: modelUsed,
    heuristic: scan,
  };
}

/**
 * Fire-and-forget kick to the template-detect-background function.
 * Used by the two vault-ingest paths (library-register, doc-extract-
 * background) right after addVaultItem completes. Failure is logged
 * and swallowed — detection is a UX upgrade, not a blocker.
 *
 * Guarded on content length — very short docs (< 400 chars) are
 * almost never templates and aren't worth a model call.
 */
export function kickTemplateDetect({ itemId, userId, contentLen }) {
  if (!itemId || !userId) return;
  if (typeof contentLen === 'number' && contentLen < 400) return;
  const base = process.env.URL || process.env.DEPLOY_URL || 'http://localhost:8888';
  const url = `${base}/.netlify/functions/template-detect-background`;
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Trigger': 'template-detect' },
    body: JSON.stringify({ item_id: itemId, user_id: userId }),
  }).catch((err) => console.warn('[template-detect] kick failed:', err?.message || err));
}

