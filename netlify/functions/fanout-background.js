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
import { DEFAULT_PROFILE } from '../lib/default-profile.js';

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
  // 1. Load the user's profile. If none exists, fall back to a minimal
  //    default — the review will produce Tier-2 (industry-baseline)
  //    findings only, since the profile's red_flags / positions are empty.
  const { data: profileRow } = await supabase
    .from('company_profiles').select('profile_json').eq('user_id', userId).maybeSingle();
  const profile = profileRow?.profile_json || DEFAULT_PROFILE;
  if (!profileRow) {
    console.log(`[fanout-background] No profile for user ${userId} — using DEFAULT_PROFILE (industry-baseline review).`);
  }

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

  // 5. Run the "analyze" stage in parallel
  const analyzeStage = pipeline.stages.find(s => s.stage === 'analyze');
  const specialists = analyzeStage?.agents || [];

  await updateProgress(
    supabase, reviewId, 'analyzing',
    `Running ${specialists.length} specialist${specialists.length === 1 ? '' : 's'} in parallel…`,
  );

  let tokensUsed = 0;
  let completedCount = 0;
  const allFindings = [];
  const specialistResults = await Promise.allSettled(
    specialists.map(async (agentName) => {
      const agent = getAgent(agentName);
      const resp = await callSpecialist({
        agentName,
        systemPrompt: agent.systemPrompt,
        profileJson: profile,
        contractText,
        taskPrompt:
          `Review the contract above against the company profile. The profile is AUTHORITATIVE — treat it as the client's own instructions and prioritize accordingly.\n\n` +
          `PRIORITY ORDER for your findings:\n\n` +
          `TIER 1 — PROFILE-DRIVEN (highest priority). Anything tied to this specific client's stated preferences. Include the matching profile path in the finding's "profile_refs" array:\n` +
          `  1a. Provisions in the contract that MATCH an entry in profile.red_flags (use the red flag's severity; set requires_senior_review=true if auto_escalate).\n` +
          `  1b. Provisions in the contract that VIOLATE profile.positions.<your_category>.rejects (severity: Blocker or Major).\n` +
          `  1c. Provisions in the contract that MISALIGN with profile.positions.<your_category>.accepts (severity: Major).\n` +
          `  1d. Provisions REQUIRED by profile.positions.<your_category>.accepts that are ABSENT from the contract (markup_type: "insert", severity: Major — these are missing required provisions).\n\n` +
          `TIER 2 — INDUSTRY-BASELINE (lower priority, fills gaps). Only AFTER Tier 1 is exhausted, apply your own system-level checklist using profile.company.industry and profile.company.role_in_contracts as context. Do NOT second-guess a Tier-1 finding with a generic industry check — the profile wins.\n` +
          `  Examples of Tier-2 absence findings when applicable and not already covered by the profile: a SaaS agreement without any SLA, a services agreement without a limitation-of-liability cap, a contract handling personal data without a DPA reference, an indefinite term without termination-for-convenience, a subscription without data export/deletion rights at termination.\n` +
          `  Tier-2 findings MUST leave profile_refs empty and set severity based on industry impact (usually Moderate unless it's a clear safety rail like absent liability cap).\n\n` +
          `For ABSENCE findings (Tier 1d or Tier 2): 'location' can say "Entire agreement — missing"; use a short anchor from the nearest related section as 'source_text' for insert placement, or 'anchor_text': null + 'markup_type': "annotate" if no related section exists.\n\n` +
          `Return ONLY a JSON array of findings matching the schema defined in your system prompt. Order: all Tier-1 findings first, then Tier-2. No preface, no prose.`,
        userId, reviewId,
        maxTokens: 8192,
        tokensUsedSoFar: tokensUsed,
      });
      tokensUsed += (resp.usage.input_tokens || 0) + (resp.usage.output_tokens || 0);
      let findings;
      try { findings = extractJson(resp.text); } catch (e) {
        console.error(`${agentName} returned non-JSON:`, e.message);
        findings = [];
      }
      // Bump the completed counter and update progress_message so the
      // UI sees forward motion during the longest stage. Best-effort —
      // a failed update doesn't block the review.
      completedCount++;
      try {
        await updateProgress(
          supabase, reviewId, 'analyzing',
          `Specialists: ${completedCount} of ${specialists.length} complete — just finished ${humanizeAgent(agentName)}…`,
        );
      } catch {}
      console.log(`[fanout-background] ${agentName} done (${completedCount}/${specialists.length})`);
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
      taskPrompt:
        `The specialist fan-out has already produced these findings:\n\n${JSON.stringify(allFindings)}\n\n` +
        `Run your final sweep with strict PRIORITY ORDER. The profile is AUTHORITATIVE.\n\n` +
        `TIER 1 — PROFILE-DRIVEN (highest priority).\n` +
        `  1a. RED-FLAG SWEEP. Check every entry in profile.red_flags against the contract using its trigger_phrases + semantic confirmation. Emit findings for confirmed hits with severity from the red_flag entry; set requires_senior_review=true if auto_escalate. Include "profile_refs": ["red_flags.<id>"].\n` +
        `  1b. PROFILE-REQUIRED ABSENCE SWEEP. For every position the profile treats as accepted/required (profile.positions.<category>.accepts entries, preferred_language, etc.) that is NOT in the contract, emit an absence finding. Include the profile path in profile_refs.\n\n` +
        `TIER 2 — INDUSTRY-BASELINE (lower priority, fills gaps).\n` +
        `  Independent of the profile's explicit lists, audit for categorically absent provisions that a contract of this type SHOULD contain based on profile.company.industry and profile.company.role_in_contracts. ` +
        `Common omissions to flag when applicable AND not already covered above: SLA, limitation of liability cap, DPA / data processing, data security + breach notification, termination for convenience, data export/deletion rights at termination, indemnification structure, warranty scope, governing law + venue, subcontractor flow-down for compliance-sensitive industries. ` +
        `Tier-2 findings leave profile_refs empty.\n\n` +
        `DO NOT duplicate findings already in the specialist list above — the compiler dedupes but effort is wasted.\n` +
        `DO NOT reorder or contradict Tier-1 findings with Tier-2 reasoning. The profile wins.\n\n` +
        `Return ONLY a JSON array of ADDITIONAL findings, Tier-1 first then Tier-2. Empty array if the specialists covered everything.`,
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
      taskPrompt:
        `Deduplicate and consolidate the findings below. Enforce the voice rules in your system prompt — no case citations, no severity labels in external_comment, no profile references in external_comment.\n\n` +
        `ORDERING RULES (important — the client reads findings top-to-bottom):\n` +
        `1. Sort FIRST by tier: findings with a non-empty profile_refs array (Tier 1 — client-specific, playbook-driven) BEFORE findings with empty profile_refs (Tier 2 — generic industry baseline).\n` +
        `2. Within each tier, sort by severity: Blocker > Major > Moderate > Minor.\n` +
        `3. When deduplicating, if a Tier-1 finding and a Tier-2 finding cover the same issue, KEEP the Tier-1 version (it references the client's specific playbook language).\n\n` +
        `Return ONLY the cleaned JSON array in the sorted order above.\n\n` +
        `FINDINGS:\n${JSON.stringify(allFindings)}`,
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

/**
 * Turn an agent id like "risk-allocation-analyst" into a friendly name
 * "risk allocation analyst" for the UI's progress_message.
 */
function humanizeAgent(name) {
  return String(name).replace(/-/g, ' ').replace(/\banalyst\b/, '').trim()
    || name;
}

function tallySeverities(findings) {
  const t = { blocker: 0, major: 0, moderate: 0, minor: 0 };
  for (const f of findings) {
    const sev = (f.severity || '').toLowerCase();
    if (t[sev] != null) t[sev]++;
  }
  return t;
}
