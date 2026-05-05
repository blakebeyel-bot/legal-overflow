/**
 * Per-cell prompt builder for tabular reviews.
 *
 * One LLM call per cell. The model is given a single document and a
 * single question (column prompt). We ask for two things back:
 *   - a concise answer
 *   - an exact verbatim quote from the document supporting the answer
 *
 * Output format is a small JSON block we can parse deterministically.
 * Lawyers don't trust extractions without sourceable quotes, so the
 * citation is required.
 */

export const TABULAR_SYSTEM = `You are a legal research assistant performing structured document review. You will be given ONE document and ONE question. Answer concisely and ground every fact in a verbatim quote from the document.

Output strict JSON only, no prose, no markdown, no fenced block:
{"answer": "...", "quote": "...", "page": 3, "not_in_document": false}

Rules:
- "answer" — the direct response to the question. Aim for under 30 words. If the question asks for a yes/no, lead with "Yes" or "No". If the question asks for a value (e.g., "term length"), lead with the value. Plain text only — no markdown.
- "quote" — a VERBATIM continuous span of text copied from the document, ≤ 40 words, that supports the answer. Do not paraphrase. Do not edit. Match capitalization and punctuation exactly. If multiple passages support the answer, pick the most directly responsive single one.
- "page" — integer page number where the quote appears (1-indexed by [Page N] markers in the document text). If unknown, set 0.
- "not_in_document" — true ONLY if the document genuinely does not address the question. Then set "answer" to "Not addressed in this document.", "quote" to "", "page" to 0.

Never invent information. If the answer requires combining facts that aren't both stated in this single document, say so in the answer field and set not_in_document=true.`;

export function buildCellPrompt({ documentText, documentName, columnPrompt }) {
  return `=== DOCUMENT: ${documentName} ===

${documentText}

=== END OF DOCUMENT ===

QUESTION: ${columnPrompt}

Respond with the JSON object only.`;
}

// ---------- Redline-mode prompt ----------
// Same N×M grid, but each cell yields a proposed edit (find /
// replace / rationale) instead of an answer + quote. The redline
// engine on Fly will literally search for the find_text in the
// .docx, so it must be verbatim from the document.

export const TABULAR_REDLINE_SYSTEM = `You are a senior associate redlining ONE document on behalf of the user. You will be given the document and ONE concern. Your job: find the worst single passage in the document that triggers that concern, and propose an edit that addresses it.

Output strict JSON only — no prose, no markdown, no fenced code:
{"find": "...", "replace": "...", "rationale": "...", "not_in_document": false}

Rules:
- "find" — a verbatim continuous span of text from the document, character-for-character. Match capitalization, punctuation, curly vs. straight quotes EXACTLY. The redline engine searches for this string literally; if it doesn't match, the edit is silently dropped.
- Keep "find" SHORT. A single sentence or key phrase, max ~30 words. Long spans are fragile because the engine breaks ties poorly. If a clause is bad, locate the WORST sentence inside it rather than the whole clause.
- "replace" — the new text. Empty string = pure deletion. Match the legal style of the surrounding document.
- "rationale" — one short sentence explaining WHY this change addresses the user's concern.
- "not_in_document": true ONLY if the concern doesn't apply to this document at all. Then "find" and "replace" should both be empty strings.
- One edit per cell. Pick the highest-impact issue. If the user wants more we can rerun.
- Do not invent text. Don't propose an edit unless you can quote the original verbatim.`;

export function buildRedlineCellPrompt({ documentText, documentName, columnPrompt }) {
  return `=== DOCUMENT: ${documentName} ===

${documentText}

=== END OF DOCUMENT ===

CONCERN: ${columnPrompt}

Find the worst single passage that triggers this concern and propose an edit. Respond with the JSON object only.`;
}

export function parseRedlineCellResponse(raw) {
  if (!raw) return { find: '', replace: '', rationale: '', not_in_document: false, parse_error: 'empty' };
  let s = raw.trim();
  s = s.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1) {
    return { find: '', replace: '', rationale: s.slice(0, 500), not_in_document: false, parse_error: 'no JSON' };
  }
  try {
    const obj = JSON.parse(s.slice(start, end + 1));
    return {
      find: String(obj.find || '').slice(0, 2000),
      replace: String(obj.replace == null ? '' : obj.replace).slice(0, 4000),
      rationale: String(obj.rationale || '').slice(0, 1000),
      not_in_document: !!obj.not_in_document,
    };
  } catch (err) {
    return { find: '', replace: '', rationale: '', not_in_document: false, parse_error: err.message };
  }
}

/**
 * Parse the model's JSON response. Tolerant — if the model wraps in
 * ```json ... ``` or includes leading/trailing prose, we extract.
 * Returns { answer, quote, page, not_in_document, parse_error? }.
 */
export function parseCellResponse(raw) {
  if (!raw) return { answer: '', quote: '', page: 0, not_in_document: false, parse_error: 'empty' };
  let s = raw.trim();
  // Strip code fences
  s = s.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  // Find first { and last } if there's surrounding prose
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1) {
    return { answer: s.slice(0, 500), quote: '', page: 0, not_in_document: false, parse_error: 'no JSON braces' };
  }
  const candidate = s.slice(start, end + 1);
  try {
    const obj = JSON.parse(candidate);
    return {
      answer: String(obj.answer || '').slice(0, 1000),
      quote: String(obj.quote || '').slice(0, 1000),
      page: Number.isFinite(obj.page) ? Math.floor(obj.page) : 0,
      not_in_document: !!obj.not_in_document,
    };
  } catch (err) {
    return { answer: candidate.slice(0, 500), quote: '', page: 0, not_in_document: false, parse_error: err.message };
  }
}
