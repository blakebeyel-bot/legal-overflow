/**
 * POST /api/admin-workflows-save  (admin tier required)
 *   body: { id?, title, description?, kind, prompt_md?, columns_config?, practice_area?, is_published?: boolean }
 *
 * Manages SYSTEM workflows — rows with user_id=null. Operators use
 * this to publish curated FL-specific playbooks visible to every
 * approved user. Setting is_published=false unpublishes (hides from
 * users without deleting).
 */
import { requireAdmin, getSupabaseAdmin } from '../lib/supabase-admin.js';

const KINDS = new Set(['chat', 'tabular']);

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const auth = await requireAdmin(req.headers.get('Authorization'));
  if (!auth.ok) return json({ error: auth.error }, auth.status);

  const body = await req.json().catch(() => ({}));
  const title = String(body.title || '').trim().slice(0, 200);
  const description = String(body.description || '').slice(0, 2000);
  const kind = String(body.kind || '').toLowerCase();
  const promptMd = String(body.prompt_md || '').slice(0, 50_000);
  const practice = body.practice_area ? String(body.practice_area).trim().slice(0, 100) : null;
  const columns = Array.isArray(body.columns_config) ? body.columns_config.slice(0, 25) : null;
  const isPublished = body.is_published !== false;   // default true for admin-saved

  if (!title) return json({ error: 'Title required' }, 400);
  if (!KINDS.has(kind)) return json({ error: 'kind must be chat or tabular' }, 400);
  if (kind === 'chat' && !promptMd.trim()) return json({ error: 'Chat workflows need a prompt body' }, 400);
  if (kind === 'tabular' && (!columns || columns.length === 0)) return json({ error: 'Tabular workflows need at least one column' }, 400);

  const normColumns = columns ? columns.map((c, i) => ({
    index: i,
    name: String(c.name || `Column ${i + 1}`).slice(0, 100),
    prompt: String(c.prompt || '').slice(0, 2000),
  })) : null;

  const supabase = getSupabaseAdmin();
  let result;
  if (body.id) {
    const { data, error } = await supabase
      .from('workspace_workflows')
      .update({
        title, description, kind,
        prompt_md: kind === 'chat' ? promptMd : '',
        columns_config: normColumns,
        practice_area: practice,
        is_published: isPublished,
      })
      .eq('id', body.id)
      .is('user_id', null)
      .select('*')
      .single();
    if (error) return json({ error: error.message }, 500);
    result = data;
  } else {
    const { data, error } = await supabase
      .from('workspace_workflows')
      .insert({
        user_id: null, is_system: true, is_published: isPublished,
        title, description, kind,
        prompt_md: kind === 'chat' ? promptMd : '',
        columns_config: normColumns,
        practice_area: practice,
      })
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
