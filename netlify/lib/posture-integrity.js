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
  const systemPrompt =
    `You are a posture-integrity checker. You decide a single question: does the proposed contract edit below move the contract in a direction that FAVORS the named party in their role? Answer strictly with one word: HELPS, HURTS, or NEUTRAL. No explanation.`;

  const userMessage =
    `CLIENT PARTY ROLE IN CONTRACT: ${clientRole}\n\n` +
    `FINDING CATEGORY: ${finding.category || 'unknown'}\n` +
    `SEVERITY: ${finding.severity || 'unknown'}\n\n` +
    `CURRENT LANGUAGE (source_text):\n${finding.source_text || '[none]'}\n\n` +
    `PROPOSED LANGUAGE (proposed_text):\n${finding.proposed_text || '[none]'}\n\n` +
    `EXTERNAL COMMENT (for context only):\n${finding.external_comment || ''}\n\n` +
    `Answer: HELPS / HURTS / NEUTRAL`;

  try {
    const resp = await callModel({
      agentName: 'posture-integrity-check',
      systemPrompt,
      userMessage,
      userId,
      reviewId,
      maxTokens: 8,
    });
    const verdict = (resp.text || '').trim().toUpperCase();
    if (verdict.startsWith('HELPS')) return { verdict: 'pass', reason: 'LLM escalation: edit favors client.' };
    if (verdict.startsWith('HURTS')) return { verdict: 'fail', reason: 'LLM escalation: edit moves contract against client in role.' };
    return { verdict: 'pass', reason: 'LLM escalation: neutral or unclear — defaulting to pass.' };
  } catch (e) {
    console.error('[posture-integrity] LLM escalation failed, defaulting to pass:', e.message);
    return { verdict: 'pass', reason: 'LLM escalation failed; defaulting to pass.' };
  }
}

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
