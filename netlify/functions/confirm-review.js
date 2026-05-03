/**
 * POST /api/confirm-review
 *
 * Called by the UI after start-review returns a classification. Finalizes
 * the review's pipeline_mode (which the user may have overridden), saves
 * governing-agreement context if the document is subordinate, and kicks
 * off fanout-background.
 *
 * Body (JSON):
 *   {
 *     review_id: string,
 *     pipeline_mode?: "standard",  // sole valid value; legacy field, ignored on server
 *     governing_agreement_context?: {
 *       mode: "summary" | "file",
 *       text?: string,           // for mode="summary"
 *       storage_key?: string     // for mode="file" — a previously-uploaded MSA
 *     } | null,
 *     client_party?: {
 *       name?: string,           // legal entity name as written in contract
 *       defined_term: string     // contract's Defined Term for this party
 *     } | null
 *   }
 *
 * Auth: user access token via Authorization: Bearer <token>
 */
import { requireUser, getSupabaseAdmin } from '../lib/supabase-admin.js';

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const { review_id, pipeline_mode, governing_agreement_context, client_party } = body || {};
  if (!review_id) return json({ error: 'review_id required' }, 400);

  const supabase = getSupabaseAdmin();

  // Verify ownership + current state
  const { data: review } = await supabase
    .from('reviews')
    .select('id, user_id, status')
    .eq('id', review_id)
    .maybeSingle();
  if (!review || review.user_id !== auth.user.id) {
    return json({ error: 'Review not found' }, 404);
  }
  if (review.status !== 'classifying' && review.status !== 'queued') {
    return json({ error: `Review already past confirmation stage (status=${review.status})` }, 400);
  }

  // Pipeline mode is always "standard" now. We still write it to the
  // reviews row so legacy reads (review-summary, get-review) keep
  // displaying something sane — but we ignore whatever the client sent.
  const update = {
    pipeline_mode_confirmed_at: new Date().toISOString(),
    pipeline_mode: 'standard',
  };
  if (governing_agreement_context && typeof governing_agreement_context === 'object') {
    // Basic shape validation
    const { mode, text, storage_key } = governing_agreement_context;
    if (mode === 'summary' && typeof text === 'string' && text.trim()) {
      update.governing_agreement_context = { mode: 'summary', text: text.slice(0, 12_000) };
    } else if (mode === 'file' && typeof storage_key === 'string') {
      update.governing_agreement_context = { mode: 'file', storage_key };
    }
  }

  // Client-party selection from the intake party picker. defined_term is
  // the only required field — name is informational. Length capped to
  // protect against pathological inputs.
  if (client_party && typeof client_party === 'object'
      && typeof client_party.defined_term === 'string'
      && client_party.defined_term.trim()) {
    update.client_party = {
      name: typeof client_party.name === 'string' ? client_party.name.slice(0, 200) : '',
      defined_term: client_party.defined_term.slice(0, 80).trim(),
    };
  }

  const { error: updErr } = await supabase.from('reviews').update(update).eq('id', review_id);
  if (updErr) return json({ error: updErr.message }, 500);

  // Fire fanout-background (awaited — fire-and-forget gets aborted on Lambda)
  const backgroundUrl = new URL('/.netlify/functions/fanout-background', req.url).toString();
  try {
    const bgResp = await fetch(backgroundUrl, {
      method: 'POST',
      headers: {
        'Authorization': req.headers.get('Authorization'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ review_id }),
    });
    console.log(`[confirm-review] background fanout kicked: HTTP ${bgResp.status}`);
  } catch (err) {
    console.error('[confirm-review] failed to kick background fanout:', err);
    await supabase.from('reviews').update({
      status: 'failed',
      error_message: 'Could not start background review: ' + err.message,
    }).eq('id', review_id);
    return json({ error: 'Background fanout failed to start: ' + err.message }, 500);
  }

  return json({ ok: true, review_id });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
