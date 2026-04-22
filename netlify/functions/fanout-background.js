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

  // 2a. Snapshot the profile onto the review row for audit. Lets us
  //     answer "why did we flag X in this review but not that one six
  //     months ago" — the profile may have changed since.
  try {
    await supabase.from('reviews').update({ profile_snapshot: profile }).eq('id', reviewId);
  } catch (e) { console.error('[fanout-background] profile_snapshot write failed:', e); }

  const dealPosture = review.deal_posture || null;
  const governingAgreementContext = review.governing_agreement_context || null;

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
          `You are reviewing the contract above on behalf of the client whose profile is your context. Act like a senior outside counsel doing a thoughtful redline — not a checklist bot.\n\n` +
          dealPostureBlock(dealPosture) +
          governingAgreementBlock(governingAgreementContext) +
          `STEP 0 — NAME YOUR ASSUMED JURISDICTION\n` +
          `Before you begin, identify the governing-law jurisdiction the contract specifies. If it is silent or ambiguous from the four corners of the document, state "not determinable from the four corners" in your reasoning and proceed conservatively (assume the client's home jurisdiction only when nothing else applies). Your absence-reasoning in STEP 2 must reflect this.\n\n` +
          `STEP 1 — PROVISIONS PRESENT (Tier 1 and Tier 2)\n` +
          `TIER 1 — CLIENT-SPECIFIC. Flag issues tied to the client's actual positions in their profile. Include the matching profile path in profile_refs:\n` +
          `  • Provisions matching profile.red_flags → use the red_flag's severity; set requires_senior_review=true if auto_escalate.\n` +
          `  • Provisions VIOLATING profile.positions.<your_category>.rejects → Blocker or Major.\n` +
          `  • Provisions meaningfully MISALIGNING with profile.positions.<your_category>.accepts → Major or Moderate, using judgment on magnitude. Minor wording differences that achieve the same effect are NOT findings.\n` +
          `TIER 2 — INDUSTRY BASELINE. Apply your system-level checklist to provisions the profile doesn't explicitly address. Leave profile_refs empty; severity based on real-world impact.\n\n` +
          `STEP 2 — ABSENT PROVISIONS — THE THREE-QUESTION GATE (strict)\n` +
          `Before you emit ANY absence finding, the playbook position (or your baseline check) must pass all three gates. If any fails, do NOT emit the finding.\n` +
          `  (a) Does this absence create CONCRETE exposure in THIS deal, given its size, posture, and transaction type? Name the dollar, operational, or legal exposure specifically.\n` +
          `  (b) Is the concern already covered — elsewhere in the contract, by an incorporated MSA/terms, or by background law in the governing jurisdiction you named in STEP 0?\n` +
          `  (c) Would a senior lawyer ACTUALLY fight for this in negotiation for a deal of this size and profile? Or would it die in the first round as a nit?\n\n` +
          `If an absence passes all three gates, prefer markup_type "annotate" unless there is a clean insertion point AND the omission is clearly material — then use "insert". Silence on a non-material absence is the correct answer.\n\n` +
          `STEP 3 — CAP AND CURATION\n` +
          `You may emit AT MOST 4 findings. If you have more candidates, keep the four whose materiality_rationale names the most concrete deal-specific harm. Proportionality is your job, not the compiler's.\n\n` +
          `STEP 4 — SUGGESTED LANGUAGE\n` +
          `Match the contract's drafting style and defined terms. Do not paste playbook.preferred_language verbatim unless it fits. Propose the minimum edit that solves the problem.\n\n` +
          `STEP 5 — TONE\n` +
          `This review goes to the counterparty. Frame findings as measured, market-standard positions. A redline that flags 30 things when 4 are material gets dismissed.\n\n` +
          `STRICT FINDING SCHEMA — every finding MUST include these fields:\n` +
          `  {\n` +
          `    category, location, source_text, anchor_text, markup_type,\n` +
          `    suggested_text, external_comment, internal_note, severity,\n` +
          `    profile_refs, requires_senior_review,\n` +
          `    materiality_rationale:      // 1-2 sentence concrete business harm if signed as-is, specific to THIS deal. If you cannot articulate one, do not emit the finding.\n` +
          `    playbook_fit:               // REQUIRED when profile_refs is non-empty. One of: "applies" | "applies_with_modification" | "overkill_for_this_deal". Only the first two may appear in your output — if the correct answer is "overkill_for_this_deal" you considered it and chose NOT to flag. (Omit this field when profile_refs is empty — it's a Tier-2 industry-baseline finding.)\n` +
          `    position:                   // the opening ask — your ideal clause language or demand\n` +
          `    fallback:                   // optional — the acceptable middle-ground language the client could live with\n` +
          `    walkaway:                   // optional — the point below which the client should NOT sign this deal\n` +
          `  }\n\n` +
          `Return ONLY a JSON array of findings. Order: all Tier-1 findings first, then Tier-2. No preface, no prose.`,
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
        `You are the final sweep — a senior partner's last read before the redline goes out.\n\n` +
        dealPostureBlock(dealPosture) +
        governingAgreementBlock(governingAgreementContext) +
        `STEP 0 — JURISDICTION. Identify the governing-law jurisdiction. If not determinable from the four corners, state so and proceed conservatively.\n\n` +
        `STEP 1 — RED-FLAG CHECK. For each entry in profile.red_flags that ACTUALLY appears in the contract (trigger_phrases + semantic confirmation), emit a finding with the red_flag's severity. Skip if a specialist already covered it.\n\n` +
        `STEP 2 — MATERIAL-OMISSION CHECK (three-question gate — same as specialists):\n` +
        `  (a) Concrete exposure in THIS deal?\n` +
        `  (b) Covered elsewhere in the contract or by background law in the named jurisdiction?\n` +
        `  (c) Would a senior lawyer actually fight this in negotiation?\n` +
        `If any gate fails, do NOT emit.\n\n` +
        `STEP 3 — CAP AT 3 ADDITIONAL FINDINGS. Your value is catching genuine misses, not expanding coverage. If the specialists already covered the serious items, return an empty array. Silence is acceptable.\n\n` +
        `STRICT FINDING SCHEMA — identical to specialists, required fields:\n` +
        `  materiality_rationale (concrete business harm), playbook_fit (when profile_refs non-empty; only "applies" or "applies_with_modification" may appear), position, optional fallback, optional walkaway.\n\n` +
        `Return ONLY a JSON array of ADDITIONAL findings (or empty array). No preface, no prose.`,
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
  let compiledPriorityThree = [];
  try {
    const compileResp = await callSpecialist({
      agentName: 'review-compiler',
      systemPrompt: compiler.systemPrompt,
      profileJson: profile,
      contractText,
      taskPrompt:
        `Consolidate and polish the findings below into a final redline. Enforce the voice rules in your system prompt — no case citations, no severity labels in external_comment, no profile references in external_comment.\n\n` +
        dealPostureBlock(dealPosture) +
        `STEP 1 — SCHEMA VALIDATION. Every finding MUST have:\n` +
        `  • materiality_rationale: non-empty 1-2 sentence concrete-harm statement specific to THIS deal.\n` +
        `  • position: non-empty string (the opening ask).\n` +
        `  • When profile_refs is non-empty: playbook_fit ∈ {"applies","applies_with_modification"}. Any "overkill_for_this_deal" or missing playbook_fit → DROP the finding.\n` +
        `DROP any finding that fails validation. If materiality_rationale is hand-wavy ("this could be risky", "market standard") without concrete deal-specific harm, DROP it.\n\n` +
        `STEP 2 — PROPORTIONALITY PRUNE.\n` +
        `  • Drop findings that are nits, redundant with a stronger finding, or would make the redline look unreasonable.\n` +
        `  • When two findings touch the same section, keep the higher-severity one and fold relevant context into its external_comment.\n` +
        `  • Target 4–10 total findings. A focused redline lands harder than a 25-item demand list.\n\n` +
        `STEP 3 — ORDERING.\n` +
        `  1. Tier-1 (non-empty profile_refs) before Tier-2.\n` +
        `  2. Within tier: Blocker > Major > Moderate > Minor.\n` +
        `  3. On Tier-1/Tier-2 overlap, keep the Tier-1 version.\n\n` +
        `STEP 4 — PRIORITY-THREE SELECTION.\n` +
        `From the pruned list, select up to 3 findings that a partner should raise on a phone call with the counterparty. Pick by: (severity × client-leverage × playbook priority). Blockers always qualify; Major issues with client-leverage implications qualify; nothing below Major should appear unless the deal has no higher-severity issues.\n\n` +
        `STEP 5 — VOICE POLISH.\n` +
        `  • suggested_text matches the contract's drafting style and defined terms.\n` +
        `  • external_comment reads as a measured senior-counsel suggestion, not an ultimatum.\n` +
        `  • Do NOT leak internal_note, materiality_rationale, position, fallback, or walkaway content into external_comment. Those are internal.\n\n` +
        `OUTPUT FORMAT — return ONE JSON object (not an array) with this exact shape:\n` +
        `  {\n` +
        `    "findings": [ ...cleaned & sorted finding objects... ],\n` +
        `    "priority_three": [ "finding_id_or_index_1", "finding_id_or_index_2", "finding_id_or_index_3" ]\n` +
        `  }\n` +
        `Use each finding's 'id' field if it has one, otherwise use the zero-based index into the findings array. priority_three should have 1–3 entries (empty only if the contract is entirely clean).\n\n` +
        `FINDINGS TO PROCESS:\n${JSON.stringify(allFindings)}`,
      userId, reviewId,
      maxTokens: 12_000,
      tokensUsedSoFar: tokensUsed,
    });
    tokensUsed += (compileResp.usage.input_tokens || 0) + (compileResp.usage.output_tokens || 0);
    const compiled = extractJson(compileResp.text);
    // Compiler now returns { findings, priority_three }. Fall back to
    // array shape for backward compatibility during rollout.
    if (Array.isArray(compiled)) {
      compiledFindings = compiled;
    } else if (compiled && Array.isArray(compiled.findings)) {
      compiledFindings = compiled.findings;
      compiledPriorityThree = Array.isArray(compiled.priority_three) ? compiled.priority_three : [];
    }
  } catch (e) {
    console.error('compiler failed, using raw findings:', e.message);
  }

  // Post-process: drop any finding missing required fields (final guardrail
  // in case the compiler didn't). Preserves the priority_three list but
  // filters out referenced IDs that got dropped.
  compiledFindings = compiledFindings.filter(f => {
    if (!f || typeof f !== 'object') return false;
    if (!f.materiality_rationale || typeof f.materiality_rationale !== 'string') return false;
    if (Array.isArray(f.profile_refs) && f.profile_refs.length > 0) {
      const fit = f.playbook_fit;
      if (fit !== 'applies' && fit !== 'applies_with_modification') return false;
    }
    if (!f.position || typeof f.position !== 'string') return false;
    return true;
  });
  // Assign stable ids so priority_three references survive markup / summary
  compiledFindings.forEach((f, i) => { if (!f.id) f.id = `f${i + 1}`; });
  // Resolve priority_three to actual findings (by id or index)
  const priorityFindings = (compiledPriorityThree || []).slice(0, 3).map(ref => {
    if (typeof ref === 'number') return compiledFindings[ref] || null;
    return compiledFindings.find(f => f.id === ref) || null;
  }).filter(Boolean);

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
    priorityThree: priorityFindings,
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
    supabase.storage.from('reviews-output').upload(findingsKey, Buffer.from(JSON.stringify({
      findings: compiledFindings,
      priority_three: priorityFindings.map(f => f.id),
    }, null, 2)), {
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
 * Prompt-injection for deal posture. Materially changes how aggressive
 * the specialists should be about flagging deviations from the playbook.
 */
function dealPostureBlock(posture) {
  if (!posture) return '';
  const text = {
    our_paper:
      `DEAL POSTURE: OUR PAPER\n` +
      `This is the client's own form. Deviations from playbook positions are unusual and should be explained — raise the bar for ACCEPTING deviations. Any edit the counterparty made that weakens our position deserves scrutiny. Maintain confidence in the client's preferred language.\n\n`,
    their_paper_high_leverage:
      `DEAL POSTURE: THEIR PAPER, WE NEED THIS DEAL\n` +
      `The client has low leverage. Only blocker-level issues justify pushback; nits and minor misalignments should be suppressed hard. Be pragmatic — what would realistically get conceded without risking the deal? Your redline should look like you were reviewing for a partner who needs this contract signed, not winning a paper war. Soft-pedal the language of suggestions. Prefer "annotate" over "insert" or "replace" unless a provision creates truly material exposure.\n\n`,
    their_paper_low_leverage:
      `DEAL POSTURE: THEIR PAPER, THEY NEED THIS DEAL\n` +
      `The client has strong leverage. Be direct about deviations from the playbook — a Major finding here is genuinely a Major. Don't soft-pedal; the counterparty is motivated to accept reasonable edits. Still avoid nit-picks that would signal inexperience.\n\n`,
    negotiated_draft:
      `DEAL POSTURE: NEGOTIATED DRAFT\n` +
      `Both sides are actively editing. Focus on provisions that remain open or that have drifted from prior rounds; assume counterparty has already pushed back on anything obvious. Propose compromises where the playbook position is extreme. Call out anything that has changed materially from standard market positions.\n\n`,
  }[posture];
  return text || '';
}

/**
 * Prompt-injection for governing-agreement context. Only present when the
 * user indicated the contract is subordinate to an MSA and provided context.
 */
function governingAgreementBlock(ctx) {
  if (!ctx) return '';
  if (ctx.mode === 'summary' && ctx.text) {
    return (
      `GOVERNING AGREEMENT CONTEXT (user-supplied summary of the MSA this document sits under):\n` +
      `${ctx.text}\n\n` +
      `Use this context to avoid flagging provisions already handled by the MSA. A clause absent from this document may be covered by the MSA above — check before emitting absence findings. Cite "the governing MSA" (not the playbook) when referring to provisions you assume are covered upstream.\n\n`
    );
  }
  if (ctx.mode === 'file') {
    return (
      `GOVERNING AGREEMENT CONTEXT: the user uploaded a governing MSA (storage key: ${ctx.storage_key}). For this review pass, assume the MSA contains standard-market provisions for the clauses this document leaves out. Do not demand insertion of clauses you would reasonably expect an MSA to cover (indemnity, liability cap, IP ownership, confidentiality, governing law) unless this document expressly overrides them.\n\n`
    );
  }
  return '';
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
