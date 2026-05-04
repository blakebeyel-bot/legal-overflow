/**
 * POST /api/workspace-workflows-save
 *   body: {
 *     id?: uuid,                       // upsert if provided
 *     title: string,
 *     description?: string,
 *     kind: 'chat' | 'tabular',
 *     prompt_md?: string,              // for chat workflows: system prompt body
 *     columns_config?: [{name, prompt}], // for tabular workflows
 *     practice_area?: string,
 *   }
 *
 * Creates or updates a USER-OWNED workflow. To publish system-wide
 * workflows (visible to all approved users) operators use
 * /api/admin-workflows-save instead — that endpoint requires admin
 * tier and writes user_id=null + is_published=true rows.
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

const KINDS = new Set(['chat', 'tabular']);

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const body = await req.json().catch(() => ({}));
  const title = String(body.title || '').trim().slice(0, 200);
  const description = String(body.description || '').slice(0, 2000);
  const kind = String(body.kind || '').toLowerCase();
  const promptMd = String(body.prompt_md || '').slice(0, 50_000);
  const practice = body.practice_area ? String(body.practice_area).trim().slice(0, 100) : null;
  const columns = Array.isArray(body.columns_config) ? body.columns_config.slice(0, 25) : null;

  if (!title) return json({ error: 'Title required' }, 400);
  if (!KINDS.has(kind)) return json({ error: 'kind must be chat or tabular' }, 400);
  if (kind === 'chat' && !promptMd.trim()) return json({ error: 'Chat workflows need a prompt body' }, 400);
  if (kind === 'tabular' && (!columns || columns.length === 0)) return json({ error: 'Tabular workflows need at least one column' }, 400);

  const normColumns = columns ? columns.map((c, i) => ({
    index: i,
    name: String(c.name || `Column ${i + 1}`).slice(0, 100),
    prompt: String(c.prompt || '').slice(0, 2000),
  })) : null;

  const payload = {
    user_id: auth.user.id,
    title,
    description,
    kind,
    prompt_md: kind === 'chat' ? promptMd : '',
    columns_config: normColumns,
    practice_area: practice,
    is_system: false,
    is_published: false,
  };

  const supabase = getSupabaseAdmin();
  let result;
  if (body.id) {
    // Update — verify ownership first.
    const { data: existing } = await supabase
      .from('workspace_workflows')
      .select('id, user_id')
      .eq('id', body.id)
      .maybeSingle();
    if (!existing || existing.user_id !== auth.user.id) {
      return json({ error: 'Workflow not found or not yours' }, 404);
    }
    const { data, error } = await supabase
      .from('workspace_workflows')
      .update({ title, description, kind, prompt_md: payload.prompt_md, columns_config: normColumns, practice_area: practice })
      .eq('id', body.id)
      .select('*')
      .single();
    if (error) return json({ error: error.message }, 500);
    result = data;
  } else {
    const { data, error } = await supabase
      .from('workspace_workflows')
      .insert(payload)
      .select('*')
      .single();
    if (error) return json({ error: error.message }, 500);
    result = data;
  }

  return json({ workflow: result });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
