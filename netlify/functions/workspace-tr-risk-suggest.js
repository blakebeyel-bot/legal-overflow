/**
 * POST /api/workspace-tr-risk-suggest
 *   body: {
 *     review_id: uuid,
 *     document_id: uuid,
 *     risk: { title, detail, quote, severity },
 *     user_direction?: string,         // user's preferred direction for the rewrite
 *   }
 *
 * Generates a redline suggestion for a red flag the AI surfaced in
 * the per-doc overview. The result is NOT persisted — it's returned
 * to the client for the user to review, copy, or use as a starting
 * point. The user can manually convert it into a redline column if
 * they want it tracked alongside the review's normal cells.
 *
 * Response: { find, replace, rationale }
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';
import { resolveProviderKey } from '../lib/byok-keys.js';
import { completeText, findModel } from '../lib/llm-providers.js';

const SYSTEM = `You are a senior associate proposing an EDIT to a contract clause that flagged as a red flag during first-pass review. The user is the attorney representing one side of the deal; your job is to rewrite the clause to favor that side without breaking the deal.

Output strict JSON only — no prose, no markdown, no fenced block:
{
  "find":      "VERBATIM clause text from the document, as quoted in the red flag. Match the original exactly. ≤120 words.",
  "replace":   "Your proposed rewrite. Same scope as 'find' (don't expand or shrink the clause). Drafted in the user's favor. ≤200 words.",
  "rationale": "1-2 sentences explaining what you changed and why, in attorney-to-attorney voice."
}

Rules:
- "find" must be a verbatim continuous span from the document. If you cannot match the quote exactly, output find="" and rationale explaining why.
- "replace" must read as a clean drafting alternative — not commentary, not bracketed notes. Use definite, contract-grade language.
- Preserve the structural placeholder (e.g., if the original said "X shall...", your replacement should also start "X shall..." unless the redline specifically targets that subject).
- If the user gave preferred direction, follow it. If not, default to: cap exposure, add cure periods, narrow scope, mutualize one-sided obligations, push unfavorable forum/law to neutral.
- Be a deal-savvy negotiator: don't overreach in a way that signals weakness or invites a counter-redline that's worse than the status quo.`;

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const body = await req.json().catch(() => ({}));
  const reviewId = body.review_id;
  const docId = body.document_id;
  const risk = body.risk || {};
  const userDirection = (body.user_direction || '').toString().slice(0, 2000);
  if (!reviewId || !docId) return json({ error: 'Missing review_id / document_id' }, 400);
  if (!risk.title || !risk.quote) return json({ error: 'Risk requires title + quote' }, 400);

  const supabase = getSupabaseAdmin();

  // Validate review ownership
  const { data: review, error: rErr } = await supabase
    .from('workspace_tabular_reviews')
    .select('id, model, client_role, additional_context')
    .eq('id', reviewId)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (rErr || !review) return json({ error: 'Review not found' }, 404);

  // Validate doc ownership
  const { data: doc, error: dErr } = await supabase
    .from('workspace_documents')
    .select('id, current_version_id')
    .eq('id', docId)
    .eq('user_id', auth.user.id)
    .is('deleted_at', null)
    .maybeSingle();
  if (dErr || !doc) return json({ error: 'Document not found' }, 404);

  // Pull a snippet of the doc text for context. We don't need the
  // whole thing — the risk already includes the verbatim quote, and
  // a few thousand chars around it is enough for the model to
  // understand surrounding clauses.
  const { data: ver } = await supabase
    .from('workspace_document_versions')
    .select('extracted_text')
    .eq('id', doc.current_version_id)
    .maybeSingle();
  const fullText = ver?.extracted_text || '';
  let docSnippet = '';
  if (fullText) {
    const idx = fullText.indexOf(risk.quote);
    if (idx >= 0) {
      const start = Math.max(0, idx - 1500);
      const end = Math.min(fullText.length, idx + risk.quote.length + 1500);
      docSnippet = (start > 0 ? '…' : '') + fullText.slice(start, end) + (end < fullText.length ? '…' : '');
    } else {
      docSnippet = fullText.slice(0, 4000);
    }
  }

  const userMsg = `=== RED FLAG ===
Title: ${risk.title}
Severity: ${risk.severity || 'medium'}
Detail: ${risk.detail || ''}
Verbatim quote from the document: ${risk.quote}

${docSnippet ? `=== SURROUNDING DOCUMENT TEXT (for context) ===\n${docSnippet}\n=== END ===\n` : ''}
${review.client_role ? `\nThe user represents: ${review.client_role}` : ''}
${review.additional_context ? `\nAdditional context for this matter: ${review.additional_context}` : ''}
${userDirection ? `\n=== USER'S PREFERRED DIRECTION ===\n${userDirection}\n=== END ===\n` : ''}

Produce the JSON object only.`;

  const modelInfo = findModel(review.model || 'claude-sonnet-4-5');
  const { key } = await resolveProviderKey({ userId: auth.user.id, provider: modelInfo.provider });
  if (!key) return json({ error: `No API key for ${modelInfo.provider}` }, 400);

  let raw = '';
  try {
    const out = await completeText({
      provider: modelInfo.provider,
      model: modelInfo.id,
      apiKey: key,
      system: SYSTEM,
      messages: [{ role: 'user', content: userMsg }],
      maxTokens: 1200,
      temperature: 0.2,
    });
    raw = out.text || '';
  } catch (err) {
    return json({ error: `Suggestion failed: ${err.message}` }, 500);
  }

  // Tolerant JSON parse
  let parsed = null;
  try {
    let s = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('no JSON');
    parsed = JSON.parse(s.slice(start, end + 1));
  } catch (err) {
    return json({ error: `Could not parse suggestion: ${err.message}` }, 500);
  }

  return json({
    find: String(parsed.find || '').slice(0, 4000),
    replace: String(parsed.replace || '').slice(0, 6000),
    rationale: String(parsed.rationale || '').slice(0, 1500),
  });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
