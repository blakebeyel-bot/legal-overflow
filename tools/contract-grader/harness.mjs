// Round 1 harness — runs the full contract-review pipeline locally,
// bypassing Supabase. Mirrors fanout-background.js's processReview
// flow but takes inputs as args and writes findings JSON to disk.
//
// Usage:
//   node tools/contract-grader/harness.mjs <run-label> <contract-path> <profile-path-or-"empty"> <deal-posture>
//
// Example:
//   node tools/contract-grader/harness.mjs run-02 tools/contract-grader/test_contracts/msa_reasoning_test.docx \
//        tools/contract-grader/test_profiles/profile_buyer_positions.json their_paper_high_leverage
//
// Output: tools/contract-grader/runs/<run-label>.json

import fs from 'node:fs';
import path from 'node:path';

// Load API key from .env
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
// Stub Supabase URL so the import doesn't blow up
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'stub';

// Force IPv4 DNS for Windows Node 24 compatibility
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { getAgent, loadConfig } from '../../netlify/lib/agents.js';
import { callSpecialist, callModel, extractJson } from '../../netlify/lib/anthropic.js';
import { extractDocumentText } from '../../netlify/lib/extract.js';
import { runPostureIntegrity } from '../../netlify/lib/posture-integrity.js';

// ===========================================================================
// Inlined helpers — copied verbatim from fanout-background.js (these are
// module-private there). Keeping them in lockstep with production logic is
// the harness contract.
// ===========================================================================

function aliasProposedText(f) {
  if (!f || typeof f !== 'object') return;
  if (f.proposed_text && !f.suggested_text) f.suggested_text = f.proposed_text;
}

function validateFindingSchema(f) {
  if (!f || typeof f !== 'object') return false;
  aliasProposedText(f);
  if (!f.materiality_rationale || typeof f.materiality_rationale !== 'string' || f.materiality_rationale.trim().length < 10) return false;
  if (!f.position || typeof f.position !== 'string' || f.position.trim().length < 3) return false;
  if (typeof f.existential !== 'boolean') f.existential = false;
  const sev = (f.severity || '').toLowerCase();
  if ((sev === 'blocker' || sev === 'major' || f.existential) && (!f.fallback || typeof f.fallback !== 'string')) return false;
  if (f.existential && (!f.walkaway || typeof f.walkaway !== 'string')) return false;
  if (Array.isArray(f.profile_refs) && f.profile_refs.length > 0) {
    const fit = f.playbook_fit;
    if (fit !== 'applies' && fit !== 'applies_with_modification') return false;
  }
  if (!f.jurisdiction_assumed || typeof f.jurisdiction_assumed !== 'string') f.jurisdiction_assumed = 'not stated by specialist';
  return true;
}

function normalizeSpecialistOutput(parsed, agentName) {
  let findings = [];
  let coverage = [];
  if (Array.isArray(parsed)) findings = parsed;
  else if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.findings)) findings = parsed.findings;
    if (Array.isArray(parsed.coverage_pass)) coverage = parsed.coverage_pass;
  }
  findings.forEach((f) => { if (!f.specialist) f.specialist = agentName; });
  coverage.forEach((c) => { if (!c.specialist) c.specialist = agentName; });
  findings.forEach(aliasProposedText);
  return { findings, coverage };
}

function resolveSpecialists(analyzeStage, registry, profile) {
  const specialists = [...(analyzeStage?.agents || [])];
  if (!analyzeStage?.plus_enabled_industry_modules) return specialists;
  const industryModules = registry?.industry_modules || {};
  const enabledFromProfile = (profile?.enabled_modules && typeof profile.enabled_modules === 'object') ? profile.enabled_modules : {};
  for (const [moduleKey, moduleDef] of Object.entries(industryModules)) {
    if (enabledFromProfile[moduleKey] === true && moduleDef?.agent && !specialists.includes(moduleDef.agent)) {
      specialists.push(moduleDef.agent);
    }
  }
  const industryText = String(profile?.company?.industry || '').toLowerCase();
  const looksLikeSaas = /\b(saas|software[\s-]?as[\s-]?a[\s-]?service|cloud|b2b software|enterprise software|subscription software|hosted (service|software))\b/.test(industryText);
  if (looksLikeSaas) {
    const saasAgent = industryModules.technology_saas?.agent;
    if (saasAgent && !specialists.includes(saasAgent)) specialists.push(saasAgent);
  }
  return specialists;
}

function buildContextBlock({ clientRole, clientDefinedTerm, clientName, dealPosture, contractType, governingAgreementContext, jurisdiction }) {
  const gacText = governingAgreementContext
    ? (governingAgreementContext.mode === 'summary' && governingAgreementContext.text
        ? `GOVERNING_AGREEMENT_CONTEXT (user-provided summary of governing MSA):\n${governingAgreementContext.text}`
        : `GOVERNING_AGREEMENT_CONTEXT: user uploaded governing MSA; assume standard-market upstream provisions unless the document expressly overrides.`)
    : `GOVERNING_AGREEMENT_CONTEXT: null (no governing MSA declared for this review)`;
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

// ===========================================================================
// Playbook → profile conversion (mirrors upload-playbook.js)
// ===========================================================================
async function convertPlaybookToProfile(playbookPath, userId = 'harness-user') {
  const buf = fs.readFileSync(playbookPath);
  const filename = path.basename(playbookPath);
  const extracted = await extractDocumentText(buf, filename);
  const schema = loadConfig('company_profile.schema');
  const systemPrompt =
    `You are a contract-review playbook ingestor. You receive a text playbook ` +
    `and emit a company_profile.json object that conforms to the provided schema.\n\n` +
    `Rules:\n` +
    `1. Output ONLY a JSON object — no prose, no markdown fences, no commentary.\n` +
    `2. Do not invent positions the user didn't state. For unspecified sections, use an empty object/array or null, and set a top-level "needs_review": true marker.\n` +
    `3. Be faithful to the user's words. Use their phrasings for red flags and positions.\n` +
    `4. KEEP IT TIGHT — aim for under 1.5KB of JSON. Summarize rather than restate. Pick the 10–15 most important red flags/positions, not everything.\n` +
    `5. Emit the JSON immediately — no reasoning preamble.\n` +
    `6. Field values should be short strings (~100 chars) not long paragraphs. The full playbook lives in storage — this profile is a structured summary.\n\n` +
    `SCHEMA:\n${JSON.stringify(schema, null, 2)}`;
  const MAX = 25_000;
  const truncated = extracted.text.length > MAX;
  const playbookSnippet = extracted.text.slice(0, MAX);
  const userMessage =
    `PLAYBOOK TEXT${truncated ? ` (first ${MAX} of ${extracted.text.length} chars)` : ''}:\n${playbookSnippet}\n\n` +
    `Emit the JSON profile now.`;
  const resp = await callModel({
    agentName: 'workflow-configurator',
    systemPrompt, userMessage, userId, maxTokens: 1500,
  });
  return extractJson(resp.text);
}

// ===========================================================================
// Main scenario runner
// ===========================================================================
async function runScenario({ runLabel, contractPath, profile, dealPosture, contractType = 'master_services_agreement' }) {
  const filename = path.basename(contractPath);
  const contractBuf = fs.readFileSync(contractPath);
  const { text: contractText, format } = await extractDocumentText(contractBuf, filename);

  const clientRole = profile?.company?.role_in_contracts || 'unknown';
  const jurisdiction = profile?.jurisdiction?.primary || 'not determinable from four corners';
  const governingAgreementContext = null;

  const registry = loadConfig('agent_registry');
  const mode = 'standard';
  const pipeline = registry.pipeline_modes[mode];
  const analyzeStage = pipeline.stages.find((s) => s.stage === 'analyze');
  const specialists = resolveSpecialists(analyzeStage, registry, profile);

  // Harness doesn't run the party-detection pre-pass — local fixtures are
  // graded with the legacy CLIENT_ROLE path. Setting clientDefinedTerm =
  // null exercises the legacy fallback in the prompts so harness results
  // are comparable across rounds. To exercise the new path, pass a
  // CLIENT_DEFINED_TERM env override.
  const clientDefinedTerm = process.env.CLIENT_DEFINED_TERM || null;
  const clientName = process.env.CLIENT_NAME || null;
  const ctx = { clientRole, clientDefinedTerm, clientName, dealPosture, contractType, governingAgreementContext, jurisdiction };

  console.log(`\n[${runLabel}] specialists (${specialists.length}): ${specialists.join(', ')}`);
  console.log(`[${runLabel}] role=${clientRole}, posture=${dealPosture}, format=${format}, words=${contractText.split(/\s+/).length}`);

  const userId = `harness-${runLabel}`;
  const reviewId = `harness-${runLabel}`;
  let tokensUsed = 0;
  const allFindings = [];
  const allCoverage = [];
  const specialistFailures = [];

  // STAGE 1 — specialists in parallel
  const taskEnvelope = buildSpecialistEnvelope(ctx);
  const t0 = Date.now();
  const specialistResults = await Promise.allSettled(
    specialists.map(async (agentName) => {
      const outcome = { agentName, findings: [], coverage: [], error: null };
      try {
        const agent = getAgent(agentName);
        const resp = await callSpecialist({
          agentName,
          systemPrompt: agent.systemPrompt,
          profileJson: profile,
          contractText,
          taskPrompt: taskEnvelope,
          userId, reviewId,
          maxTokens: 8192,
          tokensUsedSoFar: tokensUsed,
        });
        tokensUsed += (resp.usage.input_tokens || 0) + (resp.usage.output_tokens || 0);
        let parsed;
        try { parsed = extractJson(resp.text); } catch (e) {
          outcome.error = `non-JSON: ${e.message}`;
          parsed = { coverage_pass: [], findings: [] };
        }
        const { findings, coverage } = normalizeSpecialistOutput(parsed, agentName);
        outcome.findings = findings;
        outcome.coverage = coverage;
        if (coverage.length === 0 && !outcome.error) outcome.error = 'empty coverage_pass';
        console.log(`  [${runLabel}] ${agentName}: ${findings.length} findings, ${coverage.length} coverage`);
      } catch (e) {
        outcome.error = `invocation failed: ${e.message}`;
        console.error(`  [${runLabel}] ${agentName} FAILED:`, e.message);
      }
      return outcome;
    })
  );
  for (const r of specialistResults) {
    if (r.status === 'fulfilled') {
      allFindings.push(...r.value.findings);
      allCoverage.push(...r.value.coverage);
      if (r.value.error) specialistFailures.push({ specialist: r.value.agentName, reason: r.value.error });
    }
  }

  // STAGE 2 — auditor
  let auditorFindings = [];
  try {
    const auditor = getAgent('critical-issues-auditor');
    const resp = await callSpecialist({
      agentName: 'critical-issues-auditor',
      systemPrompt: auditor.systemPrompt,
      profileJson: profile,
      contractText,
      taskPrompt: buildAuditorEnvelope({ ...ctx, specialistFindings: allFindings, coveragePass: allCoverage }),
      userId, reviewId,
      maxTokens: 4096,
      tokensUsedSoFar: tokensUsed,
    });
    tokensUsed += (resp.usage.input_tokens || 0) + (resp.usage.output_tokens || 0);
    let parsed;
    try { parsed = extractJson(resp.text); } catch { parsed = null; }
    const { findings } = normalizeSpecialistOutput(parsed || {}, 'critical-issues-auditor');
    auditorFindings = findings;
    allFindings.push(...findings);
    console.log(`  [${runLabel}] auditor: ${findings.length} findings`);
  } catch (e) {
    console.error(`  [${runLabel}] auditor FAILED:`, e.message);
  }

  // STAGE 3 — compiler
  let acceptedFindings = allFindings;
  let rejectedFindings = [];
  let coveragePassAggregate = allCoverage;
  let priorityIds = [];
  let compilerMetrics = {};
  try {
    const compiler = getAgent('review-compiler');
    const resp = await callSpecialist({
      agentName: 'review-compiler',
      systemPrompt: compiler.systemPrompt,
      profileJson: profile,
      contractText,
      taskPrompt: buildCompilerEnvelope({ ...ctx, allFindings, allCoverage }),
      userId, reviewId,
      maxTokens: 12_000,
      tokensUsedSoFar: tokensUsed,
    });
    tokensUsed += (resp.usage.input_tokens || 0) + (resp.usage.output_tokens || 0);
    const compiled = extractJson(resp.text);
    if (compiled && typeof compiled === 'object' && !Array.isArray(compiled)) {
      acceptedFindings = Array.isArray(compiled.accepted_findings) ? compiled.accepted_findings : allFindings;
      rejectedFindings = Array.isArray(compiled.rejected_findings) ? compiled.rejected_findings : [];
      coveragePassAggregate = Array.isArray(compiled.coverage_pass_aggregate) ? compiled.coverage_pass_aggregate : allCoverage;
      priorityIds = Array.isArray(compiled.priority_three) ? compiled.priority_three : [];
      compilerMetrics = compiled.metrics || {};
    } else if (Array.isArray(compiled)) acceptedFindings = compiled;
    console.log(`  [${runLabel}] compiler: ${acceptedFindings.length} accepted, ${rejectedFindings.length} rejected`);
  } catch (e) {
    console.error(`  [${runLabel}] compiler FAILED:`, e.message);
  }
  acceptedFindings = acceptedFindings.filter(validateFindingSchema);
  acceptedFindings.forEach((f, i) => { if (!f.id) f.id = `f${i + 1}`; });

  // STAGE 4 — posture-integrity
  let postureMetrics = {};
  try {
    const postureResult = await runPostureIntegrity({
      findings: acceptedFindings, clientRole, callModel, userId, reviewId,
    });
    postureMetrics = postureResult.metrics;
    for (const r of postureResult.rejected) {
      rejectedFindings.push({ ...r.finding, rejection_reason: r.reason, rejection_rule: r.rule, rejection_source: r.source });
    }
    acceptedFindings = postureResult.accepted;
    console.log(`  [${runLabel}] posture: ${postureMetrics.deterministic_pass} pass, ${postureMetrics.deterministic_fail} fail, ${postureMetrics.escalated} escalated`);
  } catch (e) {
    console.error(`  [${runLabel}] posture-integrity FAILED:`, e.message);
  }

  // STAGE 5 — coherence
  let coherenceFindings = [];
  let restoredFindings = [];
  try {
    const ca = getAgent('coherence-checker');
    const resp = await callSpecialist({
      agentName: 'coherence-checker',
      systemPrompt: ca.systemPrompt,
      profileJson: profile,
      contractText,
      taskPrompt: buildCoherenceEnvelope({ ...ctx, acceptedFindings, rejectedFindings, coveragePassAggregate }),
      userId, reviewId,
      maxTokens: 4096,
      tokensUsedSoFar: tokensUsed,
    });
    tokensUsed += (resp.usage.input_tokens || 0) + (resp.usage.output_tokens || 0);
    let parsed;
    try { parsed = extractJson(resp.text); } catch { parsed = null; }
    if (parsed && typeof parsed === 'object') {
      const { findings } = normalizeSpecialistOutput(parsed, 'coherence-checker');
      coherenceFindings = findings;
      if (Array.isArray(parsed.restored_findings)) restoredFindings = parsed.restored_findings;
    }
    acceptedFindings.push(...coherenceFindings.filter(validateFindingSchema));
    acceptedFindings.push(...restoredFindings.filter(validateFindingSchema));
    console.log(`  [${runLabel}] coherence: +${coherenceFindings.length} new, +${restoredFindings.length} restored`);
  } catch (e) {
    console.error(`  [${runLabel}] coherence FAILED:`, e.message);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[${runLabel}] DONE: ${acceptedFindings.length} accepted findings · ${tokensUsed} tokens · ${elapsed}s`);

  return {
    run_label: runLabel,
    contract_path: contractPath,
    contract_format: format,
    contract_word_count: contractText.split(/\s+/).filter(Boolean).length,
    profile_used: profile?.company?.name || 'unknown',
    deal_posture: dealPosture,
    client_role: clientRole,
    specialists,
    specialist_failures: specialistFailures,
    accepted_findings: acceptedFindings,
    rejected_findings: rejectedFindings,
    auditor_findings: auditorFindings,
    coherence_findings: coherenceFindings,
    restored_findings: restoredFindings,
    coverage_pass_aggregate: coveragePassAggregate,
    priority_three: priorityIds,
    compiler_metrics: compilerMetrics,
    posture_metrics: postureMetrics,
    tokens_used: tokensUsed,
    elapsed_seconds: parseFloat(elapsed),
    timestamp: new Date().toISOString(),
  };
}

// ===========================================================================
// Entry — run a single scenario from CLI args
// ===========================================================================
const [, , runLabel, contractPath, profileSpec, dealPosture] = process.argv;
if (!runLabel || !contractPath || !profileSpec || !dealPosture) {
  console.error('Usage: node harness.mjs <run-label> <contract-path> <profile-path-or-"playbook:path"> <deal-posture>');
  process.exit(1);
}

let profile;
if (profileSpec.startsWith('playbook:')) {
  const playbookPath = profileSpec.slice('playbook:'.length);
  console.log(`[${runLabel}] converting playbook: ${playbookPath}`);
  profile = await convertPlaybookToProfile(playbookPath);
  console.log(`[${runLabel}] derived profile keys: ${Object.keys(profile || {}).join(', ')}`);
} else {
  profile = JSON.parse(fs.readFileSync(profileSpec, 'utf8'));
}

const result = await runScenario({ runLabel, contractPath, profile, dealPosture });
const outPath = path.resolve(`tools/contract-grader/runs/${runLabel}.json`);
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(`Wrote ${outPath}`);
