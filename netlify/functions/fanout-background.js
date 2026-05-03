/**
 * POST /api/fanout-background
 *
 * Background function — up to 15 min runtime. Runs the full pipeline:
 *   1. Specialists fan out in parallel — each returns { coverage_pass, findings }
 *   2. critical-issues-auditor — catches material omissions, cross-section
 *      hazards, and existential-escalation items the specialists missed
 *   3. review-compiler (LLM) — schema-validates, dedupes, proportionality
 *      prunes, orders, and selects priority_three
 *   4. posture-integrity (DETERMINISTIC + LLM-ambiguous) — rejects
 *      role-inverted edits
 *   5. coherence-checker — catches contradictions created by the edit set,
 *      reviews rejected findings for restore
 *   6. Markup tools annotate the original document (unchanged — same
 *      margin-comment + tracked-changes rendering)
 *   7. Outputs land in Supabase Storage, reviews row finalized
 *
 * Input body (JSON):
 *   { review_id: string }
 */
import { requireUser, getSupabaseAdmin } from '../lib/supabase-admin.js';
import { getAgent, loadConfig } from '../lib/agents.js';
import { callSpecialist, callModel, extractJson } from '../lib/anthropic.js';
import { extractDocumentText } from '../lib/extract.js';
import { applyDocxMarkup } from '../lib/markup-docx.js';
// PDF markup goes through the Modal/PyMuPDF service. The wrapper falls
// back to the legacy drawn-line markup if the Modal env vars aren't set,
// so the function keeps working in environments without the Python
// service configured.
import { applyPdfMarkup } from '../lib/markup-pdf-modal.js';
import { buildReviewSummaryDocx } from '../lib/review-summary.js';
import { estimateCostUsd } from '../lib/constants.js';
import { DEFAULT_PROFILE } from '../lib/default-profile.js';
import { runPostureIntegrity, checkFinding as postureCheckFinding } from '../lib/posture-integrity.js';

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return new Response(auth.error, { status: auth.status });

  let body;
  try { body = await req.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
  const { review_id } = body;
  if (!review_id) return new Response('review_id required', { status: 400 });

  const supabase = getSupabaseAdmin();

  const { data: review } = await supabase
    .from('reviews')
    .select('id, user_id, filename, pipeline_mode')
    .eq('id', review_id)
    .single();
  if (!review || review.user_id !== auth.user.id) {
    return new Response('Review not found', { status: 404 });
  }

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
  // 1. Load profile (fall back to DEFAULT_PROFILE if user has none)
  const { data: profileRow } = await supabase
    .from('company_profiles').select('profile_json').eq('user_id', userId).maybeSingle();
  const profile = profileRow?.profile_json || DEFAULT_PROFILE;
  if (!profileRow) console.log(`[fanout-background] No profile — using DEFAULT_PROFILE.`);

  // 2. Load review row + context inputs
  const { data: review } = await supabase.from('reviews').select('*').eq('id', reviewId).single();
  if (!review) throw new Error('Review row missing');

  // Snapshot profile for audit
  try {
    await supabase.from('reviews').update({ profile_snapshot: profile }).eq('id', reviewId);
  } catch (e) { console.error('[fanout-background] profile_snapshot write failed:', e); }

  const dealPosture = review.deal_posture || null;
  const governingAgreementContext = review.governing_agreement_context || null;
  const clientRole = profile?.company?.role_in_contracts || 'unknown';
  const jurisdiction = profile?.jurisdiction?.primary || 'not determinable from four corners';
  const contractType = review.contract_type || 'unclassified';
  // Party-detection output: when the user picked a party at intake, its
  // Defined Term is the authoritative label for specialists' drafted
  // language. Pass null when missing; specialists fall back to CLIENT_ROLE.
  const clientDefinedTerm = review.client_party?.defined_term || null;
  const clientName = review.client_party?.name || null;

  // 3. Download + extract contract
  const storagePath = `${userId}/${reviewId}/${review.filename}`;
  const { data: blob, error: dlErr } = await supabase.storage
    .from('contracts-incoming').download(storagePath);
  if (dlErr) throw new Error('Contract download failed: ' + dlErr.message);

  const contractBuffer = Buffer.from(await blob.arrayBuffer());
  const { text: contractText, format } = await extractDocumentText(contractBuffer, review.filename);

  // 4. Pipeline mode
  const registry = loadConfig('agent_registry');
  const mode = review.pipeline_mode || 'standard';
  const pipeline = registry.pipeline_modes[mode];
  if (!pipeline) throw new Error(`Unknown pipeline mode: ${mode}`);

  const analyzeStage = pipeline.stages.find(s => s.stage === 'analyze');
  const specialists = resolveSpecialists(analyzeStage, registry, profile);
  console.log(`[fanout-background] resolved specialists (${specialists.length}): ${specialists.join(', ')}`);

  await updateProgress(supabase, reviewId, 'analyzing',
    `Running ${specialists.length} specialist${specialists.length === 1 ? '' : 's'} in parallel…`);

  // 5. STAGE 1 — Specialists fan out
  const specialistTaskEnvelope = buildSpecialistEnvelope({
    clientRole, clientDefinedTerm, clientName, dealPosture, contractType, governingAgreementContext, jurisdiction,
  });

  let tokensUsed = 0;
  let completedCount = 0;
  const allFindings = [];
  const allCoverage = [];
  const specialistFailures = []; // tracked and surfaced to both findings.json + Review_Summary.docx

  // Run a single specialist and return the outcome envelope. Hoisted so
  // we can sequence the first call (to warm the prompt cache) and fan
  // the rest out in parallel. See the warm-cache comment below.
  const runSpecialist = async (agentName) => {
    const outcome = { agentName, findings: [], coverage: [], error: null };
    try {
      const agent = getAgent(agentName);
      if (!agent || !agent.systemPrompt) {
        outcome.error = `agent "${agentName}" not found in bundle (agents-data.js) — may be missing from netlify/agents/ or the bundle build`;
        console.error(`[specialist-failure] ${agentName}: ${outcome.error}`);
        return outcome;
      }
      const resp = await callSpecialist({
        agentName,
        systemPrompt: agent.systemPrompt,
        profileJson: profile,
        contractText,
        taskPrompt: specialistTaskEnvelope,
        userId, reviewId,
        // 4096 is well above any specialist's actual usage on every run we've
        // measured (longest was ~3500 tokens). 8192 was leaving a long-tail
        // window where a runaway specialist would generate for an extra
        // minute with no benefit. The compiler still ranks/dedupes whatever
        // each specialist produces, so capping output is safe.
        maxTokens: 4096,
        tokensUsedSoFar: tokensUsed,
      });
      tokensUsed += (resp.usage.input_tokens || 0) + (resp.usage.output_tokens || 0);

      let parsed;
      try {
        parsed = extractJson(resp.text);
      } catch (e) {
        outcome.error = `non-JSON output from model: ${e.message}`;
        console.error(`[specialist-failure] ${agentName} returned non-JSON:`, e.message);
        parsed = { coverage_pass: [], findings: [] };
      }
      const { findings, coverage } = normalizeSpecialistOutput(parsed, agentName);
      outcome.findings = findings;
      outcome.coverage = coverage;

      if (coverage.length === 0 && !outcome.error) {
        outcome.error =
          'returned empty coverage_pass — the specialist is required by its system prompt to enumerate every hard-requirement item in its domain, so an empty array indicates either model failure or prompt drift';
        console.warn(`[specialist-failure] ${agentName}: empty coverage_pass`);
      }

      completedCount++;
      try {
        await updateProgress(supabase, reviewId, 'analyzing',
          `Specialists: ${completedCount} of ${specialists.length} complete — just finished ${humanizeAgent(agentName)}…`);
      } catch {}
      console.log(`[fanout-background] ${agentName} done: ${findings.length} findings, ${coverage.length} coverage entries${outcome.error ? ' (flagged: ' + outcome.error + ')' : ''}`);
    } catch (err) {
      outcome.error = `invocation failed: ${err.message || String(err)}`;
      console.error(`[specialist-failure] ${agentName} invocation failed:`, err);
    }
    return outcome;
  };

  // Warm-cache sequencing. The profile + contract blocks are identical
  // across every specialist call and Anthropic's prompt cache will reuse
  // them — but only AFTER one call has written the cache. If we fire all
  // 6 specialists simultaneously they all miss and each pays the full
  // input-token toll. By awaiting the first call, then fanning the rest
  // out in parallel, the remaining 5 land on a warm cache and read the
  // ~6 KB contract block cheaply, shaving ~20-40 s off wall time.
  const firstOutcome = specialists.length > 0
    ? await runSpecialist(specialists[0])
    : null;
  const remainingResults = await Promise.allSettled(
    specialists.slice(1).map((agentName) => runSpecialist(agentName)),
  );
  const specialistResults = firstOutcome
    ? [{ status: 'fulfilled', value: firstOutcome }, ...remainingResults]
    : remainingResults;

  for (const r of specialistResults) {
    if (r.status === 'fulfilled') {
      allFindings.push(...r.value.findings);
      allCoverage.push(...r.value.coverage);
      if (r.value.error) {
        specialistFailures.push({ specialist: r.value.agentName, reason: r.value.error });
      }
    } else {
      // Shouldn't happen since we catch inside the map, but belt-and-suspenders
      specialistFailures.push({
        specialist: '(unknown — Promise.allSettled rejected)',
        reason: `rejected promise: ${r.reason?.message || String(r.reason)}`,
      });
      console.error('[specialist-failure] unexpected rejection:', r.reason);
    }
  }

  // Presence assertion: every specialist in the resolved list MUST contribute
  // at least one coverage entry. Any that didn't get added to specialist_failures
  // with an explicit reason — the review summary then flags the missing coverage
  // so the reviewer knows the review is incomplete rather than silently ships it.
  const contributors = new Set(allCoverage.map(c => c.specialist).filter(Boolean));
  for (const expected of specialists) {
    if (!contributors.has(expected)) {
      const alreadyFlagged = specialistFailures.some(f => f.specialist === expected);
      if (!alreadyFlagged) {
        specialistFailures.push({
          specialist: expected,
          reason: 'expected specialist did not contribute any coverage entries — review is incomplete in this specialist\'s domain',
        });
        console.error(`[specialist-failure] ${expected}: MISSING from coverage_pass`);
      }
    }
  }

  // 6. STAGE 2 — Critical-issues auditor
  await updateProgress(supabase, reviewId, 'auditing', 'Running critical-issues auditor…');
  const auditor = getAgent('critical-issues-auditor');
  try {
    const auditResp = await callSpecialist({
      agentName: 'critical-issues-auditor',
      systemPrompt: auditor.systemPrompt,
      profileJson: profile,
      contractText,
      taskPrompt: buildAuditorEnvelope({
        clientRole, clientDefinedTerm, clientName, dealPosture, contractType, governingAgreementContext, jurisdiction,
        specialistFindings: allFindings, coveragePass: allCoverage,
      }),
      userId, reviewId,
      maxTokens: 4096,
      tokensUsedSoFar: tokensUsed,
    });
    tokensUsed += (auditResp.usage.input_tokens || 0) + (auditResp.usage.output_tokens || 0);
    let auditParsed;
    try { auditParsed = extractJson(auditResp.text); } catch { auditParsed = null; }
    const { findings: auditFindings } = normalizeSpecialistOutput(auditParsed || {}, 'critical-issues-auditor');
    allFindings.push(...auditFindings);
    console.log(`[fanout-background] auditor added ${auditFindings.length} findings`);
  } catch (e) {
    console.error('auditor failed:', e.message);
  }

  // 7. STAGE 3 — Compiler (LLM)
  await updateProgress(supabase, reviewId, 'compiling', 'Compiling review…');
  const compiler = getAgent('review-compiler');
  let acceptedFindings = allFindings;
  let rejectedFindings = [];
  let coveragePassAggregate = allCoverage;
  let priorityIds = [];
  let compilerMetrics = {};
  try {
    const compileResp = await callSpecialist({
      agentName: 'review-compiler',
      systemPrompt: compiler.systemPrompt,
      profileJson: profile,
      contractText,
      taskPrompt: buildCompilerEnvelope({
        clientRole, clientDefinedTerm, clientName, dealPosture, contractType, governingAgreementContext, jurisdiction,
        allFindings, allCoverage,
      }),
      userId, reviewId,
      maxTokens: 12_000,
      tokensUsedSoFar: tokensUsed,
    });
    tokensUsed += (compileResp.usage.input_tokens || 0) + (compileResp.usage.output_tokens || 0);

    const compiled = extractJson(compileResp.text);
    if (compiled && typeof compiled === 'object' && !Array.isArray(compiled)) {
      acceptedFindings = Array.isArray(compiled.accepted_findings) ? compiled.accepted_findings : allFindings;
      rejectedFindings = Array.isArray(compiled.rejected_findings) ? compiled.rejected_findings : [];
      coveragePassAggregate = Array.isArray(compiled.coverage_pass_aggregate) ? compiled.coverage_pass_aggregate : allCoverage;
      priorityIds = Array.isArray(compiled.priority_three) ? compiled.priority_three : [];
      compilerMetrics = compiled.metrics || {};
    } else if (Array.isArray(compiled)) {
      // Legacy shape fallback
      acceptedFindings = compiled;
    }
  } catch (e) {
    console.error('compiler failed, using raw findings:', e.message);
  }

  // Final schema-validation guardrail
  acceptedFindings = acceptedFindings.filter(validateFindingSchema);
  // Stable IDs so priority refs resolve
  acceptedFindings.forEach((f, i) => { if (!f.id) f.id = `f${i + 1}`; });

  // 8. STAGE 4 — Deterministic posture-integrity pass
  await updateProgress(supabase, reviewId, 'compiling', 'Running posture-integrity check…');
  const postureResult = await runPostureIntegrity({
    findings: acceptedFindings,
    clientRole,
    callModel,
    userId, reviewId,
  });
  const postureMetrics = postureResult.metrics;
  // Add posture-rejected to the rejected pile
  for (const r of postureResult.rejected) {
    rejectedFindings.push({
      ...r.finding,
      rejection_reason: r.reason,
      rejection_rule: r.rule,
      rejection_source: r.source,
    });
  }
  acceptedFindings = postureResult.accepted;
  console.log(`[fanout-background] posture-integrity: ${postureMetrics.deterministic_pass} pass, ${postureMetrics.deterministic_fail} fail, ${postureMetrics.escalated} escalated (${postureMetrics.escalation_fail} failed)`);

  // 9. STAGE 5 — Coherence check
  await updateProgress(supabase, reviewId, 'compiling', 'Coherence-check sweep…');
  let coherenceFindings = [];
  let restoredFindings = [];
  try {
    const coherenceAgent = getAgent('coherence-checker');
    const coherenceResp = await callSpecialist({
      agentName: 'coherence-checker',
      systemPrompt: coherenceAgent.systemPrompt,
      profileJson: profile,
      contractText,
      taskPrompt: buildCoherenceEnvelope({
        clientRole, clientDefinedTerm, clientName, dealPosture, contractType, governingAgreementContext, jurisdiction,
        acceptedFindings, rejectedFindings, coveragePassAggregate,
      }),
      userId, reviewId,
      maxTokens: 4096,
      tokensUsedSoFar: tokensUsed,
    });
    tokensUsed += (coherenceResp.usage.input_tokens || 0) + (coherenceResp.usage.output_tokens || 0);
    let cParsed;
    try { cParsed = extractJson(coherenceResp.text); } catch { cParsed = null; }
    coherenceFindings = Array.isArray(cParsed?.findings) ? cParsed.findings : [];
    restoredFindings = Array.isArray(cParsed?.restored_findings) ? cParsed.restored_findings : [];
    // Tag + alias each coherence finding
    coherenceFindings.forEach(aliasProposedText);
    restoredFindings.forEach(aliasProposedText);
    coherenceFindings.forEach((f, i) => {
      f.specialist = 'coherence-checker';
      if (!f.id) f.id = `c${i + 1}`;
      if (!f.category) f.category = 'coherence';
    });
    // Re-run posture-integrity on restored findings (defense in depth)
    const safeRestored = [];
    for (const rf of restoredFindings) {
      const check = postureCheckFinding(rf, clientRole);
      if (check.verdict !== 'fail') safeRestored.push(rf);
      else console.log(`[fanout-background] restore blocked by posture-integrity: ${rf.id || '(no id)'}`);
    }
    restoredFindings = safeRestored;
    console.log(`[fanout-background] coherence-check: ${coherenceFindings.length} new + ${restoredFindings.length} restored`);
  } catch (e) {
    console.error('coherence-checker failed:', e.message);
  }

  // Final compiled list: accepted + coherence + restored
  const finalFindings = [
    ...acceptedFindings,
    ...coherenceFindings,
    ...restoredFindings,
  ];

  // Resolve priority_three to actual finding objects (post all pipeline stages)
  const priorityFindings = priorityIds
    .slice(0, 3)
    .map(ref => {
      if (typeof ref === 'number') return finalFindings[ref] || null;
      return finalFindings.find(f => f.id === ref) || null;
    })
    .filter(Boolean);

  // 10. STAGE 6 — Apply markup
  await updateProgress(supabase, reviewId, 'compiling', 'Applying markup…');
  // Reviewer-name attribution lives on the company profile under
  // output.reviewer_author (per company_profile.schema.json). Set on the
  // "Tell us how you negotiate" intake form via the "Your name" field,
  // which the workflow-configurator agent maps into the schema. Fallback
  // to "Legal Overflow" when the user hasn't set one.
  const reviewerName = (profile?.output?.reviewer_author && String(profile.output.reviewer_author).trim()) || 'Legal Overflow';
  let annotated, unanchored;
  if (format === 'docx') {
    const r = await applyDocxMarkup(contractBuffer, finalFindings, { author: reviewerName });
    annotated = r.buffer;
    unanchored = r.unanchored;
  } else if (format === 'pdf') {
    const r = await applyPdfMarkup(contractBuffer, finalFindings, { author: reviewerName });
    annotated = r.buffer;
    unanchored = r.unanchored;
  } else {
    annotated = contractBuffer;
    unanchored = finalFindings;
  }

  // 11. Build internal summary
  const severityCounts = tallySeverities(finalFindings);
  const summaryBuffer = await buildReviewSummaryDocx({
    filename: review.filename,
    contractType: review.contract_type,
    pipelineMode: mode,
    findings: finalFindings,
    priorityThree: priorityFindings,
    coveragePassAggregate,
    rejectedFindings,
    specialistFailures,
    expectedSpecialists: specialists,
    unanchored,
    severityCounts,
    reviewedAt: new Date(),
  });

  // 12. Upload outputs
  const ext = review.filename.split('.').pop();
  const baseName = review.filename.replace(/\.[^.]+$/, '');
  const annotatedKey = `${userId}/${reviewId}/${baseName}_Annotated.${ext}`;
  const summaryKey   = `${userId}/${reviewId}/${baseName}_Review_Summary.docx`;
  const findingsKey  = `${userId}/${reviewId}/findings.json`;

  const findingsPayload = {
    schema_version: 2,
    findings: finalFindings,
    priority_three: priorityFindings.map(f => f.id),
    coverage_pass_aggregate: coveragePassAggregate,
    rejected_findings: rejectedFindings,
    specialist_failures: specialistFailures,
    expected_specialists: specialists,
    metrics: {
      ...compilerMetrics,
      ...postureMetrics,
      coherence_findings: coherenceFindings.length,
      restored_findings: restoredFindings.length,
      specialist_failures_count: specialistFailures.length,
    },
  };

  await Promise.all([
    supabase.storage.from('reviews-output').upload(annotatedKey, annotated, {
      contentType: format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      upsert: true,
    }),
    supabase.storage.from('reviews-output').upload(summaryKey, summaryBuffer, {
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      upsert: true,
    }),
    supabase.storage.from('reviews-output').upload(findingsKey, Buffer.from(JSON.stringify(findingsPayload, null, 2)), {
      contentType: 'application/json',
      upsert: true,
    }),
  ]);

  // 13. Finalize
  await supabase.from('reviews').update({
    status: 'complete',
    progress_message: `Review complete. ${finalFindings.length} finding(s) identified.`,
    severity_counts: severityCounts,
    annotated_url: annotatedKey,
    summary_url: summaryKey,
    findings_json_url: findingsKey,
    total_tokens: tokensUsed,
    cost_usd: estimateCostUsd({ inputTokens: tokensUsed, outputTokens: 0 }).toFixed(4),
    completed_at: new Date().toISOString(),
  }).eq('id', reviewId);
}

// ========== helpers ==========

async function updateProgress(supabase, reviewId, status, message) {
  await supabase.from('reviews').update({ status, progress_message: message }).eq('id', reviewId);
}

function tallySeverities(findings) {
  const t = { blocker: 0, major: 0, moderate: 0, minor: 0 };
  for (const f of findings) {
    const sev = (f.severity || '').toLowerCase();
    if (t[sev] != null) t[sev]++;
  }
  return t;
}

function humanizeAgent(name) {
  return String(name).replace(/-/g, ' ').replace(/\banalyst\b/, '').trim() || name;
}

/**
 * Resolve the full specialist set for an analyze stage. Combines:
 *   (a) the stage's explicit `agents` array from agent_registry.json
 *   (b) if the stage has `plus_enabled_industry_modules: true`:
 *       - every industry module explicitly enabled in profile.enabled_modules
 *       - technology_saas is auto-enabled when profile.company.industry
 *         matches SaaS / software-as-a-service / cloud patterns, so users
 *         with a SaaS industry string get the SaaS specialist without
 *         having to manually toggle enabled_modules
 *
 * Prior to this fix, `plus_enabled_industry_modules` was declared in the
 * registry but never read — industry-saas-analyst therefore NEVER ran in
 * production, leaving SaaS-specific clauses unreviewed.
 */
function resolveSpecialists(analyzeStage, registry, profile) {
  const specialists = [...(analyzeStage?.agents || [])];
  if (!analyzeStage?.plus_enabled_industry_modules) return specialists;

  const industryModules = registry?.industry_modules || {};
  const enabledFromProfile = (profile?.enabled_modules && typeof profile.enabled_modules === 'object')
    ? profile.enabled_modules : {};

  // (a) explicitly enabled modules from profile
  for (const [moduleKey, moduleDef] of Object.entries(industryModules)) {
    if (enabledFromProfile[moduleKey] === true && moduleDef?.agent && !specialists.includes(moduleDef.agent)) {
      specialists.push(moduleDef.agent);
    }
  }

  // (b) auto-enable technology_saas when industry string indicates SaaS
  const industryText = String(profile?.company?.industry || '').toLowerCase();
  const looksLikeSaas = /\b(saas|software[\s-]?as[\s-]?a[\s-]?service|cloud|b2b software|enterprise software|subscription software|hosted (service|software))\b/.test(industryText);
  if (looksLikeSaas) {
    const saasAgent = industryModules.technology_saas?.agent;
    if (saasAgent && !specialists.includes(saasAgent)) {
      specialists.push(saasAgent);
      console.log(`[fanout-background] auto-enabled technology_saas module (industry "${profile?.company?.industry}")`);
    }
  }

  return specialists;
}

/**
 * Normalize specialist output to { findings, coverage }. Handles legacy
 * array shape and the new { coverage_pass, findings } object shape.
 * Tags each entry with the specialist agentName when not already set.
 */
function normalizeSpecialistOutput(parsed, agentName) {
  let findings = [];
  let coverage = [];
  if (Array.isArray(parsed)) {
    findings = parsed;
  } else if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.findings)) findings = parsed.findings;
    if (Array.isArray(parsed.coverage_pass)) coverage = parsed.coverage_pass;
  }
  // Tag specialist where missing
  findings.forEach(f => { if (!f.specialist) f.specialist = agentName; });
  coverage.forEach(c => { if (!c.specialist) c.specialist = agentName; });
  // Alias proposed_text → suggested_text for Wave 3 specialist compatibility.
  // Wave 3 template uses `proposed_text`; markup libraries read `suggested_text`.
  findings.forEach(aliasProposedText);
  return { findings, coverage };
}

/**
 * Wave 3 specialists emit `proposed_text`; markup-docx.js and markup-pdf.js
 * both read `suggested_text` (Wave 1/2 field name). This alias keeps both
 * field names working without changing markup code or renaming the new
 * field in specialist templates.
 */
function aliasProposedText(f) {
  if (!f || typeof f !== 'object') return;
  if (f.proposed_text && !f.suggested_text) {
    f.suggested_text = f.proposed_text;
  }
}

/**
 * Validate a finding against the new Wave-3 schema. Returns true if the
 * finding is structurally complete; false if it's missing required fields.
 * Logs rejections for observability.
 */
function validateFindingSchema(f) {
  if (!f || typeof f !== 'object') return false;
  // Belt-and-suspenders: alias proposed_text → suggested_text here in case
  // the compiler or a downstream stage reshaped the finding without carrying
  // the alias through.
  aliasProposedText(f);
  if (!f.materiality_rationale || typeof f.materiality_rationale !== 'string' || f.materiality_rationale.trim().length < 10) {
    console.log('[schema-reject] missing materiality_rationale:', f.id || f.category);
    return false;
  }
  if (!f.position || typeof f.position !== 'string' || f.position.trim().length < 3) {
    console.log('[schema-reject] missing position:', f.id || f.category);
    return false;
  }
  if (typeof f.existential !== 'boolean') {
    // Coerce missing existential to false rather than rejecting — legacy shape tolerance
    f.existential = false;
  }
  // Conditional fallback requirement
  const sev = (f.severity || '').toLowerCase();
  if ((sev === 'blocker' || sev === 'major' || f.existential) && (!f.fallback || typeof f.fallback !== 'string')) {
    console.log('[schema-reject] missing required fallback:', f.id || f.category);
    return false;
  }
  // Conditional walkaway requirement
  if (f.existential && (!f.walkaway || typeof f.walkaway !== 'string')) {
    console.log('[schema-reject] missing required walkaway for existential:', f.id || f.category);
    return false;
  }
  // When tier 1 (profile_refs non-empty), playbook_fit must be a valid value
  if (Array.isArray(f.profile_refs) && f.profile_refs.length > 0) {
    const fit = f.playbook_fit;
    if (fit !== 'applies' && fit !== 'applies_with_modification') {
      console.log('[schema-reject] invalid/missing playbook_fit on tier-1:', f.id || f.category);
      return false;
    }
  }
  if (!f.jurisdiction_assumed || typeof f.jurisdiction_assumed !== 'string') {
    // Coerce missing jurisdiction_assumed to a placeholder rather than rejecting
    f.jurisdiction_assumed = 'not stated by specialist';
  }
  return true;
}

// ========== task envelopes (system prompts live in .md; these are short) ==========

function buildContextBlock({ clientRole, clientDefinedTerm, clientName, dealPosture, contractType, governingAgreementContext, jurisdiction }) {
  const gacText = governingAgreementContext
    ? (governingAgreementContext.mode === 'summary' && governingAgreementContext.text
        ? `GOVERNING_AGREEMENT_CONTEXT (user-provided summary of governing MSA):\n${governingAgreementContext.text}`
        : `GOVERNING_AGREEMENT_CONTEXT: user uploaded governing MSA; assume standard-market upstream provisions unless the document expressly overrides.`)
    : `GOVERNING_AGREEMENT_CONTEXT: null (no governing MSA declared for this review)`;
  // CLIENT_DEFINED_TERM is the contract's own Defined Term for the user's
  // party (e.g. "Supplier", "Provider", "Customer"). When present, this is
  // the AUTHORITATIVE label specialists use when drafting proposed_text and
  // external_comment. CLIENT_ROLE is the legacy free-text role from the
  // user's profile and is kept as a fallback for reviews that ran before
  // party detection landed.
  const clientLine = clientDefinedTerm
    ? `CLIENT_DEFINED_TERM: ${clientDefinedTerm}${clientName ? ` (legal entity: ${clientName})` : ''}\n` +
      `CLIENT_ROLE: ${clientRole} (legacy fallback — prefer CLIENT_DEFINED_TERM when drafting)\n`
    : `CLIENT_ROLE: ${clientRole}\n`;
  return (
    clientLine +
    `DEAL_POSTURE: ${dealPosture || 'unspecified'}\n` +
    `CONTRACT_TYPE: ${contractType}\n` +
    `JURISDICTION: ${jurisdiction}\n` +
    `${gacText}\n`
  );
}

function buildSpecialistEnvelope(ctx) {
  return (
    `${buildContextBlock(ctx)}\n` +
    `Per your system prompt, perform the Coverage Pass and produce Findings for this contract. ` +
    `Return ONE JSON object with the exact shape { "coverage_pass": [...], "findings": [...] }. ` +
    `No markdown fences, no prose outside the JSON.`
  );
}

function buildAuditorEnvelope({ specialistFindings, coveragePass, ...ctx }) {
  return (
    `${buildContextBlock(ctx)}\n` +
    `SPECIALIST FINDINGS (from all specialists that ran):\n${JSON.stringify(specialistFindings)}\n\n` +
    `SPECIALIST COVERAGE_PASS ENTRIES:\n${JSON.stringify(coveragePass)}\n\n` +
    `Per your system prompt, run the material-omission + cross-section-hazard + existential-escalation sweep. ` +
    `Return ONE JSON object { "coverage_pass": [], "findings": [...] }. Silence is acceptable.`
  );
}

function buildCompilerEnvelope({ allFindings, allCoverage, ...ctx }) {
  return (
    `${buildContextBlock(ctx)}\n` +
    `ALL FINDINGS (specialists + auditor):\n${JSON.stringify(allFindings)}\n\n` +
    `ALL COVERAGE_PASS ENTRIES (grouped-by-specialist in output, please):\n${JSON.stringify(allCoverage)}\n\n` +
    `Per your system prompt, validate schema, dedupe, run the proportionality prune, order, select priority_three, and polish voice. ` +
    `NOTE: the deterministic posture-integrity pass runs AFTER you; do not reject findings solely for role-inversion — the deterministic layer handles that.\n\n` +
    `Return ONE JSON object with the envelope shape from your system prompt { "priority_three", "accepted_findings", "rejected_findings", "coverage_pass_aggregate", "metrics" }.`
  );
}

function buildCoherenceEnvelope({ acceptedFindings, rejectedFindings, coveragePassAggregate, ...ctx }) {
  return (
    `${buildContextBlock(ctx)}\n` +
    `ACCEPTED_FINDINGS (post compiler + posture-integrity):\n${JSON.stringify(acceptedFindings)}\n\n` +
    `REJECTED_FINDINGS (with rejection_reason; may include posture-integrity rejections — DO NOT restore those):\n${JSON.stringify(rejectedFindings)}\n\n` +
    `COVERAGE_PASS_AGGREGATE:\n${JSON.stringify(coveragePassAggregate)}\n\n` +
    `Per your system prompt, run the coherence sweep and review rejected findings for restoration. ` +
    `Return ONE JSON object { "coverage_pass": [], "findings": [...with coherence_with], "restored_findings": [...] }. Silence is acceptable.`
  );
}
