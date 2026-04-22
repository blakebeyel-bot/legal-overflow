/**
 * Agent + config loader.
 *
 * Reads from the pre-baked bundle at netlify/lib/agents-data.js — which
 * scripts/build-agents-bundle.mjs regenerates from netlify/agents/*.md
 * and netlify/config/*.json at build time. This avoids runtime fs access
 * to those files, which caused EBUSY races when 6 Netlify Functions
 * bundled in parallel on Windows.
 *
 * If you edit an agent prompt or config, re-run `node scripts/build-agents-bundle.mjs`.
 * `npm run build` does this automatically.
 */
import { AGENTS, CONFIGS } from './agents-data.js';

export function loadAgents() {
  return AGENTS;
}

export function getAgent(name) {
  const agent = AGENTS[name];
  if (!agent) {
    throw new Error(`Agent '${name}' not found. Available: ${Object.keys(AGENTS).join(', ')}`);
  }
  return agent;
}

export function loadConfig(name) {
  // Accept either "agent_registry" or "agent_registry.json"
  const key = name.replace(/\.json$/, '');
  const cfg = CONFIGS[key];
  if (!cfg) {
    throw new Error(`Config '${name}' not found. Available: ${Object.keys(CONFIGS).join(', ')}`);
  }
  return cfg;
}
