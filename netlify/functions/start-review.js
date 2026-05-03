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
import { detectParties } from '../lib/detect-parties.js';
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

  // Parse deal_posture (now collected upfront in the UI). Optional at the
  // API level so legacy clients still work — but the UI requires it.
  let dealPosture = null;

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

  // deal_posture is part of the form — validated here, saved on reviews row
  const postureRaw = formData.get('deal_posture');
  const ALLOWED_POSTURES = new Set([
    'our_paper', 'their_paper_high_leverage', 'their_paper_low_leverage', 'negotiated_draft',
  ]);
  if (postureRaw && typeof postureRaw === 'string' && ALLOWED_POSTURES.has(postureRaw)) {
    dealPosture = postureRaw;
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
      deal_posture: dealPosture,
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
  let classification = {
    contract_type: 'unclassified',
    pipeline_mode: 'standard',
    confidence: 0,
  };
  try {
    const resp = await callModel({
      agentName: 'document-classifier',
      systemPrompt: classifier.systemPrompt,
      userMessage:
        `Classify the following contract. Return ONLY a JSON object with keys:\n` +
        `  "contract_type"  — string, e.g. "master_services_agreement", "order_form", "sow", "nda", "subscription_agreement", "purchase_order", "work_order", "license_agreement", ...\n` +
        `  "pipeline_mode"  — always "standard" (the only mode we run; included for shape compatibility)\n` +
        `  "confidence"     — number 0-1 representing how certain you are about contract_type. Be honest; low confidence is better than wrong.\n` +
        `  "is_subordinate" — boolean. True if the document is an order_form, sow, work_order, statement_of_work, addendum, or similar document that references or is governed by a separate master agreement.\n` +
        `  "reasoning"      — one-sentence string.\n\n` +
        `CONFIDENCE GUIDE:\n` +
        `  0.9+: unambiguous match — clearly labeled as the type, standard structure present.\n` +
        `  0.7–0.89: likely but with some ambiguity.\n` +
        `  0.4–0.69: plausible but uncertain — document is malformed, mixed, or atypical.\n` +
        `  <0.4: unclassifiable.\n\n` +
        `CONTRACT:\n${contractText.slice(0, 20_000)}`,
      userId: auth.user.id,
      reviewId,
      maxTokens: 1024,
    });
    const parsed = extractJson(resp.text);
    if (parsed && parsed.contract_type) {
      classification = {
        contract_type: parsed.contract_type,
        pipeline_mode: parsed.pipeline_mode || 'standard',
        confidence: Number.isFinite(parsed.confidence) ? parsed.confidence : 0.5,
        is_subordinate: parsed.is_subordinate === true,
        reasoning: parsed.reasoning || '',
      };
    }
  } catch (err) {
    console.error('classifier failed, defaulting to standard:', err.message);
  }

  // Pipeline mode is now fixed at "standard" — the express/comprehensive
  // variants were removed (express was unfinished, comprehensive only
  // added one extra specialist already folded into standard). The
  // classifier may still emit a mode hint, but we ignore it and run the
  // single validated review path.
  classification.pipeline_mode = 'standard';

  // Party detection: identify the parties + their Defined Terms so the
  // intake confirm panel can ask the user which one they represent. Runs
  // in parallel with classification persistence; failure returns []
  // (UI falls back to the legacy free-text role).
  let detectedParties = [];
  try {
    detectedParties = await detectParties(contractText, { userId: auth.user.id, reviewId });
  } catch (err) {
    console.error('[start-review] detectParties failed:', err.message);
  }

  await supabase.from('reviews').update({
    contract_type: classification.contract_type,
    pipeline_mode: classification.pipeline_mode,
    classification_confidence: classification.confidence,
    detected_parties: detectedParties.length ? detectedParties : null,
    status: 'classifying',
    progress_message: `Classified as ${classification.contract_type} — awaiting confirmation.`,
  }).eq('id', reviewId);

  // DO NOT fire fanout here. The UI displays the classification, optionally
  // prompts for MSA context if is_subordinate, then calls confirm-review
  // which actually kicks the background fanout.
  return json({
    ok: true,
    review_id: reviewId,
    contract_type: classification.contract_type,
    pipeline_mode: classification.pipeline_mode,
    confidence: classification.confidence,
    is_subordinate: !!classification.is_subordinate,
    reasoning: classification.reasoning || '',
    detected_parties: detectedParties,
    quota,
    profile_mode: hasProfile ? 'configured' : 'baseline_only',
    deal_posture: dealPosture,
  });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
