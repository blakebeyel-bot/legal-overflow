/**
 * Deterministic posture-integrity check.
 *
 * The single worst failure mode of the specialists is role-inversion — a
 * Provider-side review proposing Net 90 payment terms, a Customer-side
 * review proposing a lower liability cap, etc. Asking the specialist to
 * self-police in the same LLM call that produced the error is asking the
 * error source to catch itself.
 *
 * This module runs as a separate deterministic pass after the compiler's
 * LLM step, applying a rules table derived from each specialist's
 * "Posture integrity note" section in its .md file.
 *
 * checkFinding() returns { verdict: 'pass' | 'fail' | 'ambiguous', rule, reason }.
 *
 * For ambiguous verdicts, escalate() fires a short one-shot LLM call with
 * just the finding + role — not the full compiler context. Cheap, scoped,
 * and independent of the upstream LLM that may have drifted.
 */

/**
 * Extract the first number found in a string, with unit detection.
 * Returns { value, kind: 'days' | 'months' | 'years' | 'dollars' | 'percent' } or null.
 */
function extractQuantity(text) {
  if (!text || typeof text !== 'string') return null;
  const s = text.toLowerCase();

  // Dollar amounts — $X, $X,XXX,XXX, $X million
  const dollarMatch = s.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(million|m|billion|b)?/);
  if (dollarMatch) {
    let val = parseFloat(dollarMatch[1].replace(/,/g, ''));
    if (/million|^m$/.test(dollarMatch[2] || '')) val *= 1_000_000;
    if (/billion|^b$/.test(dollarMatch[2] || '')) val *= 1_000_000_000;
    return { value: val, kind: 'dollars' };
  }

  // Duration: "Net X", "X days", "X (X) days"
  const netMatch = s.match(/\bnet[\s-]+(\d+)\b/);
  if (netMatch) return { value: parseInt(netMatch[1], 10), kind: 'days' };

  const dayMatch = s.match(/\b(?:within\s+)?(?:(\d+)|(?:\w+\s*\((\d+)\)))\s+(?:calendar\s+|business\s+)?days?\b/);
  if (dayMatch) {
    const n = parseInt(dayMatch[1] || dayMatch[2], 10);
    return { value: n, kind: 'days' };
  }

  const monthMatch = s.match(/\b(?:(\d+)|(?:\w+\s*\((\d+)\)))\s+months?\b/);
  if (monthMatch) {
    const n = parseInt(monthMatch[1] || monthMatch[2], 10);
    return { value: n, kind: 'months' };
  }

  const yearMatch = s.match(/\b(?:(\d+)|(?:\w+\s*\((\d+)\)))\s+(?:calendar\s+)?years?\b/);
  if (yearMatch) {
    const n = parseInt(yearMatch[1] || yearMatch[2], 10);
    return { value: n, kind: 'years' };
  }

  // Percent (for SLA thresholds)
  const pctMatch = s.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pctMatch) return { value: parseFloat(pctMatch[1]), kind: 'percent' };

  return null;
}

/**
 * Normalize client role into a broader category so role-based rules can fire
 * across naming variations ("Service Provider" → "provider", "Licensee" → "customer").
 */
function normalizeRole(role) {
  if (!role || typeof role !== 'string') return 'unknown';
  const r = role.toLowerCase();
  if (/(provider|vendor|licensor|supplier|consultant|contractor|subcontractor|processor)/.test(r)) {
    return 'provider_side';
  }
  if (/(customer|buyer|licensee|client|controller)/.test(r)) {
    return 'customer_side';
  }
  return 'unknown';
}

/**
 * Rules table. Each rule:
 *   - category: the specialist's category string that this rule applies to (loose match via includes)
 *   - appliesWhen(finding): returns true if the rule should run
 *   - verdict(finding, role): returns 'pass' | 'fail' | 'ambiguous' with a reason
 *
 * Rules are intentionally conservative — return 'ambiguous' whenever there's
 * any doubt. Ambiguous cases get escalated to a short LLM call.
 */
const RULES = [
  // ============ Commercial Terms ============
  {
    id: 'commercial-net-term-direction',
    domains: ['commercial', 'payment', 'net_payment_terms', 'invoicing'],
    verdict(finding, role) {
      const src = extractQuantity(finding.source_text);
      const dst = extractQuantity(finding.proposed_text);
      if (!src || !dst || src.kind !== 'days' || dst.kind !== 'days') return null;
      // Net-term numeric change detected
      if (role === 'provider_side' && dst.value > src.value) {
        return { verdict: 'fail', reason: `Proposed Net ${dst.value} extends payment timing from Net ${src.value}; Provider-side reviews must not increase Net-term days.` };
      }
      if (role === 'customer_side' && dst.value < src.value) {
        return { verdict: 'fail', reason: `Proposed Net ${dst.value} shortens payment timing from Net ${src.value}; Customer-side reviews must not decrease Net-term days.` };
      }
      if (role === 'provider_side' && dst.value <= src.value) {
        return { verdict: 'pass', reason: 'Provider-side edit shortens or preserves Net terms.' };
      }
      if (role === 'customer_side' && dst.value >= src.value) {
        return { verdict: 'pass', reason: 'Customer-side edit extends or preserves Net terms.' };
      }
      return null;
    },
  },

  // ============ Risk Allocation ============
  {
    id: 'risk-liability-cap-direction',
    domains: ['risk_allocation', 'liability_cap', 'limitation_of_liability'],
    verdict(finding, role) {
      const src = extractQuantity(finding.source_text);
      const dst = extractQuantity(finding.proposed_text);
      if (!src || !dst) return null;
      if (src.kind !== dst.kind) return null;
      if (src.kind !== 'dollars' && src.kind !== 'months' && src.kind !== 'years') return null;

      // For dollar caps, higher = worse for capped party, better for counterparty.
      // Provider is almost always the capped party in SaaS/services; Customer is typically the uncapped-beneficiary.
      // Conservative approach: only fire in obvious cases.
      if (src.kind === 'dollars') {
        if (role === 'provider_side' && dst.value > src.value) {
          return { verdict: 'fail', reason: `Proposed liability cap increased from $${src.value.toLocaleString()} to $${dst.value.toLocaleString()}; Provider-side reviews must not raise the cap.` };
        }
        if (role === 'customer_side' && dst.value < src.value) {
          return { verdict: 'fail', reason: `Proposed liability cap decreased from $${src.value.toLocaleString()} to $${dst.value.toLocaleString()}; Customer-side reviews must not lower the cap.` };
        }
      }
      // For cap look-back periods (months/years), longer = worse for capped party
      if (src.kind === 'months' || src.kind === 'years') {
        if (role === 'provider_side' && dst.value > src.value) {
          return { verdict: 'fail', reason: `Cap look-back period increased; Provider-side reviews must not lengthen cap look-back.` };
        }
        if (role === 'customer_side' && dst.value < src.value) {
          return { verdict: 'fail', reason: `Cap look-back period shortened; Customer-side reviews must not shorten cap look-back.` };
        }
      }
      return null;
    },
  },

  // ============ Insurance ============
  {
    id: 'insurance-limit-direction',
    domains: ['insurance', 'coverage'],
    verdict(finding, role) {
      const src = extractQuantity(finding.source_text);
      const dst = extractQuantity(finding.proposed_text);
      if (!src || !dst || src.kind !== 'dollars' || dst.kind !== 'dollars') return null;
      if (role === 'provider_side' && dst.value > src.value) {
        return { verdict: 'fail', reason: `Insurance limit increased from $${src.value.toLocaleString()} to $${dst.value.toLocaleString()}; Provider-side reviews must not raise required coverage.` };
      }
      if (role === 'customer_side' && dst.value < src.value) {
        return { verdict: 'fail', reason: `Insurance limit decreased from $${src.value.toLocaleString()} to $${dst.value.toLocaleString()}; Customer-side reviews must not lower required coverage.` };
      }
      return null;
    },
  },

  // ============ Performance Obligations ============
  {
    id: 'performance-sla-threshold-direction',
    domains: ['performance', 'sla', 'uptime'],
    verdict(finding, role) {
      const src = extractQuantity(finding.source_text);
      const dst = extractQuantity(finding.proposed_text);
      if (!src || !dst || src.kind !== 'percent' || dst.kind !== 'percent') return null;
      if (role === 'provider_side' && dst.value > src.value) {
        return { verdict: 'fail', reason: `SLA threshold tightened from ${src.value}% to ${dst.value}%; Provider-side reviews must not tighten SLA commitments.` };
      }
      if (role === 'customer_side' && dst.value < src.value) {
        return { verdict: 'fail', reason: `SLA threshold loosened from ${src.value}% to ${dst.value}%; Customer-side reviews must not loosen SLA commitments.` };
      }
      return null;
    },
  },

  // ============ Termination & Remedies ============
  {
    id: 'termination-cure-period-direction',
    domains: ['termination', 'cure'],
    verdict(finding, role) {
      const src = extractQuantity(finding.source_text);
      const dst = extractQuantity(finding.proposed_text);
      if (!src || !dst || src.kind !== 'days' || dst.kind !== 'days') return null;
      // Whoever is on the breach-exposed side benefits from longer cure periods.
      // Default cure applies to both parties, so the directional call depends on
      // who's "more likely" to breach. Without that info, ambiguous.
      return null;
    },
  },

  // ============ Protective Provisions ============
  {
    id: 'protective-confidentiality-duration-direction',
    domains: ['confidentiality', 'nondisclosure'],
    verdict(finding, role) {
      const src = extractQuantity(finding.source_text);
      const dst = extractQuantity(finding.proposed_text);
      if (!src || !dst) return null;
      if ((src.kind !== 'years' && src.kind !== 'months') || src.kind !== dst.kind) return null;
      // Longer duration favors the party with more to protect.
      // For confidentiality, both sides typically disclose, so the rule is symmetric.
      // Leave ambiguous unless we can determine the finding is one-sided — which needs context.
      return null;
    },
  },
];

/**
 * Run the deterministic rules table against a single finding.
 * Returns { verdict, rule, reason }. Verdict is 'pass', 'fail', or 'ambiguous'.
 */
export function checkFinding(finding, clientRole) {
  const role = normalizeRole(clientRole);
  if (role === 'unknown') {
    return { verdict: 'ambiguous', rule: null, reason: 'Unknown client role; cannot apply directional rules.' };
  }

  const category = (finding.category || '').toLowerCase();
  const candidateRules = RULES.filter(r => r.domains.some(d => category.includes(d)));

  for (const rule of candidateRules) {
    const result = rule.verdict(finding, role);
    if (result && (result.verdict === 'pass' || result.verdict === 'fail')) {
      return { verdict: result.verdict, rule: rule.id, reason: result.reason };
    }
  }
  return { verdict: 'ambiguous', rule: null, reason: 'No deterministic rule fired; human/LLM judgment needed.' };
}

/**
 * For ambiguous verdicts, a short one-shot LLM call that decides whether
 * the finding's proposed_text moves the contract in a favorable direction
 * for the client in its role. This is SCOPED — sees only the finding and
 * the role, not the whole compiler context.
 *
 * Caller supplies the callModel function (from anthropic.js) so this
 * module stays dependency-light.
 */
export async function escalateAmbiguous({ finding, clientRole, callModel, userId, reviewId }) {
  const systemPrompt = POSTURE_CLASSIFIER_SYSTEM_PROMPT;

  const proposedText = finding.proposed_text || finding.suggested_text || '[none]';
  const userMessage =
    `CLIENT PARTY ROLE IN CONTRACT: ${clientRole}\n\n` +
    `FINDING CATEGORY: ${finding.category || 'unknown'}\n` +
    `FINDING SEVERITY: ${finding.severity || 'unknown'}\n` +
    `FINDING SPECIALIST: ${finding.specialist || 'unknown'}\n\n` +
    `MATERIALITY RATIONALE (the specialist's own articulation of concrete harm to the client if signed as-is — use this to infer who the clause currently benefits):\n${finding.materiality_rationale || '[none]'}\n\n` +
    `OPENING ASK (the client's negotiating position — what the specialist thinks the client should push for):\n${finding.position || '[none]'}\n\n` +
    `CURRENT LANGUAGE (source_text):\n${finding.source_text || '[none]'}\n\n` +
    `PROPOSED LANGUAGE (proposed_text):\n${proposedText}\n\n` +
    `EXTERNAL COMMENT (counterparty-facing text, context only):\n${finding.external_comment || '[none]'}\n\n` +
    `Apply the methodology from your system prompt. Produce a one-sentence beneficiary-first rationale, then on a new line a single word: HELPS, HURTS, or NEUTRAL.`;

  try {
    const resp = await callModel({
      agentName: 'posture-integrity-check',
      systemPrompt,
      userMessage,
      userId,
      reviewId,
      // Bumped from 8 → 150 so the model can perform the beneficiary
      // analysis step before answering. Parser pulls the last all-caps
      // token so reasoning prose doesn't confuse the verdict.
      maxTokens: 150,
    });
    const verdict = parseClassifierVerdict(resp.text || '');
    if (verdict === 'HELPS')   return { verdict: 'pass', reason: 'LLM escalation: edit favors client.' };
    if (verdict === 'HURTS')   return { verdict: 'fail', reason: 'LLM escalation: edit moves contract against client in role.' };
    if (verdict === 'NEUTRAL') return { verdict: 'pass', reason: 'LLM escalation: neutral — defaulting to pass.' };
    return { verdict: 'pass', reason: 'LLM escalation: unclear verdict — defaulting to pass.' };
  } catch (e) {
    console.error('[posture-integrity] LLM escalation failed, defaulting to pass:', e.message);
    return { verdict: 'pass', reason: 'LLM escalation failed; defaulting to pass.' };
  }
}

/**
 * Parse the verdict from the classifier's response. The model is instructed
 * to put a single-word answer on its own line at the end. Walks lines in
 * reverse and picks the first that is (or contains) HELPS, HURTS, or
 * NEUTRAL — tolerates trailing punctuation and surrounding prose.
 */
function parseClassifierVerdict(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    // Prefer a bare one-word line
    const bare = line.toUpperCase().replace(/[^A-Z]/g, '');
    if (bare === 'HELPS' || bare === 'HURTS' || bare === 'NEUTRAL') return bare;
  }
  // Fall back: any occurrence of the verdict anywhere in the text
  const upper = text.toUpperCase();
  if (/\bHELPS\b/.test(upper)) return 'HELPS';
  if (/\bHURTS\b/.test(upper)) return 'HURTS';
  if (/\bNEUTRAL\b/.test(upper)) return 'NEUTRAL';
  return null;
}

/**
 * System prompt for the posture-integrity classifier.
 *
 * The original one-sentence prompt was correctly identifying direction in
 * simple numeric cases (already caught deterministically) but inverting on
 * judgment-heavy clause types like MFN / retroactive refund, where the
 * model needed to reason about "who does this clause currently benefit"
 * before deciding direction of edit. This expanded prompt forces that
 * beneficiary-first step, supplies a clause-type reference table with the
 * answers, and includes worked examples on both sides of the common
 * direction-flipping clause types.
 */
const POSTURE_CLASSIFIER_SYSTEM_PROMPT =
  `You are a posture-integrity classifier. Your job is to decide whether a proposed contract edit moves the contract in a direction that FAVORS the named client party in their stated role.\n\n` +
  `METHODOLOGY — apply in this order:\n` +
  `1. Read the CURRENT LANGUAGE and identify which party the clause currently benefits most. Most one-sided contract clauses favor ONE specific party; mutual clauses are balanced but one side often benefits more in practice.\n` +
  `2. Read the PROPOSED LANGUAGE and identify which party it would benefit most (or whether it makes the clause mutual / removes the clause entirely).\n` +
  `3. Compare the two. If the shift moves benefit TOWARD the client's role → HELPS. If AWAY → HURTS. If no material shift → NEUTRAL.\n\n` +
  `CRITICAL PRINCIPLE: If the clause as currently written benefits the COUNTERPARTY, an edit that reduces, removes, or narrows that clause is PRO-CLIENT (HELPS). Do not assume that "deleting a clause" is automatically bad for the client — direction depends entirely on who the clause was helping before the edit.\n\n` +
  `Use the MATERIALITY RATIONALE field in the user message as a crucial signal: the specialist already articulated the CONCRETE HARM to the client from the current language. If the rationale describes harm, the current language benefits the counterparty and an edit reducing that language is HELPS for the client.\n\n` +
  `DIRECTION-CLASSIFICATION REFERENCE — beneficiary of the CURRENT language listed first for each clause type:\n\n` +
  `• MFN / most-favored-customer / price-protection / retroactive-refund: benefits the party RECEIVING the MFN protection (typically Customer in a vendor contract). Provider-side edits that delete, narrow, or make prospective-only are HELPS for Provider. Customer-side edits that broaden or add retroactive effect are HELPS for Customer.\n\n` +
  `• Indemnification: benefits the party being INDEMNIFIED. Broadening indemnity scope helps the indemnified party, harms the indemnifying party. Narrowing or adding carve-outs does the reverse. A Provider who is the indemnifying party HELPS when indemnity is narrowed.\n\n` +
  `• Limitation of liability cap (dollar amount): a LOWER cap HELPS the capped party (typically Provider), HURTS the uncapped counterparty. A HIGHER cap is the reverse. Cap CARVE-OUTS (unlimited for IP, data breach, etc.) help whoever benefits from the uncapped lane.\n\n` +
  `• Cap look-back (e.g., "fees paid in preceding 3 months"): LONGER look-back = larger effective cap = HURTS the capped party, HELPS the uncapped counterparty.\n\n` +
  `• Payment terms / Net-days: LONGER Net periods HELP the paying party (typically Customer), HURT the receiving party (typically Provider). Shorter Net periods reverse this.\n\n` +
  `• Cure periods: LONGER cure periods HELP the party that might breach (the operationally-exposed side). SHORTER cure periods HELP the non-breaching party.\n\n` +
  `• Non-competes: HELP the party imposing them, HURT the party restricted. Narrowing or shortening a non-compete HELPS the restricted party.\n\n` +
  `• Confidentiality duration: LONGER duration HELPS the disclosing party (the one with more to protect). In lopsided-disclosure situations, identify who is actually disclosing more sensitive material.\n\n` +
  `• Audit rights: HELP the auditing party, BURDEN the audited party. Narrowing audit scope / frequency / notice HELPS the audited party.\n\n` +
  `• Insurance required limits: HIGHER required limits HELP the requiring party (typically Customer), BURDEN the providing party (typically Provider). Additional-insured grants HELP the named additional insured.\n\n` +
  `• Termination for convenience: HELPS whoever has the right. A one-sided TfC favoring Customer hurts Provider. Adding a mutual TfC benefits whichever side values optionality more (usually Provider on long subscription deals).\n\n` +
  `• Acceptance criteria / SLA thresholds: TIGHTER thresholds HURT the performing party (typically Provider), HELP the receiving party. Looser thresholds reverse this.\n\n` +
  `• IP assignment / "work made for hire": ASSIGNMENT of IP to counterparty HURTS the assigning party. Narrowing the scope of assigned IP (to only Customer-specific deliverables, retaining platform/background IP) HELPS the assigning party.\n\n` +
  `• Means-and-methods control language: HELPS the controlling party, HURTS the performing party (and creates worker-classification risk for Provider).\n\n` +
  `WORKED EXAMPLES:\n\n` +
  `Example A — MFN on Provider side:\n` +
  `CURRENT: "Provider warrants that fees charged to Customer shall be no greater than the lowest fees charged to any similarly-situated customer, and Provider shall refund any difference retroactively."\n` +
  `PROPOSED: [delete]\n` +
  `CLIENT_ROLE: Provider\n` +
  `ANALYSIS: The current clause benefits Customer (Customer receives MFN protection + retroactive refund). Deleting it removes that Provider obligation.\n` +
  `ANSWER: HELPS\n\n` +
  `Example B — MFN on Customer side:\n` +
  `CURRENT: "Provider shall apply the same pricing as offered to other customers during the Term."\n` +
  `PROPOSED: "Provider shall apply the same pricing as offered to other customers during the Term, and shall refund any difference retroactive to the effective date of this Agreement."\n` +
  `CLIENT_ROLE: Customer\n` +
  `ANALYSIS: The edit broadens the MFN from prospective to retroactive — that expands a Customer benefit.\n` +
  `ANSWER: HELPS\n\n` +
  `Example C — Indemnity scope on Provider side:\n` +
  `CURRENT: "Provider shall indemnify Customer from any and all claims arising from or related to this Agreement."\n` +
  `PROPOSED: "Provider shall indemnify Customer from third-party claims arising from Provider's gross negligence or willful misconduct."\n` +
  `CLIENT_ROLE: Provider\n` +
  `ANALYSIS: Current unlimited scope benefits Customer. Edit narrows to third-party + GN/WM only — dramatically reduces Provider exposure.\n` +
  `ANSWER: HELPS\n\n` +
  `Example D — Liability cap on Provider side (HURTS direction):\n` +
  `CURRENT: "Provider's aggregate liability shall not exceed $500,000."\n` +
  `PROPOSED: "Provider's aggregate liability shall not exceed $2,000,000."\n` +
  `CLIENT_ROLE: Provider\n` +
  `ANALYSIS: Lower current cap benefits Provider. Edit raises the cap, increasing Provider exposure.\n` +
  `ANSWER: HURTS\n\n` +
  `Example E — Non-compete on restricted party side:\n` +
  `CURRENT: "For a period of 36 months following termination, Provider shall not provide services to any customer in the financial services industry."\n` +
  `PROPOSED: "For a period of 12 months following termination, Provider shall not solicit the named employees of Customer identified in Exhibit A."\n` +
  `CLIENT_ROLE: Provider\n` +
  `ANALYSIS: The current non-compete heavily restricts Provider. The edit narrows scope (industry-wide → named employees only) and shortens duration (36 → 12 months) — significantly less restrictive on Provider.\n` +
  `ANSWER: HELPS\n\n` +
  `OUTPUT FORMAT:\n` +
  `First, write ONE sentence identifying who the current clause benefits and whether the edit shifts benefit toward the client's role. Then on a NEW LINE, a single word: HELPS, HURTS, or NEUTRAL. No markdown, no bullets, no preamble.`;


/**
 * Apply posture-integrity checks to a list of findings. Returns:
 *   { accepted: Finding[], rejected: { finding, reason, rule }[], metrics }
 *
 * The `clientRole` should be the specific role (Provider, Customer, etc.) from
 * profile.company.role_in_contracts.
 */
export async function runPostureIntegrity({ findings, clientRole, callModel, userId, reviewId }) {
  const accepted = [];
  const rejected = [];
  const metrics = { deterministic_pass: 0, deterministic_fail: 0, escalated: 0, escalation_fail: 0 };

  for (const finding of findings) {
    const det = checkFinding(finding, clientRole);
    if (det.verdict === 'pass') {
      metrics.deterministic_pass++;
      accepted.push(finding);
      continue;
    }
    if (det.verdict === 'fail') {
      metrics.deterministic_fail++;
      rejected.push({ finding, reason: det.reason, rule: det.rule, source: 'deterministic' });
      continue;
    }
    // ambiguous — escalate
    metrics.escalated++;
    const esc = await escalateAmbiguous({ finding, clientRole, callModel, userId, reviewId });
    if (esc.verdict === 'pass') {
      accepted.push(finding);
    } else {
      metrics.escalation_fail++;
      rejected.push({ finding, reason: esc.reason, rule: 'llm_escalation', source: 'llm' });
    }
  }

  return { accepted, rejected, metrics };
}
