/**
 * Party-detection pre-pass.
 *
 * Runs once per review, immediately after classification, BEFORE the user
 * confirms and the specialists fan out. Reads the first ~6,000 characters
 * of the contract text and extracts the parties along with each party's
 * Defined Term (the parenthetical capitalized label the contract uses
 * thereafter — "Supplier", "Customer", "Provider", "Vendor", etc.).
 *
 * The detected list flows into the intake UI's party picker. The user
 * picks which party they represent; the selection becomes
 * CLIENT_DEFINED_TERM in the specialist context.
 *
 * Failure mode: returns an empty array. The intake form falls back to
 * the legacy free-text role picker so the review is never blocked by a
 * party-detection failure.
 */
import { callModel, extractJson } from './anthropic.js';

const SYSTEM_PROMPT = `You are a contract parser. Given a contract excerpt, identify the parties to the agreement and the Defined Term each party is given. Output ONLY a JSON object — no markdown fences, no commentary.

A "Defined Term" is the short, capitalized label the contract introduces for each party in a parenthetical, typically near the top — examples:

  "ACME Corp. ('Buyer')"            → defined_term: "Buyer"
  "Crane Industries Inc. (the 'Supplier')" → defined_term: "Supplier"
  "Lattice, Inc. (\"Provider\")"     → defined_term: "Provider"

If a party has no clear Defined Term, use a sensible label inferred from context ("Customer", "Vendor", "Contractor"). Do not invent legal-entity names — if you cannot find one, leave name empty.

OUTPUT SCHEMA:
{
  "parties": [
    { "name": "<legal entity name as written>", "defined_term": "<the capitalized short label>", "role_hint": "<one of: provider | recipient | unknown>" }
  ]
}

role_hint guidance:
  "provider"  — the party performing services, supplying goods, licensing IP, etc. (Supplier, Vendor, Provider, Contractor, Licensor, Subcontractor, Consultant)
  "recipient" — the party paying for or receiving services/goods/licenses (Customer, Buyer, Client, Licensee, Owner)
  "unknown"   — cannot tell from the excerpt

Most contracts have exactly two parties. If the excerpt makes it clear there are more (multi-party agreement), include them all.`;

/**
 * Detect the parties to the agreement.
 *
 * @param {string} contractText  Plain text extracted from the contract.
 * @param {object} [options]
 * @param {string} [options.userId]   Optional — for usage logging.
 * @param {string} [options.reviewId] Optional — for usage logging.
 * @returns {Promise<Array<{name: string, defined_term: string, role_hint: string}>>}
 */
export async function detectParties(contractText, options = {}) {
  if (!contractText || typeof contractText !== 'string') return [];

  // 6000 chars is enough to capture the preamble and signature page in 95%
  // of contracts. Using both ends covers contracts that put the parties
  // only in the signature block.
  const head = contractText.slice(0, 4500);
  const tail = contractText.slice(-1500);
  const excerpt = head + (contractText.length > 6000 ? '\n\n[...elided...]\n\n' + tail : '');

  try {
    const resp = await callModel({
      agentName: 'party-detector',
      systemPrompt: SYSTEM_PROMPT,
      userMessage: 'Identify the parties.\n\nCONTRACT EXCERPT:\n' + excerpt,
      userId: options.userId,
      reviewId: options.reviewId,
      maxTokens: 512,
    });
    const parsed = extractJson(resp.text);
    if (!parsed || !Array.isArray(parsed.parties)) return [];

    return parsed.parties
      .filter(p => p && typeof p === 'object')
      .map(p => ({
        name: typeof p.name === 'string' ? p.name.trim() : '',
        defined_term: typeof p.defined_term === 'string' ? p.defined_term.trim() : '',
        role_hint: ['provider', 'recipient', 'unknown'].includes(p.role_hint)
          ? p.role_hint
          : 'unknown',
      }))
      .filter(p => p.name || p.defined_term);
  } catch (err) {
    console.error('[detect-parties] failed:', err.message);
    return [];
  }
}
