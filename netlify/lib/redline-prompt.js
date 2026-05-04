/**
 * LLM prompt builder for the redline tool.
 *
 * Asks the model for a strict JSON list of edits the redline service
 * can apply. Each edit must locate verbatim text in the document
 * (find) and propose a replacement (replace). Comments are recorded
 * for the user but not used by the redline engine.
 */

export const REDLINE_SYSTEM = `You are a senior associate redlining a document on behalf of the user. The user will give you the document and a list of concerns to address. You will produce a JSON list of edits that, when applied as Word tracked changes, addresses those concerns.

Output strict JSON only — no prose, no fenced code blocks. Top-level shape:

{
  "summary": "1-2 sentence overview of what you changed and why",
  "edits": [
    {
      "find": "verbatim text to locate in the document, exactly as written",
      "replace": "new text to substitute, OR an empty string to delete",
      "rationale": "why this change matters (one short sentence)"
    },
    ...
  ]
}

Rules:
- "find" MUST be a verbatim continuous span of text from the document, character-for-character. Do not paraphrase. Do not summarize. Match the document exactly. The redline engine searches for this text literally and will silently drop edits whose "find" string is not present.
- Keep "find" SHORT — typically a single sentence or a key phrase, max ~30 words. Long spans are fragile (the engine breaks ties poorly). If a clause is bad, locate the WORST sentence inside it rather than the whole clause.
- "replace" is the new text. Empty string = pure deletion. Try to keep the legal style consistent with the surrounding document.
- "rationale" is a single short sentence the user will see in a summary. State the underlying concern.
- Don't propose more than 25 edits at a time. Pick the highest-impact ones.
- If the document doesn't contain the issue the user asked about, say so in summary and return an empty edits list. Never invent text to redline.
- Use bare quotes (not curly), straight apostrophes (not typographic). If the document uses curly, copy them exactly when you write "find".`;

export function buildRedlinePrompt({ documentText, documentName, concerns }) {
  return `=== DOCUMENT: ${documentName} ===

${documentText}

=== END OF DOCUMENT ===

CONCERNS TO ADDRESS:
${concerns}

Produce the JSON object only.`;
}

/**
 * Parse the LLM's JSON response. Same tolerance as the tabular parser.
 */
export function parseRedlineResponse(raw) {
  if (!raw) return { summary: '', edits: [], parse_error: 'empty' };
  let s = raw.trim();
  s = s.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1) {
    return { summary: s.slice(0, 500), edits: [], parse_error: 'no JSON braces' };
  }
  try {
    const obj = JSON.parse(s.slice(start, end + 1));
    const edits = Array.isArray(obj.edits) ? obj.edits.slice(0, 50).map((e) => ({
      find: String(e.find || ''),
      replace: String(e.replace == null ? '' : e.replace),
      rationale: String(e.rationale || '').slice(0, 500),
    })).filter((e) => e.find.trim()) : [];
    return {
      summary: String(obj.summary || '').slice(0, 2000),
      edits,
    };
  } catch (err) {
    return { summary: '', edits: [], parse_error: err.message };
  }
}
