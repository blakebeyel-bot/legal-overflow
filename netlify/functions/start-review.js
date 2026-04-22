/**
 * POST /api/start-review
 *
 * Single entry point for "user hit Upload Contract." Does all of:
 *   1. Checks quota (3 / 30d for trial)
 *   2. Creates a reviews row (status='queued')
 *   3. Uploads contract bytes to contracts-incoming bucket
 *   4. Extracts text, calls classifier synchronously (fast)
 *   5. Fires the background fan-out function
 *   6. Returns review_id so the UI can poll get-review.js
 *
 * Body: multipart/form-data with a "file" field
 * Auth: user access token via Authorization: Bearer <token>
 */
import { requireUser, getSupabaseAdmin, checkReviewQuota } from '../lib/supabase-admin.js';
import { getAgent } from '../lib/agents.js';
import { callModel, extractJson } from '../lib/anthropic.js';
import { extractDocumentText } from '../lib/extract.js';
import { MAX_UPLOAD_BYTES } from '../lib/constants.js';

const ALLOWED_EXT = new Set(['docx', 'pdf', 'txt', 'md']);

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);

  // Profile is OPTIONAL. If absent, fanout-background falls back to the
  // default profile and produces an industry-baseline review. Tell the
  // client in the response so the UI can show a "baseline only" note.
  const supabase = getSupabaseAdmin();
  const { data: profileRow } = await supabase
    .from('company_profiles').select('id').eq('user_id', auth.user.id).maybeSingle();
  const hasProfile = !!profileRow;

  // Quota gate
  const quota = await checkReviewQuota(auth.user.id);
  if (!quota.allowed) {
    return json({
      error: `Quota exceeded — ${quota.used} of ${quota.cap} reviews used in the last 30 days.`,
      quota,
    }, 429);
  }

  // Parse multipart
  let formData;
  try {
    formData = await req.formData();
  } catch {
    return json({ error: 'Expected multipart/form-data with a "file" field' }, 400);
  }
  const file = formData.get('file');
  if (!file || typeof file === 'string') {
    return json({ error: 'No file uploaded' }, 400);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return json({ error: `File exceeds ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB cap` }, 413);
  }

  const filename = file.name || 'contract';
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return json({ error: `Unsupported format: .${ext}. Allowed: .docx, .pdf, .txt, .md` }, 400);
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  // Create the review row — status 'queued' — before uploading. If upload
  // fails we still have a trail.
  const { data: review, error: insertErr } = await supabase
    .from('reviews')
    .insert({
      user_id: auth.user.id,
      filename,
      status: 'queued',
      progress_message: 'Uploaded; extracting text…',
    })
    .select('id').single();
  if (insertErr) return json({ error: insertErr.message }, 500);

  const reviewId = review.id;

  // Upload to storage (path matches fanout-background.js expectations)
  const storagePath = `${auth.user.id}/${reviewId}/${filename}`;
  const { error: upErr } = await supabase.storage
    .from('contracts-incoming').upload(storagePath, buffer, {
      contentType: file.type || 'application/octet-stream',
      upsert: false,
    });
  if (upErr) {
    await supabase.from('reviews').update({ status: 'failed', error_message: upErr.message }).eq('id', reviewId);
    return json({ error: upErr.message }, 500);
  }

  // Extract + classify synchronously (the classifier is fast; UI wants to
  // show "classified as X, running Y" before polling)
  let contractText;
  try {
    const extracted = await extractDocumentText(buffer, filename);
    contractText = extracted.text;
  } catch (err) {
    await supabase.from('reviews').update({ status: 'failed', error_message: err.message }).eq('id', reviewId);
    return json({ error: err.message }, 400);
  }

  const classifier = getAgent('document-classifier');
  let classification = { contract_type: 'unclassified', pipeline_mode: 'standard' };
  try {
    const resp = await callModel({
      agentName: 'document-classifier',
      systemPrompt: classifier.systemPrompt,
      userMessage:
        `Classify the following contract. Return ONLY a JSON object with keys ` +
        `"contract_type" (string), "pipeline_mode" (one of "express"|"standard"|"comprehensive"), ` +
        `and "reasoning" (one-sentence string).\n\nCONTRACT:\n${contractText.slice(0, 20_000)}`,
      userId: auth.user.id,
      reviewId,
      maxTokens: 1024,
    });
    const parsed = extractJson(resp.text);
    if (parsed && parsed.contract_type) classification = parsed;
  } catch (err) {
    // Classification failure isn't fatal — default to standard pipeline
    console.error('classifier failed, defaulting to standard:', err.message);
  }

  await supabase.from('reviews').update({
    contract_type: classification.contract_type,
    pipeline_mode: classification.pipeline_mode,
    status: 'classifying',
    progress_message: `Classified as ${classification.contract_type} — starting ${classification.pipeline_mode} pipeline.`,
  }).eq('id', reviewId);

  // Fire the background function (fire-and-forget)
  const backgroundUrl = new URL('/.netlify/functions/fanout-background', req.url).toString();
  fetch(backgroundUrl, {
    method: 'POST',
    headers: {
      'Authorization': req.headers.get('Authorization'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ review_id: reviewId }),
  }).catch(err => console.error('failed to kick background fanout:', err));

  return json({
    ok: true,
    review_id: reviewId,
    contract_type: classification.contract_type,
    pipeline_mode: classification.pipeline_mode,
    quota,
    profile_mode: hasProfile ? 'configured' : 'baseline_only',
  });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
