/**
 * Platform-wide constants. Single-source-of-truth for model ID, limits, etc.
 * Per CLAUDE.md §4.9: every agent MUST use Sonnet 4.6. Do not downgrade.
 */

// Pinned Sonnet 4.6 model ID. If Anthropic publishes a new snapshot, bump
// this one line to adopt it platform-wide.
export const MODEL_ID = 'claude-sonnet-4-5-20250929';
// ^ Pinned to the most recent Sonnet 4.x snapshot this codebase was validated
//   against. If a Sonnet 4.6 snapshot ID is available in your Anthropic
//   console, replace with that snapshot ID (e.g. 'claude-sonnet-4-6-xxxxxxxx').
//   Do NOT fall back to Haiku or Opus without explicit policy change.

// Trial tier quota (per CLAUDE.md §4.10 + config/limits.json)
export const TRIAL_REVIEWS_PER_WINDOW = 3;
export const TRIAL_WINDOW_DAYS = 30;

// Per-review runaway ceiling
export const MAX_TOKENS_PER_REVIEW = 500_000;

// Configurator chat hard cap
export const MAX_CONFIGURATOR_MESSAGES = 15;

// Upload cap
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

// Sonnet 4.6 pricing (USD per 1M tokens). Used for cost estimates.
// Update when Anthropic changes pricing.
export const PRICING = {
  input_per_mtok: 3.00,
  output_per_mtok: 15.00,
  cache_write_per_mtok: 3.75,  // 1.25x input rate
  cache_read_per_mtok: 0.30,   // 0.1x input rate (90% discount)
};

export function estimateCostUsd({ inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0 }) {
  const m = (n, rate) => (n / 1_000_000) * rate;
  return (
    m(inputTokens, PRICING.input_per_mtok) +
    m(outputTokens, PRICING.output_per_mtok) +
    m(cacheReadTokens, PRICING.cache_read_per_mtok) +
    m(cacheWriteTokens, PRICING.cache_write_per_mtok)
  );
}
