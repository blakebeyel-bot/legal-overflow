/**
 * Compare-two-documents prompt builder.
 *
 * Given a base/template doc + a proposed/counterparty doc, asks the
 * model to walk through both and identify every meaningful
 * difference — additions, deletions, and substantive rewordings.
 * Each diff includes a section name, the original text, the proposed
 * text, why it matters, a severity, and a recommendation given the
 * user's role.
 */

export const COMPARE_SYSTEM = `You are a senior associate comparing two contract drafts on behalf of the user. The user has marked one as the BASE (their template / preferred version) and one as the PROPOSED (the other side's version). Walk both end-to-end and produce a list of every meaningful difference.

Output strict JSON only — no prose, no markdown, no fenced code:
{
  "summary": "2-3 sentences summarizing the overall character of the changes — does the proposed version generally favor the user, the counterparty, or is it neutral? What are the headline changes?",
  "diffs": [
    {
      "section_name": "Short label for where this lands, e.g. 'Section 7.2 — Liability cap', 'Recitals', 'Exhibit A'",
      "change_type": "addition" | "deletion" | "modification",
      "severity": "high" | "medium" | "low" | "info",
      "base_text": "verbatim text from the base doc, or empty string if this is an addition",
      "proposed_text": "verbatim text from the proposed doc, or empty string if this is a deletion",
      "why_it_matters": "1-2 sentences explaining the substantive difference and the impact",
      "recommendation": "accept" | "reject" | "negotiate"
    }
  ]
}

Rules:
- Walk both documents IN ORDER. Process each section. For each, decide: same, modified, deleted, added.
- Skip items where the change is purely cosmetic (whitespace, capitalization-only, identical reformat). Note these only if they're material.
- "base_text" / "proposed_text" must be VERBATIM from the source. Match capitalization and punctuation exactly.
- "severity" — high = materially shifts risk/value to one side; medium = noticeable but routine; low = stylistic; info = neutral note.
- "recommendation" given the user's role:
  - "accept" — proposed is acceptable, no fight worth picking
  - "reject" — push back, hold the base version
  - "negotiate" — counter with a middle option (state it in why_it_matters)
- Cap diffs at 30. Rank by severity (high first).
- Never invent text. If a clause is the same in both docs, do not flag it.`;

export function buildComparePrompt({ baseText, baseFilename, proposedText, proposedFilename, clientRole, additionalContext }) {
  const ctxLines = [];
  if (clientRole) ctxLines.push(`USER REPRESENTS: ${clientRole}\nFrame recommendations from this party's perspective.`);
  if (additionalContext) ctxLines.push(`ADDITIONAL CONTEXT: ${additionalContext}`);
  const ctx = ctxLines.length ? `\n${ctxLines.join('\n\n')}\n` : '';

  return `=== BASE DOCUMENT (your template / preferred version): ${baseFilename} ===

${baseText}

=== END OF BASE ===

=== PROPOSED DOCUMENT (the other side's version): ${proposedFilename} ===

${proposedText}

=== END OF PROPOSED ===
${ctx}
Produce the JSON object only.`;
}

export function parseCompareResponse(raw) {
  if (!raw) return { summary: '', diffs: [], parse_error: 'empty' };
  let s = raw.trim();
  s = s.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1) {
    return { summary: s.slice(0, 1000), diffs: [], parse_error: 'no JSON' };
  }
  try {
    const obj = JSON.parse(s.slice(start, end + 1));
    const diffs = Array.isArray(obj.diffs) ? obj.diffs.slice(0, 50).map((d, i) => ({
      diff_index: i,
      section_name: String(d.section_name || '').slice(0, 200),
      change_type: ['addition','deletion','modification','equivalent'].includes(d.change_type) ? d.change_type : 'modification',
      severity: ['high','medium','low','info'].includes(d.severity) ? d.severity : 'medium',
      base_text: String(d.base_text || '').slice(0, 4000),
      proposed_text: String(d.proposed_text || '').slice(0, 4000),
      why_it_matters: String(d.why_it_matters || '').slice(0, 1500),
      recommendation: ['accept','reject','negotiate'].includes(d.recommendation) ? d.recommendation : 'negotiate',
    })) : [];
    return {
      summary: String(obj.summary || '').slice(0, 2000),
      diffs,
    };
  } catch (err) {
    return { summary: '', diffs: [], parse_error: err.message };
  }
}
