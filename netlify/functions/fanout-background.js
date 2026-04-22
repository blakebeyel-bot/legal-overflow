/**
 * POST /api/fanout-background
 *
 * Background function — up to 15 min runtime. Runs the full pipeline:
 *   1. Specialists fan out in parallel
 *   2. critical-issues-auditor sweeps
 *   3. review-compiler deduplicates + generates summary
 *   4. Markup tools annotate the original document
 *   5. Outputs land in Supabase Storage
 *   6. reviews row updated to 'complete'
 *
 * The client fire-and-forgets this endpoint; polling happens via get-review.js.
 *
 * Input body (JSON):
 *   { review_id: string }
 *
 * Auth: user access token via Authorization: Bearer <token>
 */
import { requireUser, getSupabaseAdmin } from '../lib/supabase-admin.js';
import { getAgent, loadConfig } from '../lib/agents.js';
import { callSpecialist, callModel, extractJson } from '../lib/anthropic.js';
import { extractDocumentText } from '../lib/extract.js';
import { applyDocxMarkup } from '../lib/markup-docx.js';
import { applyPdfMarkup } from '../lib/markup-pdf.js';
import { buildReviewSummaryDocx } from '../lib/review-summary.js';
import { estimateCostUsd } from '../lib/constants.js';

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return new Response(auth.error, { status: auth.status });

  let body;
  try { body = await req.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
  const { review_id } = body;
  if (!review_id) return new Response('review_id required', { status: 400 });

  const supabase = getSupabaseAdmin();

  // Verify ownership
  const { data: review } = await supabase
    .from('reviews')
    .select('id, user_id, filename, pipeline_mode')
    .eq('id', review_id)
    .single();
  if (!review || review.user_id !== auth.user.id) {
    return new Response('Review not found', { status: 404 });
  }

  // Acknowledge immediately so Netlify records the 202 and keeps the function alive.
  // The actual work happens in processReview below, awaited synchronously within
  // this background function's 15-min budget.
  try {
    await processReview({ userId: auth.user.id, reviewId: review_id, supabase });
  } catch (err) {
    console.error('fanout-background failed:', err);
    await supabase.from('reviews').update({
      status: 'failed',
      error_message: err.message || String(err),
    }).eq('id', review_id);
    return new Response('Failed: ' + err.message, { status: 500 });
  }

  return new Response('ok', { status: 202 });
};

async function processReview({ userId, reviewId, supabase }) {
  // 1. Load the user's profile
  const { data: profileRow, error: profileErr } = await supabase
    .from('company_profiles').select('profile_json').eq('user_id', userId).single();
  if (profileErr || !profileRow) {
    throw new Error('No company profile found. Complete onboarding first.');
  }
  const profile = profileRow.profile_json;

  // 2. Load the review row
  const { data: review } = await supabase.from('reviews').select('*').eq('id', reviewId).single();
  if (!review) throw new Error('Review row missing');

  // 3. Download the contract from contracts-incoming
  const storagePath = `${userId}/${reviewId}/${review.filename}`;
  const { data: blob, error: dlErr } = await supabase.storage
    .from('contracts-incoming').download(storagePath);
  if (dlErr) throw new Error('Contract download failed: ' + dlErr.message);

  const contractBuffer = Buffer.from(await blob.arrayBuffer());
  const { text: contractText, format } = await extractDocumentText(contractBuffer, review.filename);

  // 4. Decide pipeline. Classifier may have already set pipeline_mode; default standard.
  const registry = loadConfig('agent_registry');
  const mode = review.pipeline_mode || 'standard';
  const pipeline = registry.pipeline_modes[mode];
  if (!pipeline) throw new Error(`Unknown pipeline mode: ${mode}`);

  await updateProgress(supabase, reviewId, 'analyzing', `Running ${mode} pipeline…`);

  // 5. Run the "analyze" stage in parallel
  const analyzeStage = pipeline.stages.find(s => s.stage === 'analyze');
  const specialists = analyzeStage?.agents || [];

  let tokensUsed = 0;
  const allFindings = [];
  const specialistResults = await Promise.allSettled(
    specialists.map(async (agentName) => {
      const agent = getAgent(agentName);
      const resp = await callSpecialist({
        agentName,
        systemPrompt: agent.systemPrompt,
        profileJson: profile,
        contractText,
        taskPrompt: `Apply your specialist checklist to the contract above. Return ONLY a JSON array of findings matching the schema defined in your system prompt. No preface, no prose.`,
        userId, reviewId,
        maxTokens: 8192,
        tokensUsedSoFar: tokensUsed,
      });
      tokensUsed += (resp.usage.input_tokens || 0) + (resp.usage.output_tokens || 0);
      let findings;
      try { findings = extractJson(resp.text); } catch (e) {
        console.error(`${agentName} returned non-JSON:`, e.message);
        return [];
      }
      return Array.isArray(findings) ? findings : [];
    })
  );
  for (const result of specialistResults) {
    if (result.status === 'fulfilled') allFindings.push(...result.value);
  }

  // 6. Critical-issues auditor (last, per CLAUDE.md §7)
  await updateProgress(supabase, reviewId, 'auditing', 'Running critical-issues auditor…');
  const auditor = getAgent('critical-issues-auditor');
  try {
    const auditResp = await callSpecialist({
      agentName: 'critical-issues-auditor',
      systemPrompt: auditor.systemPrompt,
      profileJson: profile,
      contractText,
      taskPrompt: `The following findings were produced by the specialist fan-out:\n\n${JSON.stringify(allFindings)}\n\nRun your red-flag sweep against the profile. Return ONLY additional findings as a JSON array (may be empty).`,
      userId, reviewId,
      maxTokens: 4096,
      tokensUsedSoFar: tokensUsed,
    });
    tokensUsed += (auditResp.usage.input_tokens || 0) + (auditResp.usage.output_tokens || 0);
    const auditFindings = extractJson(auditResp.text);
    if (Array.isArray(auditFindings)) allFindings.push(...auditFindings);
  } catch (e) {
    console.error('auditor failed:', e.message);
  }

  // 7. Review compiler — deduplicate + enforce voice/forbidden phrases
  await updateProgress(supabase, reviewId, 'compiling', 'Compiling review…');
  const compiler = getAgent('review-compiler');
  let compiledFindings = allFindings;
  try {
    const compileResp = await callSpecialist({
      agentName: 'review-compiler',
      systemPrompt: compiler.systemPrompt,
      profileJson: profile,
      contractText,
      taskPrompt: `Deduplicate and consolidate the findings below. Enforce the voice rules in your system prompt — no case citations, no severity labels in external_comment, no profile references in external_comment. Return ONLY the cleaned JSON array.\n\nFINDINGS:\n${JSON.stringify(allFindings)}`,
      userId, reviewId,
      maxTokens: 12_000,
      tokensUsedSoFar: tokensUsed,
    });
    tokensUsed += (compileResp.usage.input_tokens || 0) + (compileResp.usage.output_tokens || 0);
    const compiled = extractJson(compileResp.text);
    if (Array.isArray(compiled)) compiledFindings = compiled;
  } catch (e) {
    console.error('compiler failed, using raw findings:', e.message);
  }

  // 8. Apply markup
  let annotated, unanchored;
  if (format === 'docx') {
    const r = await applyDocxMarkup(contractBuffer, compiledFindings);
    annotated = r.buffer;
    unanchored = r.unanchored;
  } else if (format === 'pdf') {
    const r = await applyPdfMarkup(contractBuffer, compiledFindings);
    annotated = r.buffer;
    unanchored = r.unanchored;
  } else {
    annotated = contractBuffer;
    unanchored = compiledFindings; // can't place in plain text
  }

  // 9. Build the internal summary
  const severityCounts = tallySeverities(compiledFindings);
  const summaryBuffer = await buildReviewSummaryDocx({
    filename: review.filename,
    contractType: review.contract_type,
    pipelineMode: mode,
    findings: compiledFindings,
    unanchored,
    severityCounts,
    reviewedAt: new Date(),
  });

  // 10. Upload outputs to reviews-output bucket
  const ext = review.filename.split('.').pop();
  const baseName = review.filename.replace(/\.[^.]+$/, '');
  const annotatedKey = `${userId}/${reviewId}/${baseName}_Annotated.${ext}`;
  const summaryKey   = `${userId}/${reviewId}/${baseName}_Review_Summary.docx`;
  const findingsKey  = `${userId}/${reviewId}/findings.json`;

  await Promise.all([
    supabase.storage.from('reviews-output').upload(annotatedKey, annotated, {
      contentType: format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      upsert: true,
    }),
    supabase.storage.from('reviews-output').upload(summaryKey, summaryBuffer, {
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      upsert: true,
    }),
    supabase.storage.from('reviews-output').upload(findingsKey, Buffer.from(JSON.stringify(compiledFindings, null, 2)), {
      contentType: 'application/json',
      upsert: true,
    }),
  ]);

  // 11. Finalize review row
  await supabase.from('reviews').update({
    status: 'complete',
    progress_message: `Review complete. ${compiledFindings.length} finding(s) identified.`,
    severity_counts: severityCounts,
    annotated_url: annotatedKey,
    summary_url: summaryKey,
    findings_json_url: findingsKey,
    total_tokens: tokensUsed,
    cost_usd: estimateCostUsd({ inputTokens: tokensUsed, outputTokens: 0 }).toFixed(4),
    completed_at: new Date().toISOString(),
  }).eq('id', reviewId);
}

async function updateProgress(supabase, reviewId, status, message) {
  await supabase.from('reviews').update({
    status,
    progress_message: message,
  }).eq('id', reviewId);
}

function tallySeverities(findings) {
  const t = { blocker: 0, major: 0, moderate: 0, minor: 0 };
  for (const f of findings) {
    const sev = (f.severity || '').toLowerCase();
    if (t[sev] != null) t[sev]++;
  }
  return t;
}
