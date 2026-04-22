/**
 * POST /api/classify
 *
 * Runs the document-classifier agent on an already-extracted contract text.
 * Returns { contract_type, pipeline_mode, reasoning }.
 *
 * The full pipeline runs in fanout-background.js — classify.js is kept
 * separate so the UI can show "classified as X, running Y specialists..."
 * before the long fan-out begins.
 *
 * Input body (JSON):
 *   { review_id: string, contract_text: string }
 *
 * Auth: user access token via Authorization: Bearer <token>
 */
import { requireUser, getSupabaseAdmin } from '../lib/supabase-admin.js';
import { getAgent } from '../lib/agents.js';
import { callModel, extractJson } from '../lib/anthropic.js';

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const { review_id, contract_text } = body;
  if (!review_id || !contract_text) {
    return json({ error: 'review_id and contract_text are required' }, 400);
  }

  const supabase = getSupabaseAdmin();

  // Verify the caller owns this review
  const { data: review } = await supabase
    .from('reviews')
    .select('id, user_id, status')
    .eq('id', review_id)
    .single();
  if (!review || review.user_id !== auth.user.id) {
    return json({ error: 'Review not found' }, 404);
  }

  const classifier = getAgent('document-classifier');
  let result;
  try {
    const resp = await callModel({
      agentName: 'document-classifier',
      systemPrompt: classifier.systemPrompt,
      userMessage: `Classify the following contract. Return ONLY a JSON object with keys "contract_type" (string), "pipeline_mode" (one of "express"|"standard"|"comprehensive"), and "reasoning" (one-sentence string).\n\nCONTRACT:\n${contract_text.slice(0, 20_000)}`,
      userId: auth.user.id,
      reviewId: review_id,
      maxTokens: 1024,
    });
    result = extractJson(resp.text);
  } catch (err) {
    await supabase.from('reviews').update({
      status: 'failed',
      error_message: `classifier failed: ${err.message}`,
    }).eq('id', review_id);
    return json({ error: err.message }, 500);
  }

  // Persist classification onto the review row
  await supabase.from('reviews').update({
    contract_type: result.contract_type,
    pipeline_mode: result.pipeline_mode,
    status: 'classifying',
    progress_message: `Classified as ${result.contract_type} — running ${result.pipeline_mode} pipeline.`,
  }).eq('id', review_id);

  return json({ ok: true, ...result });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
