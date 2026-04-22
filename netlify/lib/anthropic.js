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
  if (fenced) return JSON.parse(fenced[1]);
  // Find first [ or { and match to its counterpart
  const firstArr = text.indexOf('[');
  const firstObj = text.indexOf('{');
  const start = firstArr === -1 ? firstObj : (firstObj === -1 ? firstArr : Math.min(firstArr, firstObj));
  if (start === -1) throw new Error('No JSON found in response');
  const closer = text[start] === '[' ? ']' : '}';
  const end = text.lastIndexOf(closer);
  if (end === -1 || end < start) throw new Error('Unterminated JSON in response');
  return JSON.parse(text.slice(start, end + 1));
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
