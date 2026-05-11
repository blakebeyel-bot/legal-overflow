/**
 * POST /api/admin-update-user
 *
 * Single endpoint for all admin actions on a user profile:
 *   - approve / revoke
 *   - set per-user review / citation cap overrides
 *   - set tier (trial / standard / pro / admin)
 *   - set approval note
 *
 * Body (JSON):
 *   {
 *     user_id: string,                  // required
 *     approve?: boolean,                // true = approve now, false = revoke
 *     approval_note?: string,
 *     review_cap_override?: number|null,
 *     citation_cap_override?: number|null,
 *     tier?: 'trial' | 'standard' | 'pro' | 'admin' | 'enterprise'
 *   }
 *
 * Admin only.
 */
import { requireAdmin, getSupabaseAdmin } from '../lib/supabase-admin.js';

const VALID_TIERS = new Set(['trial', 'standard', 'pro', 'admin', 'enterprise']);

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const auth = await requireAdmin(req.headers.get('Authorization'));
  if (!auth.ok) return json({ error: auth.error }, auth.status);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const { user_id, approve, approval_note, review_cap_override, citation_cap_override, tier } = body || {};
  if (!user_id || typeof user_id !== 'string') {
    return json({ error: 'user_id required' }, 400);
  }

  const update = {};
  if (typeof approve === 'boolean') {
    update.approved_at = approve ? new Date().toISOString() : null;
  }
  if (typeof approval_note === 'string') {
    update.approval_note = approval_note.slice(0, 500);
  }
  if (review_cap_override === null || (typeof review_cap_override === 'number' && review_cap_override >= 0)) {
    update.review_cap_override = review_cap_override;
  }
  if (citation_cap_override === null || (typeof citation_cap_override === 'number' && citation_cap_override >= 0)) {
    update.citation_cap_override = citation_cap_override;
  }
  if (typeof tier === 'string') {
    if (!VALID_TIERS.has(tier)) {
      return json({ error: `Invalid tier: ${tier}` }, 400);
    }
    update.tier = tier;
  }
  if (Object.keys(update).length === 0) {
    return json({ error: 'No update fields provided' }, 400);
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('profiles')
    .update(update)
    .eq('id', user_id)
    .select('id, email, tier, approved_at, approval_note, review_cap_override, citation_cap_override, full_name, organization')
    .single();
  if (error) return json({ error: error.message }, 500);

  // Side effect: when a user is APPROVED (approve === true), trigger a
  // Supabase magic-link email so they hear about it without having to
  // poll. Uses Supabase Auth's built-in mailer — no new email vendor.
  // Failure is non-fatal: the DB row is the source of truth; the email
  // is a courtesy.
  if (approve === true) {
    try {
      const siteUrl = process.env.URL
        || process.env.DEPLOY_PRIME_URL
        || 'https://legaloverflow.com';
      const linkOpts = {
        redirectTo: `${siteUrl.replace(/\/$/, '')}/workspace/`,
      };
      // Pass approval_note + full_name through to the email template so
      // the dashboard-side template can render `{{ .Data.approval_note }}`.
      const tplData = {};
      if (data?.approval_note) tplData.approval_note = data.approval_note;
      if (data?.full_name) tplData.full_name = data.full_name;
      if (Object.keys(tplData).length) linkOpts.data = tplData;

      const { error: linkErr } = await supabase.auth.admin.generateLink({
        type: 'magiclink',
        email: data?.email,
        options: linkOpts,
      });
      if (linkErr) {
        console.warn(`[admin-update-user] magiclink send failed for ${user_id}: ${linkErr.message}`);
      } else {
        console.log(`[admin-update-user] approval magiclink dispatched to ${data?.email}`);
      }
    } catch (mailErr) {
      console.warn(`[admin-update-user] magiclink threw for ${user_id}: ${mailErr?.message || mailErr}`);
    }
  }

  return json({ ok: true, user: data });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
