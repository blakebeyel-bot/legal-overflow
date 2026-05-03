/**
 * GET /api/get-review?review_id=<uuid>
 *
 * Polling endpoint. Returns current review state plus, if complete,
 * signed download URLs for the three output files.
 *
 * Auth: user access token via Authorization: Bearer <token>
 */
import { requireUser, getSupabaseAdmin } from '../lib/supabase-admin.js';

const DOWNLOAD_URL_TTL_SECONDS = 3600; // 1 hour

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });

  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);

  const url = new URL(req.url);
  const reviewId = url.searchParams.get('review_id');
  if (!reviewId) return json({ error: 'review_id required' }, 400);

  const supabase = getSupabaseAdmin();
  const { data: review, error } = await supabase
    .from('reviews')
    .select('id, user_id, filename, contract_type, pipeline_mode, severity_counts, status, progress_message, annotated_url, summary_url, findings_json_url, error_message, total_tokens, cost_usd, created_at, completed_at, streamed_findings')
    .eq('id', reviewId)
    .single();

  if (error || !review || review.user_id !== auth.user.id) {
    return json({ error: 'Review not found' }, 404);
  }

  // Attach signed URLs if the review is complete
  const downloads = {};
  if (review.status === 'complete') {
    for (const [field, key] of [
      ['annotated',     review.annotated_url],
      ['summary',       review.summary_url],
      ['findings_json', review.findings_json_url],
    ]) {
      if (!key) continue;
      const { data, error: e } = await supabase.storage
        .from('reviews-output')
        .createSignedUrl(key, DOWNLOAD_URL_TTL_SECONDS);
      if (!e && data) downloads[field] = data.signedUrl;
    }
  }

  // Current quota status for the UI's "X of 3 reviews used" widget
  const { data: window } = await supabase
    .from('reviews_current_window').select('reviews_total').eq('user_id', auth.user.id).maybeSingle();

  return json({
    review: {
      id: review.id,
      filename: review.filename,
      contract_type: review.contract_type,
      pipeline_mode: review.pipeline_mode,
      status: review.status,
      progress_message: review.progress_message,
      severity_counts: review.severity_counts,
      error_message: review.error_message,
      total_tokens: review.total_tokens,
      cost_usd: review.cost_usd,
      created_at: review.created_at,
      completed_at: review.completed_at,
      // Live preview of findings as specialists complete. Pre-compiler
      // and pre-coherence — items here may get deduped or pruned in
      // the final review. The UI shows them with a "preview" label
      // during the analyze/audit stages.
      streamed_findings: Array.isArray(review.streamed_findings) ? review.streamed_findings : [],
    },
    downloads,
    quota: {
      used: window?.reviews_total || 0,
      cap: 3, // TODO: read from profile.tier
    },
  });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
