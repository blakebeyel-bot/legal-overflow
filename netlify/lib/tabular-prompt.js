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
