/**
 * POST /api/verify-citations-start
 *
 * Single entry point for "user uploaded a brief for citation form-check."
 *
 *   1. Auth check via Supabase JWT.
 *   2. Validate file size, format, and disclaimer acceptance.
 *   3. Insert a verification_runs row (status='queued').
 *   4. Upload the source file to citation-verifier-incoming.
 *   5. Record the disclaimer acceptance.
 *   6. Fire the verify-citations-pipeline-background function.
 *   7. Return run_id so the UI can poll verify-citations-status.
 *
 * Body: multipart/form-data
 *   file              — required, .docx or .pdf, ≤50MB
 *   style             — 'bluepages' | 'whitepages' (default 'bluepages')
 *   ruleset           — 'federal' (default; v1 only supports federal)
 *   retain_text       — 'true' | 'false' (default 'false')
 *   disclaimer_version — required text, e.g. "1.0"
 */

import { requireUser, getSupabaseAdmin, checkCitationQuota, checkUserApproval } from '../lib/supabase-admin.js';
import { MODEL_ID, MAX_UPLOAD_BYTES } from '../lib/constants.js';
import { createHash } from 'node:crypto';

const ALLOWED_EXT = new Set(['docx', 'pdf']);
const ALLOWED_STYLES = new Set(['bluepages', 'whitepages']);
const ALLOWED_RULESETS = new Set(['federal']);

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);

  // Approval gate (Florida Rule 4-1.7 / 4-1.18 / 4-1.1). Pending users
  // get a 403 with a message the UI surfaces as a "pending approval" panel.
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) {
    return json({
      error: 'Your account is pending approval. We review every signup before granting access to the agents. You will receive an email once approved.',
      pending_approval: true,
    }, 403);
  }

  // Quota gate — same shape as the contract-review path. Trial users get
  // 3 verifications per 30-day window; the response carries the full
  // quota state so the UI can render the paywall card.
  const quota = await checkCitationQuota(auth.user.id);
  if (!quota.allowed) {
    return json({
      error: `Quota exceeded — ${quota.used} of ${quota.cap} citation checks used in the last 30 days.`,
      quota,
    }, 429);
  }

  let formData;
  try {
    formData = await req.formData();
  } catch {
    return json({ error: 'Expected multipart/form-data with a "file" field' }, 400);
  }

  // --- File ---
  const file = formData.get('file');
  if (!file || typeof file === 'string') return json({ error: 'No file uploaded' }, 400);
  if (file.size > MAX_UPLOAD_BYTES) {
    return json({ error: `File exceeds ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB cap` }, 413);
  }
  const filename = file.name || 'brief';
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return json({ error: `Unsupported format: .${ext}. Citation Verifier accepts .docx and .pdf only.` }, 400);
  }

  // --- Other fields ---
  const style = String(formData.get('style') || 'bluepages').toLowerCase();
  if (!ALLOWED_STYLES.has(style)) {
    return json({ error: `Invalid style: ${style}. Allowed: bluepages, whitepages.` }, 400);
  }
  const ruleset = String(formData.get('ruleset') || 'federal').toLowerCase();
  if (!ALLOWED_RULESETS.has(ruleset)) {
    return json({ error: `Invalid ruleset: ${ruleset}. v1 supports federal only.` }, 400);
  }
  const retain_text = String(formData.get('retain_text') || 'false').toLowerCase() === 'true';
  const disclaimer_version = String(formData.get('disclaimer_version') || '').trim();
  if (!disclaimer_version) {
    return json({ error: 'disclaimer_version is required.' }, 400);
  }

  // --- File hash (for de-dup + audit) ---
  const buffer = Buffer.from(await file.arrayBuffer());
  const file_hash = createHash('sha256').update(buffer).digest('hex');

  const supabase = getSupabaseAdmin();

  // --- Insert verification_runs row ---
  const { data: run, error: insertErr } = await supabase
    .from('verification_runs')
    .insert({
      user_id: auth.user.id,
      file_hash,
      file_name: filename,
      file_format: ext,
      retain_text,
      bluebook_edition: '22e',
      ruleset,
      style,
      model_pass2: MODEL_ID,
      model_pass4: MODEL_ID,
      status: 'queued',
      status_progress: 0,
    })
    .select('id')
    .single();
  if (insertErr) return json({ error: insertErr.message }, 500);

  const runId = run.id;
  const incomingKey = `${auth.user.id}/${runId}/source.${ext}`;

  // --- Upload to storage ---
  const { error: upErr } = await supabase.storage
    .from('citation-verifier-incoming')
    .upload(incomingKey, buffer, {
      contentType: file.type || (ext === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
      upsert: false,
    });
  if (upErr) {
    await supabase.from('verification_runs').update({
      status: 'failed',
      error_message: upErr.message,
      completed_at: new Date().toISOString(),
    }).eq('id', runId);
    return json({ error: upErr.message }, 500);
  }

  // --- Record disclaimer acceptance ---
  // Hash IP + UA — never store raw values per BUILD_SPEC §16.
  const ipHash = hashIfPresent(req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || '');
  const uaHash = hashIfPresent(req.headers.get('user-agent') || '');
  await supabase.from('disclaimer_acceptances').insert({
    user_id: auth.user.id,
    surface: 'citation-verifier-upload',
    disclaimer_version,
    ip_hash: ipHash,
    user_agent_hash: uaHash,
  });

  // --- Fire background pipeline ---
  // Mirror the proven pattern in confirm-review.js → fanout-background.js:
  // build the URL with `new URL(path, req.url)` so it works whether the
  // function is hit via the production domain, a draft URL, or the local
  // netlify dev proxy. Don't swallow trigger failures — if the background
  // function can't be reached the user sees a real error rather than a
  // forever-queued row.
  const backgroundUrl = new URL('/.netlify/functions/verify-citations-pipeline-background', req.url).toString();
  try {
    const bgResp = await fetch(backgroundUrl, {
      method: 'POST',
      headers: {
        'Authorization': req.headers.get('Authorization') || '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ run_id: runId }),
    });
    console.log(`[verify-citations-start] background pipeline kicked: HTTP ${bgResp.status} for run ${runId}`);

    // Background functions return 202 Accepted on success. Anything else
    // means the function failed at cold-start before it could even update
    // the run row — capture it here so the user sees a real error rather
    // than a forever-queued row.
    if (bgResp.status !== 202 && bgResp.status >= 400) {
      const bodyText = await bgResp.text().catch(() => '');
      const detail = bodyText ? ` — ${bodyText.slice(0, 300)}` : '';
      await supabase.from('verification_runs').update({
        status: 'failed',
        error_message: `Background pipeline cold-start failed: HTTP ${bgResp.status}${detail}`,
        completed_at: new Date().toISOString(),
      }).eq('id', runId);
      return json({ error: `Background pipeline failed to start (HTTP ${bgResp.status})${detail}`, run_id: runId }, 500);
    }
  } catch (err) {
    console.error('[verify-citations-start] failed to kick background pipeline:', err);
    await supabase.from('verification_runs').update({
      status: 'failed',
      error_message: 'Could not start background pipeline: ' + (err.message || String(err)),
      completed_at: new Date().toISOString(),
    }).eq('id', runId);
    return json({ error: 'Background pipeline failed to start: ' + (err.message || ''), run_id: runId }, 500);
  }

  return json({
    ok: true,
    run_id: runId,
    style,
    ruleset,
    retain_text,
    quota,
  });
};

function hashIfPresent(s) {
  if (!s) return null;
  return createHash('sha256').update(s).digest('hex');
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
