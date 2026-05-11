/**
 * POST /api/workspace-vault-update
 *   body: { id, title?, summary?, tags?, pinned?, archived? }
 *
 * Edits metadata on a vault item. Does NOT re-embed; content edits
 * would require chunk regeneration so we explicitly disallow editing
 * `content` here. (To replace content the user can delete and re-add.)
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

export default async (req) => {
  if (req.method !== 'POST' && req.method !== 'PATCH') return json({ error: 'POST/PATCH only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const body = await req.json().catch(() => ({}));
  const id = body.id;
  if (!id) return json({ error: 'Missing id' }, 400);

  const patch = {};
  if (typeof body.title === 'string') patch.title = body.title.trim().slice(0, 500);
  if (typeof body.summary === 'string') patch.summary = body.summary.slice(0, 2000);
  if (Array.isArray(body.tags)) patch.tags = body.tags.slice(0, 32).map((t) => String(t).slice(0, 80));
  if (typeof body.pinned === 'boolean') patch.pinned = body.pinned;
  if (typeof body.archived === 'boolean') {
    patch.archived_at = body.archived ? new Date().toISOString() : null;
  }
  // Template-related edits. source_kind can be flipped between
  // 'document' and 'template' (promote / demote). template_schema
  // accepts the full schema object — the client will have edited
  // the vars[] list. Other source_kinds are not user-settable here.
  if (typeof body.source_kind === 'string') {
    if (body.source_kind === 'template' || body.source_kind === 'document') {
      patch.source_kind = body.source_kind;
      // When demoting a template back to document, wipe the schema
      // (the user explicitly said this isn't a template).
      if (body.source_kind === 'document') {
        patch.template_schema = null;
        patch.template_status = 'none';
      }
    }
  }
  // Will be set after the patch lands, so we can kick auto-detect
  // when a doc is being promoted to a template without an existing
  // schema. Detection populates template_schema asynchronously.
  let needsDetectKick = false;
  if (body.template_schema && typeof body.template_schema === 'object' && !Array.isArray(body.template_schema)) {
    // Light validation — keep vars to 25, label/key length caps.
    const incoming = body.template_schema;
    const vars = Array.isArray(incoming.vars) ? incoming.vars.slice(0, 25) : [];
    const validTypes = new Set(['text', 'longtext', 'date', 'currency', 'percent', 'state', 'party_block', 'signature_block']);
    const cleaned = vars.map((v) => ({
      key: String(v?.key || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80),
      label: String(v?.label || '').trim().slice(0, 120),
      type: validTypes.has(v?.type) ? v.type : 'text',
      hint: String(v?.hint || '').trim().slice(0, 300),
      placeholder_text: String(v?.placeholder_text || '').trim().slice(0, 200),
      occurrences: Math.max(1, Math.min(999, parseInt(v?.occurrences, 10) || 1)),
    })).filter((v) => v.key && v.label);
    patch.template_schema = {
      vars: cleaned,
      auto_detected: !!incoming.auto_detected,
      detected_at: incoming.detected_at || null,
      confidence: typeof incoming.confidence === 'number' ? incoming.confidence : null,
      model_used: incoming.model_used || null,
      user_edited_at: new Date().toISOString(),
    };
    patch.template_status = 'ready';
  }
  // Default letterhead flag — mutex: setting one true must unset any
  // other true for the same user. Setting false is unconditional.
  let willSetDefaultLetterhead = null;
  if (typeof body.is_default_letterhead === 'boolean') {
    patch.is_default_letterhead = body.is_default_letterhead;
    willSetDefaultLetterhead = body.is_default_letterhead;
  }
  if (Object.keys(patch).length === 0) {
    return json({ error: 'Nothing to update' }, 400);
  }

  const supabase = getSupabaseAdmin();

  // Mutex enforcement for the default-letterhead flag — clear any
  // existing default on this user before flipping the new one. We
  // do this BEFORE the main update so the partial unique index
  // doesn't fire. Skip if we're explicitly clearing (setting false).
  if (willSetDefaultLetterhead === true) {
    await supabase
      .from('workspace_vault_items')
      .update({ is_default_letterhead: false })
      .eq('user_id', auth.user.id)
      .eq('is_default_letterhead', true)
      .neq('id', id);
  }

  // Pre-fetch the existing row so we can decide whether to kick
  // auto-detect post-update. The kick only happens when the user
  // promoted a document to a template AND it doesn't already have
  // a populated schema.
  if (patch.source_kind === 'template') {
    const { data: existing } = await supabase
      .from('workspace_vault_items')
      .select('id, source_kind, template_schema')
      .eq('id', id)
      .eq('user_id', auth.user.id)
      .maybeSingle();
    const hasVars = existing?.template_schema
      && Array.isArray(existing.template_schema.vars)
      && existing.template_schema.vars.length > 0;
    if (!hasVars && !patch.template_schema) {
      // Tell the post-update step to kick detection on this id.
      needsDetectKick = true;
    }
  }

  const { data, error } = await supabase
    .from('workspace_vault_items')
    .update(patch)
    .eq('id', id)
    .eq('user_id', auth.user.id)
    .select('*')
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!data) return json({ error: 'Not found' }, 404);

  if (needsDetectKick) {
    try {
      const { kickTemplateDetect } = await import('../lib/template-detect.js');
      kickTemplateDetect({
        itemId: data.id,
        userId: auth.user.id,
        contentLen: typeof data.content === 'string' ? data.content.length : 0,
      });
    } catch (err) {
      console.warn('[vault-update] template-detect kick failed:', err?.message || err);
    }
  }

  return json({ item: data });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
