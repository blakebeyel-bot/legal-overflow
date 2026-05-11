/**
 * POST /api/template-seed-system
 *   header: X-Admin-Secret: <env TEMPLATE_SEED_ADMIN_SECRET>
 *
 * One-shot endpoint to seed the pre-built template catalog as
 * system-owned vault items (user_id = NULL). Idempotent — re-running
 * upserts each template by slug stored in tags. Safe to call after
 * deploys to refresh content.
 *
 * Not user-facing. Hit it manually from a terminal once after deploy:
 *   curl -X POST -H "X-Admin-Secret: $SECRET" \
 *     https://yoursite.netlify.app/api/template-seed-system
 *
 * Each template:
 *   1. Build .docx bytes via SYSTEM_TEMPLATES catalog
 *   2. Upload to library bucket at: system/templates/<slug>.docx
 *   3. Upsert workspace_vault_items with user_id=NULL,
 *      source_kind='template', template_schema, template_storage_path
 *
 * Returns: { seeded: [...slugs], skipped: [...] }
 */
import { getSupabaseAdmin } from '../lib/supabase-admin.js';
import { SYSTEM_TEMPLATES, buildTemplateDocx } from '../lib/template-seed-content.js';

export default async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });

  const secret = process.env.TEMPLATE_SEED_ADMIN_SECRET || '';
  if (!secret) {
    return new Response('TEMPLATE_SEED_ADMIN_SECRET not set on server', { status: 500 });
  }
  const provided = req.headers.get('X-Admin-Secret') || '';
  if (provided !== secret) {
    return new Response('forbidden', { status: 403 });
  }

  const supabase = getSupabaseAdmin();
  const seeded = [];
  const skipped = [];
  const failed = [];

  for (const entry of SYSTEM_TEMPLATES) {
    try {
      // 1. Build the .docx bytes.
      const { buffer } = await buildTemplateDocx(entry.slug);

      // 2. Upload to library bucket. System path: system/templates/<slug>.docx
      const storageKey = `system/templates/${entry.slug}.docx`;
      const { error: upErr } = await supabase.storage
        .from('library')
        .upload(storageKey, buffer, {
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          upsert: true,
        });
      if (upErr) {
        console.error(`[template-seed] upload failed for ${entry.slug}:`, upErr.message);
        failed.push({ slug: entry.slug, error: upErr.message });
        continue;
      }

      // 3. Build the text content (rendered as a preview of the
      //    template — used for semantic search visibility).
      const previewLines = [`# ${entry.title}`, '', entry.summary, ''];
      for (const v of entry.schema.vars) {
        previewLines.push(`- ${v.label} (${v.type}): ${v.hint || ''}`);
      }
      const content = previewLines.join('\n');

      // 4. Upsert vault row by slug tag. We look for an existing
      //    system row with the slug tag; if found, update; else insert.
      const slugTag = `system-template:${entry.slug}`;
      const { data: existing } = await supabase
        .from('workspace_vault_items')
        .select('id')
        .is('user_id', null)
        .eq('source_kind', 'template')
        .contains('tags', [slugTag])
        .maybeSingle();

      const row = {
        source_kind: 'template',
        title: entry.title,
        summary: entry.summary,
        tags: ['system-template', slugTag],
        content,
        template_schema: {
          vars: entry.schema.vars,
          auto_detected: false,
          detected_at: new Date().toISOString(),
          confidence: 1.0,
          model_used: null,
          system_seeded: true,
        },
        template_status: 'ready',
        template_storage_path: storageKey,
      };

      if (existing?.id) {
        const { error: updErr } = await supabase
          .from('workspace_vault_items')
          .update(row)
          .eq('id', existing.id);
        if (updErr) {
          console.error(`[template-seed] update failed for ${entry.slug}:`, updErr.message);
          failed.push({ slug: entry.slug, error: updErr.message });
          continue;
        }
      } else {
        const { error: insErr } = await supabase
          .from('workspace_vault_items')
          .insert({ ...row, user_id: null });
        if (insErr) {
          console.error(`[template-seed] insert failed for ${entry.slug}:`, insErr.message);
          failed.push({ slug: entry.slug, error: insErr.message });
          continue;
        }
      }

      seeded.push(entry.slug);
    } catch (err) {
      console.error(`[template-seed] failed for ${entry.slug}:`, err);
      failed.push({ slug: entry.slug, error: err?.message || String(err) });
    }
  }

  return new Response(JSON.stringify({ seeded, skipped, failed }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
