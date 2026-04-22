/**
 * Anthropic wrapper — JS port of scripts/api_client.py.
 *
 * Responsibilities:
 *   1. Prompt caching — company profile + contract text marked ephemeral so
 *      every specialist after the first reads at a 90% discount.
 *   2. Usage tracking — records every call to the usage_events table via
 *      supabase-admin.recordUsage().
 *   3. Token ceiling — single-review budget (MAX_TOKENS_PER_REVIEW).
 *
 * Does NOT handle quota checks (that lives in supabase-admin.checkReviewQuota).
 */
import Anthropic from '@anthropic-ai/sdk';
import { MODEL_ID, MAX_TOKENS_PER_REVIEW } from './constants.js';
import { recordUsage } from './supabase-admin.js';

let client = null;
function anthropic() {
  if (client) return client;
  // Netlify's AI Gateway auto-injects a proxy JWT into ANTHROPIC_API_KEY
  // (prefix "eyJ..."), which overrides any value the user set. To keep
  // using our own key we read from LO_ANTHROPIC_API_KEY first, and only
  // fall back to ANTHROPIC_API_KEY if it actually looks like an Anthropic
  // direct key (`sk-ant-`).
  const lo = process.env.LO_ANTHROPIC_API_KEY;
  const fallback = process.env.ANTHROPIC_API_KEY;
  const key =
    (lo && lo.startsWith('sk-ant-')) ? lo :
    (fallback && fallback.startsWith('sk-ant-')) ? fallback :
    null;
  if (!key) {
    throw new Error(
      'No direct Anthropic API key found. Set LO_ANTHROPIC_API_KEY to your ' +
      'sk-ant-api03-... key. (Netlify auto-injects its AI Gateway JWT into ' +
      'ANTHROPIC_API_KEY, so that name cannot be used.)'
    );
  }
  // Netlify also injects ANTHROPIC_BASE_URL pointing at its AI Gateway.
  // The SDK picks that up automatically, which would route our sk-ant-
  // key to the gateway (401 no-body). Pin baseURL to api.anthropic.com
  // so we always talk to Anthropic directly.
  client = new Anthropic({ apiKey: key, baseURL: 'https://api.anthropic.com' });
  return client;
}

/**
 * Call a specialist agent. The profile + contract are placed in cacheable
 * blocks; the task prompt is uncached (per-specialist).
 *
 * Returns parsed JSON findings (or raw text for the classifier / configurator).
 *
 * @param {object} opts
 * @param {string} opts.agentName         — for usage tracking + logging
 * @param {string} opts.systemPrompt      — the agent's system prompt
 * @param {object} opts.profileJson       — the company_profiles row's profile_json
 * @param {string} opts.contractText      — extracted contract text
 * @param {string} opts.taskPrompt        — per-specialist task
 * @param {string} opts.userId            — for usage tracking
 * @param {string} opts.reviewId          — for usage tracking
 * @param {number} [opts.maxTokens=8192]  — response ceiling
 * @param {number} [opts.tokensUsedSoFar] — running total for this review
 */
export async function callSpecialist({
  agentName,
  systemPrompt,
  profileJson,
  contractText,
  taskPrompt,
  userId,
  reviewId,
  maxTokens = 8192,
  tokensUsedSoFar = 0,
}) {
  if (tokensUsedSoFar >= MAX_TOKENS_PER_REVIEW) {
    throw new Error(
      `Review token ceiling exceeded (${tokensUsedSoFar} / ${MAX_TOKENS_PER_REVIEW}). ` +
      'Aborting to prevent runaway cost.'
    );
  }

  const profileBlock = `COMPANY PROFILE (JSON):\n${JSON.stringify(profileJson, null, 2)}`;
  const contractBlock = `CONTRACT TEXT:\n${contractText}`;

  const response = await anthropic().messages.create({
    model: MODEL_ID,
    max_tokens: maxTokens,
    system: [
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: profileBlock, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: contractBlock, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: taskPrompt },
        ],
      },
    ],
  });

  // Record usage (best-effort; don't fail the call if logging fails)
  try {
    await recordUsage({
      userId,
      reviewId,
      agentName,
      usage: response.usage,
    });
  } catch (e) {
    console.error(`recordUsage failed for ${agentName}:`, e);
  }

  const text = response.content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n');

  return {
    text,
    usage: response.usage,
    stopReason: response.stop_reason,
  };
}

/**
 * Utility: extract a JSON array or object from a model response that may
 * include preface prose or markdown fencing. Tolerates:
 *   - ```json ... ``` fences
 *   - "Here is the extraction:\n[...]"
 *   - plain JSON
 */
export function extractJson(text) {
  // Strip markdown fences
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch (e) { /* fall through to repair */ }
  }
  // Find first [ or { and match to its counterpart
  const firstArr = text.indexOf('[');
  const firstObj = text.indexOf('{');
  const start = firstArr === -1 ? firstObj : (firstObj === -1 ? firstArr : Math.min(firstArr, firstObj));
  if (start === -1) throw new Error('No JSON found in response');

  const closer = text[start] === '[' ? ']' : '}';
  const end = text.lastIndexOf(closer);
  const candidate = end > start ? text.slice(start, end + 1) : text.slice(start);

  // Fast path: valid JSON as-is
  try { return JSON.parse(candidate); } catch (e) { /* attempt repair */ }

  // Slow path: model probably hit max_tokens mid-output. Walk the string,
  // stop at the last complete value, and close whatever is still open.
  const repaired = repairTruncatedJson(candidate);
  try {
    return JSON.parse(repaired);
  } catch (e) {
    throw new Error(`JSON parse failed even after repair: ${e.message}`);
  }
}

/**
 * Salvage JSON that was cut off mid-generation (the classic `max_tokens`
 * truncation). Walks the string tracking the bracket/string state, rewinds
 * to the last fully-complete element, trims trailing commas, and closes
 * all still-open arrays and objects.
 */
function repairTruncatedJson(s) {
  // Track: are we inside a string? which bracket stack are we in?
  // For each position we remember a "safe rollback" — the last index at which
  // we were at depth 0 inside a container with no pending partial element.
  const stack = []; // each entry: '[' or '{'
  let inString = false;
  let escape = false;
  let lastSafeEnd = -1; // index of the last completed element (exclusive)

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '[' || ch === '{') {
      stack.push(ch);
    } else if (ch === ']' || ch === '}') {
      stack.pop();
      lastSafeEnd = i + 1;
    } else if (ch === ',') {
      // Record position just before the comma as a safe rollback point.
      lastSafeEnd = i;
    }
  }

  // Rewind to the last safe point (strips the partial element at the end).
  let out = lastSafeEnd > 0 ? s.slice(0, lastSafeEnd) : s;
  // Trim trailing comma + whitespace
  out = out.replace(/,\s*$/, '');

  // Rebuild the open-bracket stack for the trimmed string so we close the
  // right number. We need to re-walk because the rewind may have closed
  // some brackets (shouldn't happen with lastSafeEnd logic, but belt-and-suspenders).
  const closeStack = [];
  let s2 = false, esc2 = false;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (esc2) { esc2 = false; continue; }
    if (ch === '\\' && s2) { esc2 = true; continue; }
    if (ch === '"') { s2 = !s2; continue; }
    if (s2) continue;
    if (ch === '[' || ch === '{') closeStack.push(ch);
    else if (ch === ']' || ch === '}') closeStack.pop();
  }
  while (closeStack.length) {
    const open = closeStack.pop();
    out += open === '[' ? ']' : '}';
  }
  return out;
}

/**
 * Simple (uncached) call — for the classifier, configurator chat turns,
 * playbook ingestor, and anywhere a fresh call is fine.
 */
export async function callModel({
  agentName,
  systemPrompt,
  userMessage,
  userId,
  reviewId = null,
  maxTokens = 4096,
}) {
  const response = await anthropic().messages.create({
    model: MODEL_ID,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  try {
    await recordUsage({
      userId,
      reviewId,
      agentName,
      usage: response.usage,
    });
  } catch (e) {
    console.error(`recordUsage failed for ${agentName}:`, e);
  }

  const text = response.content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n');

  return { text, usage: response.usage, stopReason: response.stop_reason };
}
