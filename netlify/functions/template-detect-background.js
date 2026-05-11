/**
 * POST /api/template-detect-background
 *   header: X-Internal-Trigger: template-detect  (CSRF gate)
 *   body: { item_id: uuid, user_id: uuid }
 *
 * Background job (-background suffix → up to 15 min on Netlify).
 * Reads a vault item's content, runs heuristic + model detection,
 * and updates the row with template_schema + sets source_kind to
 * 'template' when confident.
 *
 * Idempotent: re-running on the same item is safe — we overwrite
 * the schema. The receiver gates on the internal trigger header so
 * external callers can't queue detection jobs against arbitrary items.
 */
import { getSupabaseAdmin } from '../lib/supabase-admin.js';
import { detectTemplate } from '../lib/template-detect.js';

// Confidence threshold above which we automatically flip source_kind
// to 'template'. Below this we still store the schema (so the user can
// manually promote later) but leave source_kind as-is.
const AUTO_PROMOTE_THRESHOLD = 0.75;

export default async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  if (req.headers.get('X-Internal-Trigger') !== 'template-detect') {
    return new Response('forbidden', { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const itemId = body.item_id;
  const userId = body.user_id;
  if (!itemId || !userId) {
    return new Response('missing item_id or user_id', { status: 400 });
  }

  const supabase = getSupabaseAdmin();

  // Pull the vault item.
  const { data: item, error } = await supabase
    .from('workspace_vault_items')
    .select('id, user_id, source_kind, title, content, template_status')
    .eq('id', itemId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !item) {
    console.warn(`[template-detect] item not found ${itemId}: ${error?.message || 'no row'}`);
    return new Response('not found', { status: 404 });
  }

  // Skip if already a template or a draft — only detect on regular docs.
  if (item.source_kind === 'template' || item.source_kind === 'draft') {
    return new Response(JSON.stringify({ ok: true, skipped: true, reason: 'already classified' }));
  }

  // Mark in-progress so the UI can show a spinner if needed.
  await supabase
    .from('workspace_vault_items')
    .update({ template_status: 'detecting' })
    .eq('id', itemId);

  try {
    const result = await detectTemplate({ text: item.content || '', userId });
    const schemaJson = {
      vars: result.vars || [],
      auto_detected: true,
      detected_at: new Date().toISOString(),
      confidence: result.confidence,
      model_used: result.model_used,
      heuristic: result.heuristic || null,
    };

    // Decision matrix:
    //   - is_template AND confidence >= AUTO_PROMOTE_THRESHOLD →
    //     auto-flip source_kind to 'template'
    //   - is_template AND lower confidence → store schema, leave as 'document'
    //     so the user can promote manually from the vault UI
    //   - !is_template → store nothing, mark status='none' (skip)
    const patch = { template_status: 'ready' };
    if (result.is_template && result.vars.length > 0) {
      patch.template_schema = schemaJson;
      if (result.confidence >= AUTO_PROMOTE_THRESHOLD) {
        patch.source_kind = 'template';
      }
    } else {
      patch.template_status = 'none';
    }

    const { error: upErr } = await supabase
      .from('workspace_vault_items')
      .update(patch)
      .eq('id', itemId);
    if (upErr) throw new Error(upErr.message);

    console.log(
      `[template-detect] item=${itemId} is_template=${result.is_template} conf=${result.confidence.toFixed(2)} vars=${result.vars.length} promoted=${patch.source_kind === 'template'}`
    );
    return new Response(JSON.stringify({
      ok: true,
      is_template: result.is_template,
      confidence: result.confidence,
      vars_count: result.vars.length,
      promoted: patch.source_kind === 'template',
    }));
  } catch (err) {
    console.error(`[template-detect] failed item=${itemId}: ${err?.message || err}`);
    await supabase
      .from('workspace_vault_items')
      .update({ template_status: 'failed' })
      .eq('id', itemId)
      .catch(() => {});
    return new Response('failed: ' + (err.message || err), { status: 500 });
  }
};
