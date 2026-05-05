/**
 * POST /api/workspace-tr-cell-refine
 *   body: { cell_id, instruction }
 *
 * Iterates on an existing redline cell. The user gives a free-text
 * instruction like "make this stronger" or "use the phrase 'work
 * made for hire'" and the LLM produces a NEW replacement that
 * preserves the same `find` (the original clause we're editing)
 * but updates the proposed `replace` text.
 *
 * The cell's redline_replace + redline_rationale are overwritten;
 * status resets to 'pending' so the user has to re-accept the
 * refinement.
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';
import { resolveProviderKey } from '../lib/byok-keys.js';
import { completeText, findModel } from '../lib/llm-providers.js';

const SYSTEM_PROMPT = `You are revising a proposed edit on a contract clause based on the user's instruction. You will receive:
- The verbatim original clause text (from the document)
- The current proposed replacement
- A free-text instruction from the user

Produce a NEW replacement that addresses the user's instruction. Preserve the legal style of the surrounding document. Do not change the original clause text — only the replacement.

Output strict JSON only — no prose, no fenced code block:
{"replace": "...", "rationale": "..."}

Rules:
- "replace" — the revised text. Empty string = pure deletion. Match the legal style of the surrounding document.
- "rationale" — one short sentence explaining what you changed and why.
- Don't add commentary. Just the JSON.`;

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const body = await req.json().catch(() => ({}));
  const cellId = body.cell_id;
  const instruction = String(body.instruction || '').trim();
  if (!cellId) return json({ error: 'Missing cell_id' }, 400);
  if (!instruction) return json({ error: 'Instruction required' }, 400);
  if (instruction.length > 2000) return json({ error: 'Instruction too long' }, 400);

  const supabase = getSupabaseAdmin();

  // Verify ownership and load the cell + parent review for the model
  const { data: cell } = await supabase
    .from('workspace_tabular_cells')
    .select('*, review:review_id (id, user_id, model, kind, client_role, additional_context)')
    .eq('id', cellId)
    .maybeSingle();
  if (!cell) return json({ error: 'Cell not found' }, 404);
  if (cell.review.user_id !== auth.user.id) return json({ error: 'Cell not found' }, 404);
  if (cell.review.kind !== 'redline') return json({ error: 'Refine only works on redline reviews' }, 400);
  if (!cell.redline_find) return json({ error: 'Cell has no original clause to refine' }, 400);

  const modelInfo = findModel(cell.review.model || 'claude-sonnet-4-5');
  const { key } = await resolveProviderKey({ userId: auth.user.id, provider: modelInfo.provider });
  if (!key) return json({ error: `No API key configured for ${modelInfo.provider}` }, 400);

  // Include the review's client_role and additional_context so the
  // refinement is consistent with the rest of the review's tone.
  const ctxLines = [];
  if (cell.review.client_role) ctxLines.push(`USER REPRESENTS: ${cell.review.client_role}`);
  if (cell.review.additional_context) ctxLines.push(`ADDITIONAL CONTEXT: ${cell.review.additional_context}`);
  const ctxBlock = ctxLines.length ? `\n${ctxLines.join('\n')}\n` : '';

  const userPrompt = `ORIGINAL CLAUSE (verbatim from document):
${cell.redline_find}

CURRENT PROPOSED REPLACEMENT:
${cell.redline_replace || '(deletion)'}
${ctxBlock}
USER INSTRUCTION:
${instruction}

Produce the JSON object only.`;

  let raw = '';
  try {
    const out = await completeText({
      provider: modelInfo.provider,
      model: modelInfo.id,
      apiKey: key,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 1200,
      temperature: 0.3,
    });
    raw = out.text;
  } catch (err) {
    return json({ error: `LLM call failed: ${err.message}` }, 500);
  }

  // Tolerant JSON parser
  let parsed = null;
  try {
    let s = (raw || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('no JSON');
    parsed = JSON.parse(s.slice(start, end + 1));
  } catch (err) {
    return json({ error: `Could not parse LLM response: ${err.message}`, raw: raw.slice(0, 500) }, 500);
  }

  const newReplace = String(parsed.replace == null ? '' : parsed.replace).slice(0, 4000);
  const newRationale = String(parsed.rationale || '').slice(0, 1000);

  // Update the cell. Reset redline_status to 'pending' so the user
  // has to confirm the new proposal — accepting the old one no
  // longer applies to the revised text.
  const { data: updated, error: updErr } = await supabase
    .from('workspace_tabular_cells')
    .update({
      redline_replace: newReplace,
      redline_rationale: newRationale,
      content: newRationale,
      redline_status: 'pending',
      redline_resolved_at: null,
    })
    .eq('id', cellId)
    .select('*')
    .single();
  if (updErr) return json({ error: updErr.message }, 500);

  return json({ cell: updated });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
