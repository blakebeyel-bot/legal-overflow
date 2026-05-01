/**
 * POST /api/verify-citations-pipeline-background
 *
 * Background function — up to 15 min runtime (filename suffix
 * "-background" is what Netlify reads to enable that mode). Runs the
 * full Citation Verifier pipeline:
 *
 *   1. Pass 1   — extract candidates from .docx/.pdf
 *   2. Pass 2   — Sonnet classifier (batched, prompt-cached SKILL)
 *   3. Pass 3   — Bluebook table validators (pure code)
 *   4. Pass 2.5 — CourtListener existence check
 *   5. Pass 4   — Sonnet judgment for cross-citation issues
 *   6. Pass 5a  — build the form-check report (.docx)
 *   7. Pass 5b/c — build the marked-up source (.docx or .pdf)
 *   8. Persist citations + flags to DB
 *   9. Upload outputs to storage; delete uploaded source (privilege default)
 *  10. Mark verification_runs row complete
 *
 * Privilege defaults (BUILD_SPEC §16):
 *   - candidate_text persisted ONLY when run.retain_text = true
 *   - candidate_text_hash always persisted
 *   - uploaded source DELETED from storage at the end
 *
 * Banned-phrase rule: every flag.message + suggested_fix is sanitized
 * before persistence; the per-stage modules are responsible for their
 * own outputs but we do a final pass here as a safety net.
 *
 * Input body (JSON):
 *   { run_id: string }
 *
 * Triggered by: verify-citations-start.js after the row + upload land.
 */

import { requireUser, getSupabaseAdmin } from '../lib/supabase-admin.js';
import { extractForCitations } from '../lib/citation-verifier/extract.js';
import { classifyCitationBatch, BATCH_SIZE } from '../lib/citation-verifier/classify-citation.js';
import { runAllValidators } from '../lib/citation-verifier/validators.js';
import { CourtListenerClient, existenceResultToFlag } from '../lib/citation-verifier/court-listener.js';
import { judgeEdgeCases, filterPass4Territory } from '../lib/citation-verifier/judge-edge-cases.js';
import { buildFormReport } from '../lib/citation-verifier/form-report.js';
import { applyCitationMarkupDocx } from '../lib/citation-verifier/markup-docx-citations.js';
import { applyCitationMarkupPdf } from '../lib/citation-verifier/markup-pdf-citations.js';
import { sanitizeOutput } from '../lib/citation-verifier/skill-prompt.js';
import { applyStaticFixes } from '../lib/citation-verifier/compose-fixes.js';
import { validateSuggestedFix } from '../lib/citation-verifier/fix-self-check.js';
import { scanDocumentIssues } from '../lib/citation-verifier/scan-document-issues.js';
import { findSecondarySourceCandidates } from '../lib/citation-verifier/secondary-source-patterns.js';
import { findOfficialSourceCandidates } from '../lib/citation-verifier/official-source-patterns.js';
import { findForeignSourceCandidates } from '../lib/citation-verifier/foreign-source-patterns.js';
import { filterCrossExtractorOverlap } from '../lib/citation-verifier/cross-extractor-dedup.js';
import { attachCitationState } from '../lib/citation-verifier/citation-state-tracker.js';

const INCOMING_BUCKET = 'citation-verifier-incoming';
const OUTPUT_BUCKET = 'citation-verifier-output';

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  // Background functions still get the user's bearer token so we can
  // attribute usage events. Service role does the actual writes below.
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return new Response(auth.error, { status: auth.status });

  let body;
  try { body = await req.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
  const { run_id } = body;
  if (!run_id) return new Response('run_id required', { status: 400 });

  const supabase = getSupabaseAdmin();

  const { data: run } = await supabase
    .from('verification_runs')
    .select('*')
    .eq('id', run_id)
    .single();
  if (!run || run.user_id !== auth.user.id) {
    return new Response('Run not found', { status: 404 });
  }

  try {
    await runPipeline({ supabase, userId: auth.user.id, run });
    return new Response('ok', { status: 202 });
  } catch (err) {
    console.error('verify-citations-pipeline-background failed:', err);
    await supabase.from('verification_runs').update({
      status: 'failed',
      error_message: sanitizeOutput(err.message || String(err)),
      completed_at: new Date().toISOString(),
    }).eq('id', run_id);
    return new Response('Failed: ' + (err.message || ''), { status: 500 });
  }
};

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function runPipeline({ supabase, userId, run }) {
  const runId = run.id;

  // Helper for status updates
  const setStatus = async (status, progress) => {
    await supabase.from('verification_runs').update({
      status,
      status_progress: progress,
    }).eq('id', runId);
  };

  // ---- Pass 1: Extract ---------------------------------------------------
  await setStatus('extracting', 5);

  const incomingKey = `${userId}/${runId}/source.${run.file_format}`;
  const { data: dl, error: dlErr } = await supabase.storage
    .from(INCOMING_BUCKET)
    .download(incomingKey);
  if (dlErr || !dl) throw new Error(`Could not download uploaded file: ${dlErr?.message || 'unknown'}`);

  const fileBuffer = Buffer.from(await dl.arrayBuffer());
  const pass1 = await extractForCitations(fileBuffer, run.file_name);
  console.log(`[verify-citations] Pass 1: ${pass1.candidates.length} candidates extracted from ${run.file_format}`);

  // Round 15 — document-level issue scan (R. 5.1 block quotes, R. 5.3
  // ellipsis spacing, etc.). These produce synthetic citations with
  // pre-attached flags that flow through the same pipeline as real
  // citations (skipping Pass 2 classification + Pass 2.5 existence).
  const docIssueCandidates = scanDocumentIssues(pass1.text || '');
  if (docIssueCandidates.length > 0) {
    console.log(`[verify-citations] Doc-issue scanner: ${docIssueCandidates.length} synthetic candidates`);
    for (const ci of docIssueCandidates) {
      console.log(`[orchestrator/doc] ${ci.pattern_name}: "${(ci.candidate_text || '').slice(0, 80)}"`);
    }
  }

  // Round 16 — secondary-source extractor (books, articles, manuscripts,
  // forthcoming, internet, news_article). Adds candidates that case extractor
  // can't see (no " v. " marker). Pass 2 classification IS NOT applied to
  // these — their citation_type comes straight from provisional_type.
  let secondaryCandidates = findSecondarySourceCandidates(pass1.text || '').map((c) => ({
    ...c,
    citation_type: c.provisional_type,
    components: {},
    governing_rule: c.provisional_type === 'book' ? 'BB R. 15'
                   : c.provisional_type === 'article' ? 'BB R. 16'
                   : c.provisional_type === 'manuscript' ? 'BB R. 17.1'
                   : c.provisional_type === 'forthcoming' ? 'BB R. 17.2'
                   : c.provisional_type === 'news_article' ? 'BB R. 18.2'
                   : 'BB R. 18',
    governing_table: c.provisional_type === 'article' ? 'T13' : null,
  }));
  if (secondaryCandidates.length > 0) {
    console.log(`[verify-citations] Secondary-source: ${secondaryCandidates.length} candidates`);
    for (const sc of secondaryCandidates) {
      console.log(`[orchestrator/sec] ${sc.provisional_type}: "${(sc.candidate_text || '').slice(0, 100)}"`);
    }
  }

  // Round 17 — official sources (constitutional, legislative, administrative).
  let officialCandidates = findOfficialSourceCandidates(pass1.text || '').map((c) => ({
    ...c,
    citation_type: c.provisional_type,
    components: {},
    governing_rule: c.provisional_type === 'constitutional' ? 'BB R. 11'
                   : c.provisional_type === 'legislative_report' ? 'BB R. 13.4'
                   : c.provisional_type === 'legislative_hearing' ? 'BB R. 13.3'
                   : c.provisional_type === 'cong_rec' ? 'BB R. 13.5'
                   : c.provisional_type === 'bill' ? 'BB R. 13.2'
                   : c.provisional_type === 'fed_reg' ? 'BB R. 14.2'
                   : c.provisional_type === 'exec_order' ? 'BB R. 14.7'
                   : 'BB R. 11',
    governing_table: null,
  }));
  if (officialCandidates.length > 0) {
    console.log(`[verify-citations] Official-source: ${officialCandidates.length} candidates`);
    for (const oc of officialCandidates) {
      console.log(`[orchestrator/off] ${oc.provisional_type}: "${(oc.candidate_text || '').slice(0, 100)}"`);
    }
  }

  // Round 20 — foreign cases, treaties, international tribunals, specialty
  // federal courts (R. 20, R. 21, R. 21.4, R. 10/T1).
  let foreignCandidates = findForeignSourceCandidates(pass1.text || '').map((c) => ({
    ...c,
    citation_type: c.provisional_type,
    components: {},
    governing_rule: c.provisional_type === 'foreign_case' ? 'BB R. 20'
                   : c.provisional_type === 'multilateral_treaty' ? 'BB R. 21.4'
                   : c.provisional_type === 'bilateral_treaty' ? 'BB R. 21.4'
                   : c.provisional_type === 'icj_case' ? 'BB R. 21'
                   : c.provisional_type === 'echr_case' ? 'BB R. 21'
                   : c.provisional_type === 'tribunal_case' ? 'BB R. 21'
                   : c.provisional_type === 'tcm_case' ? 'BB R. 10'
                   : 'BB R. 20',
    governing_table: null,
  }));
  if (foreignCandidates.length > 0) {
    console.log(`[verify-citations] Foreign-source: ${foreignCandidates.length} candidates`);
    for (const fc of foreignCandidates) {
      console.log(`[orchestrator/foreign] ${fc.provisional_type}: "${(fc.candidate_text || '').slice(0, 100)}"`);
    }
  }

  // Round 26 — cross-extractor span dedup. Drops secondary/official/foreign
  // candidates whose span is fully contained within a higher-priority
  // extractor's candidate (priority: case > foreign > official > secondary).
  // Fixes the user-reported Chevron duplicate where the secondary "book"
  // extractor was producing a truncated "Council, Inc., 467 U.S. 837..."
  // candidate that overlapped with the case extractor's full Chevron span;
  // both flowed through Pass 3 and the validator emitted R. 3.2(a) twice
  // with different suggested fixes.
  const dedup = filterCrossExtractorOverlap({
    caseCands: pass1.candidates,
    foreignCands: foreignCandidates,
    officialCands: officialCandidates,
    secondaryCands: secondaryCandidates,
  });
  const beforeCounts = {
    foreign: foreignCandidates.length,
    official: officialCandidates.length,
    secondary: secondaryCandidates.length,
  };
  foreignCandidates  = dedup.foreignCands;
  officialCandidates = dedup.officialCands;
  secondaryCandidates = dedup.secondaryCands;
  const droppedCounts = {
    foreign: beforeCounts.foreign - foreignCandidates.length,
    official: beforeCounts.official - officialCandidates.length,
    secondary: beforeCounts.secondary - secondaryCandidates.length,
  };
  if (droppedCounts.foreign + droppedCounts.official + droppedCounts.secondary > 0) {
    console.log(
      `[orchestrator/cross-extractor-dedup] dropped ` +
      `foreign=${droppedCounts.foreign} ` +
      `official=${droppedCounts.official} ` +
      `secondary=${droppedCounts.secondary} ` +
      `(contained in higher-priority extractor span)`
    );
  }
  // Partial overlaps "shouldn't happen" — log them so we notice if a new
  // extractor gets boundary logic that disagrees with the case extractor.
  for (const po of dedup.partialOverlaps) {
    console.warn(
      `[orchestrator/cross-extractor-dedup] PARTIAL OVERLAP ` +
      `lower=${po.lower_extractor} (${po.lower.char_start}-${po.lower.char_end}) ` +
      `higher=${po.higher_extractor} (${po.higher.char_start}-${po.higher.char_end}) ` +
      `lower_text=${JSON.stringify(po.lower.candidate_text.slice(0, 100))}`
    );
  }

  // Round 9 — defensive instrumentation. Log every Pass 1 candidate
  // verbatim so we can diagnose the live pipeline without re-running
  // through a debugger. Also lets us pinpoint which citation lost which
  // catch when comparing across deploys.
  for (let i = 0; i < pass1.candidates.length; i++) {
    const c = pass1.candidates[i];
    const text = (c.candidate_text || '').replace(/\s+/g, ' ').slice(0, 140);
    console.log(`[orchestrator/p1 #${i}] ${c.provisional_type}: "${text}"`);
  }

  // ---- Pass 2: Classify in batches --------------------------------------
  await setStatus('classifying', 20);

  const allClassifications = [];
  for (let i = 0; i < pass1.candidates.length; i += BATCH_SIZE) {
    const batch = pass1.candidates.slice(i, i + BATCH_SIZE);
    const { classifications } = await classifyCitationBatch({
      candidates: batch,
      style: run.style,
      ruleset: run.ruleset,
      userId,
      runId,
    });
    allClassifications.push(...classifications);

    const pct = 20 + Math.round((i + batch.length) / pass1.candidates.length * 30);
    await setStatus('classifying', pct);
  }

  // ---- Pass 2.5: Existence check on case citations ----------------------
  await setStatus('checking_existence', 55);

  const courtListener = new CourtListenerClient();
  // Round 30 — exclude short-form case citations from CL verification.
  // The full citation earlier in the document is what verifies the
  // case; the short form is a back-reference. Pass 2's LLM occasionally
  // misclassifies short forms as 'case' — particularly when a leading
  // signal like "See" is present — so the filter checks pattern_name
  // (deterministic from Pass 1) and provisional_type as fallbacks.
  // checkExistence inside court-listener.js applies the same guard
  // (defense in depth).
  const caseCitations = allClassifications.filter((c) =>
    c.citation_type === 'case' &&
    c.provisional_type !== 'short_form_case' &&
    c.pattern_name !== 'short_case'
  );
  const existenceResults = await courtListener.checkAll(caseCitations);

  // Map existence results back onto every classification (case-typed
  // entries get their own result; others get not_applicable).
  // Also back-fill components.case_name from CourtListener when the
  // existence check verified the citation and Pass 2 left case_name
  // empty — the canonical name from CourtListener is the right source
  // of truth for the report display.
  const existenceByIndex = new Map();
  let caseCursor = 0;
  for (let i = 0; i < allClassifications.length; i++) {
    const cl = allClassifications[i];
    const isFullCase =
      cl.citation_type === 'case' &&
      cl.provisional_type !== 'short_form_case' &&
      cl.pattern_name !== 'short_case';
    if (isFullCase) {
      const result = existenceResults[caseCursor++];
      existenceByIndex.set(i, result);
      // Round 27 — log per-citation CL call count. Confirms parallel-
      // reporter citations (e.g. Plessy 163 U.S. 537, 16 S. Ct. 1138,
      // 41 L. Ed. 256) make a SINGLE API call (one classification ->
      // one Pass 2.5 lookup), not three.
      if (typeof result?._calls_for_citation === 'number') {
        const text = (cl.candidate_text || '').replace(/\s+/g, ' ').slice(0, 80);
        console.log(`[orchestrator/cl-calls #${i}] ${result._calls_for_citation} call(s) — "${text}"`);
      }
      if (
        result?.status === 'existence_verified' &&
        result.case_name &&
        (!cl.components?.case_name || String(cl.components.case_name).trim() === '')
      ) {
        cl.components = { ...(cl.components || {}), case_name: result.case_name };
      }
    } else {
      existenceByIndex.set(i, { status: 'not_applicable' });
    }
  }

  // ---- Pass 3: Table validators (per citation) --------------------------
  await setStatus('validating', 70);

  // Annotate each classification with its existence result + Pass 3 flags.
  // Each validator's suggested_fix gets run through applyStaticFixes so
  // its output composes with every other static substitution we know
  // about — fixes one error in the validator's specific category, but
  // also picks up any other static issues in the same span (e.g., the
  // vs.→v. fix also corrects Fl.→Fla. and adds a missing §).
  // Round 19 — attach citation state (previous_citation, is_string_cite,
  // case_state, hereinafter_registry) for state-aware validators.
  // Build the merged candidate stream first (real cases + secondary +
  // official) so the tracker sees the full document context.
  const allCitationsForState = [
    ...allClassifications,
    ...secondaryCandidates,
    ...officialCandidates,
    ...foreignCandidates,
  ];
  attachCitationState(allCitationsForState, pass1.text || '');

  const enriched = allClassifications.map((c, i) => {
    const existence = existenceByIndex.get(i);
    // Round 18 — pass document text for state-aware validators
    // (e.g., supra disambiguation, hereinafter tracking).
    c.document_text = pass1.text || '';
    const rawFlags = runAllValidators(c);
    // Round 9 — log every Pass 3 finding, before suggested_fix
    // composition. Lets us see which validator fired on which citation
    // in the live pipeline, so when a catch silently disappears we can
    // tell whether it failed at extraction, classification, or validation.
    if (rawFlags.length > 0) {
      const text = (c.candidate_text || '').replace(/\s+/g, ' ').slice(0, 140);
      console.log(`[orchestrator/p3 #${i}] "${text}" — ${rawFlags.length} flag(s)`);
      for (const f of rawFlags) {
        console.log(`  → ${f.severity} | ${f.rule_cite || '(no rule)'} | ${f.category || '(no cat)'} | ${(f.message || '').slice(0, 120)}`);
      }
    }
    const pass3Flags = rawFlags.map((f) => {
      // 1. Compose static fixes onto the validator's suggested_fix so
      //    the output applies every known correction (vs.→v., Fl.→Fla.,
      //    insert §, etc.) — not just the validator's own fix.
      const composed = f.suggested_fix
        ? applyStaticFixes(f.suggested_fix)
        : null;
      // 2. Self-check: validate the fix is complete and well-formed.
      //    Returns null if the fix is a fragment (dropped case name,
      //    missing required Restatement components, etc.) — in which
      //    case we omit the "Suggested fix:" line entirely. Better to
      //    surface the rule explanation alone than feed the attorney
      //    a malformed fragment that pretends to be authoritative.
      const cleaned = composed ? validateSuggestedFix(c, composed) : null;
      return {
        ...f,
        message: sanitizeOutput(f.message),
        suggested_fix: cleaned ? sanitizeOutput(cleaned) : null,
      };
    });
    return {
      ...c,
      existence,
      flags: [...pass3Flags],
      _index: i,
    };
  });

  // Round 15 — append synthetic document-issue candidates AFTER Pass 3.
  // They already carry their pre-attached flags (e.g., R. 5.3 ellipsis,
  // R. 5.1 block-quote violations) and don't need Pass 2/2.5/3 because
  // they aren't real citations. Pass 5 markup picks them up like normal.
  for (const ci of docIssueCandidates) {
    enriched.push({
      ...ci,
      existence: { status: 'not_applicable' },
      flags: (ci.flags || []).map((f) => ({
        ...f,
        message: sanitizeOutput(f.message),
        suggested_fix: f.suggested_fix ? sanitizeOutput(f.suggested_fix) : null,
      })),
      _index: enriched.length,
    });
  }

  // Round 16 — secondary-source candidates run through Pass 3 validators
  // (R. 15 / R. 16 / R. 17 / R. 18). They skip Pass 2.5 (CourtListener),
  // which is case-only.
  // Round 17 — same treatment for official-source candidates (R. 11 / R. 13 /
  // R. 14): no Pass 2 classification, no existence check, just Pass 3.
  for (const sc of [...secondaryCandidates, ...officialCandidates, ...foreignCandidates]) {
    // Round 18 — also pass document text to secondary/official validators.
    sc.document_text = pass1.text || '';
    const rawFlags = runAllValidators(sc);
    if (rawFlags.length > 0) {
      console.log(`[orchestrator/p3-sec] "${(sc.candidate_text || '').slice(0, 100)}" — ${rawFlags.length} flag(s)`);
      for (const f of rawFlags) {
        console.log(`  → ${f.severity} | ${f.rule_cite} | ${(f.message || '').slice(0, 100)}`);
      }
    }
    const pass3Flags = rawFlags.map((f) => {
      const composed = f.suggested_fix ? applyStaticFixes(f.suggested_fix) : null;
      const cleaned = composed ? validateSuggestedFix(sc, composed) : null;
      return {
        ...f,
        message: sanitizeOutput(f.message),
        suggested_fix: cleaned ? sanitizeOutput(cleaned) : null,
      };
    });
    enriched.push({
      ...sc,
      existence: { status: 'not_applicable' },
      flags: pass3Flags,
      _index: enriched.length,
    });
  }

  // ---- Pass 4: Cross-citation judgment ----------------------------------
  await setStatus('judging', 80);

  const { flags: docFlags } = await judgeEdgeCases({
    citations: allClassifications, // Pass 4 sees only the classified list, not enriched
    style: run.style,
    userId,
    runId,
  });

  // Distribute Pass 4 flags onto their target citations (citation_index
  // points at the index in the input array).
  //
  // Round 25 — drop Pass 4 emissions that duplicate Pass 3 territory.
  // Pass 4's prompt explicitly forbids duplicating Pass 3 findings, but
  // Sonnet occasionally emits one anyway — especially form-component rules
  // (R. 3.2(a), R. 6.1, R. 10.2.2/T6, R. 10.4) that Pass 3 owns
  // deterministically. The user-visible symptom is a duplicate comment
  // with TRUNCATED suggested_fix (the LLM uses components.case_name
  // instead of the candidate's full text), e.g. "Council, Inc., 467 U.S.
  // 837..." shadowing Pass 3's correct full Chevron emission.
  //
  // The dedup helper (a) blocklists rule_cites in Pass 3 territory and
  // (b) drops Pass 4 emissions that duplicate a Pass 3 flag already on
  // the target citation. Tested in __tests__/round-25-fixes.test.mjs.
  const { kept: keptPass4, dropped: droppedPass4 } = filterPass4Territory(docFlags, enriched);
  for (const { flag: f, reason } of droppedPass4) {
    console.log(`[orchestrator/pass4] DROP rule=${f.rule_cite} reason=${reason} on cite #${f.citation_index}`);
  }
  for (const f of keptPass4) {
    const target = enriched[f.citation_index];
    if (target) {
      target.flags.push({
        severity: f.severity,
        category: f.category,
        rule_cite: f.rule_cite,
        table_cite: f.table_cite,
        message: f.message,
        suggested_fix: f.suggested_fix,
      });
    }
  }
  if (droppedPass4.length > 0) {
    console.log(`[orchestrator/pass4] dropped ${droppedPass4.length} Pass-3-territory flag(s)`);
  }

  // ---- Pass 5: Output generation ----------------------------------------
  await setStatus('building_outputs', 90);

  // Existence flags — Round 6 + new spec rules:
  //
  //   FIX #1 SUPPRESSION RULE (HARD, NO EXCEPTIONS):
  //     When Pipeline A (any Pass 3 validator) produces ANY flag on a
  //     citation — review or non_conforming, any category — Pipeline B
  //     emits NO UNRESOLVED comment on that same citation. The format
  //     error is plausibly why CourtListener couldn't resolve the cite,
  //     and stacking "could not be located" on top of "missing v.
  //     period" is pure noise.
  //
  //   Spec emission states:
  //     VERIFIED / NOT_APPLICABLE → silent
  //     NAME_MISMATCH → emit (highest-value finding) — NOT suppressed
  //                     by Pipeline A flags because the cite-locates-
  //                     to-different-case finding stands on its own.
  //     LOCATION_MISMATCH → emit, also not suppressed
  //     UNRESOLVED → SUPPRESS when Pipeline A flagged anything
  //
  //   FIX #2 QUOTA / INFRA SUPPRESSION:
  //     Per new spec, quota and infrastructure messages NEVER reach
  //     the user as per-citation comments. existence_quota_exhausted
  //     and existence_api_error are filtered out at the flag-generator
  //     layer (existenceResultToFlag returns null for those).
  for (const c of enriched) {
    const hasPipelineAFlag = (c.flags || []).some((f) => f.category !== 'existence');
    const existenceFlag = existenceResultToFlag(c.existence, { hasFormatError: hasPipelineAFlag });
    // Round 9 instrumentation — make the Pipeline B suppression decision
    // visible in logs so silent suppressions can be traced.
    const text = (c.candidate_text || '').replace(/\s+/g, ' ').slice(0, 80);
    if (c.existence?.status === 'existence_verified' || c.existence?.status === 'not_applicable') {
      // Silent success — log briefly so we can see CL did fire.
      console.log(`[orchestrator/cl #${c._index}] ${c.existence?.status} — "${text}"`);
    } else {
      console.log(`[orchestrator/cl #${c._index}] ${c.existence?.status} | hasPipelineAFlag=${hasPipelineAFlag} | emitted=${existenceFlag ? 'yes' : 'SUPPRESSED'} — "${text}"`);
    }
    if (existenceFlag) {
      c.flags.push(existenceFlag);
    }
  }

  // Pass 5a — form report
  const formReportBuf = await buildFormReport({
    run,
    citations: enriched,
    documentFlags: [],
  });

  // Pass 5b/c — marked source
  let markedSourceBuf;
  let markedContentType;
  if (run.file_format === 'docx') {
    const markup = await applyCitationMarkupDocx(fileBuffer, enriched);
    markedSourceBuf = markup.buffer;
    markedContentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  } else {
    const markup = await applyCitationMarkupPdf(fileBuffer, enriched);
    markedSourceBuf = markup.buffer;
    markedContentType = 'application/pdf';
  }

  // Upload outputs.
  const formReportKey = `${userId}/${runId}/form-check-report.docx`;
  const markedSourceKey = `${userId}/${runId}/marked-source.${run.file_format}`;

  await Promise.all([
    supabase.storage.from(OUTPUT_BUCKET).upload(formReportKey, formReportBuf, {
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      upsert: true,
    }),
    supabase.storage.from(OUTPUT_BUCKET).upload(markedSourceKey, markedSourceBuf, {
      contentType: markedContentType,
      upsert: true,
    }),
  ]);

  // ---- Persist citations + flags to DB ----------------------------------
  // Build inserts. We record candidate_text only when retain_text is true.
  const citationRows = enriched.map((c) => ({
    run_id: runId,
    candidate_text: run.retain_text ? c.candidate_text : null,
    candidate_text_hash: c.candidate_text_hash || hashString(c.candidate_text || ''),
    char_start: c.char_start ?? 0,
    char_end: c.char_end ?? 0,
    page_number: c.page_number ?? null,
    in_footnote: !!c.in_footnote,
    footnote_num: c.footnote_num ?? null,
    citation_type: mapCitationType(c.citation_type),
    components: c.components || {},
    governing_rule: c.governing_rule || null,
    governing_table: c.governing_table || null,
    existence_status: mapExistenceStatusForDb(c.existence?.status),
    courtlistener_opinion_id: c.existence?.opinion_id || null,
    courtlistener_url: c.existence?.url || null,
    courtlistener_search_url: c.existence?.search_url || null,
  }));

  let insertedCitationIds = [];
  if (citationRows.length > 0) {
    const { data, error } = await supabase
      .from('citations')
      .insert(citationRows)
      .select('id');
    if (error) throw new Error(`Citations insert failed: ${error.message}`);
    insertedCitationIds = data.map((r) => r.id);
  }

  // Insert flags one row per citation flag.
  const flagRows = [];
  for (let i = 0; i < enriched.length; i++) {
    const cid = insertedCitationIds[i];
    if (!cid) continue;
    for (const f of enriched[i].flags) {
      flagRows.push({
        citation_id: cid,
        severity: f.severity,
        category: f.category,
        rule_cite: f.rule_cite || null,
        table_cite: f.table_cite || null,
        message: sanitizeOutput(f.message || ''),
        suggested_fix: f.suggested_fix ? sanitizeOutput(f.suggested_fix) : null,
      });
    }
  }
  if (flagRows.length > 0) {
    const { error } = await supabase.from('flags').insert(flagRows);
    if (error) throw new Error(`Flags insert failed: ${error.message}`);
  }

  // ---- Privilege default: delete uploaded source -----------------------
  // Per BUILD_SPEC §16: the document body never persists in this DB; the
  // uploaded source goes away once we've extracted what we need.
  try {
    await supabase.storage.from(INCOMING_BUCKET).remove([incomingKey]);
  } catch (err) {
    console.warn('Failed to delete uploaded source — non-fatal:', err.message);
  }

  // ---- Finalize verification_runs row -----------------------------------
  const counts = computeCounts(enriched);
  await supabase.from('verification_runs').update({
    status: 'complete',
    status_progress: 100,
    citation_count: enriched.length,
    flag_count_review: counts.review,
    flag_count_nonconforming: counts.nonConforming,
    existence_not_found_count: counts.existenceNotFound,
    existence_uncertain_count: counts.existenceUncertain,
    form_report_storage_path: formReportKey,
    marked_source_storage_path: markedSourceKey,
    completed_at: new Date().toISOString(),
  }).eq('id', runId);

  console.log(`[verify-citations] Run ${runId} complete: ${enriched.length} citations, ${counts.review}▲ ${counts.nonConforming}✗`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeCounts(enriched) {
  let review = 0, nonConforming = 0, existenceNotFound = 0, existenceUncertain = 0;
  for (const c of enriched) {
    for (const f of c.flags) {
      if (f.severity === 'review') review++;
      else if (f.severity === 'non_conforming') nonConforming++;
    }
    if (c.existence?.status === 'existence_not_found') existenceNotFound++;
    else if (
      c.existence?.status === 'existence_uncertain' ||
      c.existence?.status === 'existence_name_mismatch' ||
      c.existence?.status === 'existence_location_mismatch'
    ) existenceUncertain++;
  }
  return { review, nonConforming, existenceNotFound, existenceUncertain };
}

/**
 * Map a runtime existence status to a value valid for the
 * citation_existence_status Postgres enum.
 *
 * The enum was defined in 0005_citation_verifier.sql with four values:
 *   existence_verified | existence_not_found | existence_uncertain | not_applicable
 *
 * Round 6 introduced two new in-memory statuses — existence_name_mismatch
 * and existence_location_mismatch — which the DB enum did NOT cover. The
 * insert blew up with: "invalid input value for enum
 * citation_existence_status: 'existence_name_mismatch'".
 *
 * Migration 0007 ALTERs the enum to add those two values. Until that
 * migration is applied, this mapper folds them down to existence_uncertain
 * (the closest pre-existing meaning) so the run completes successfully.
 * After 0007 is applied, this function still works — it's a defensive
 * floor that can stay in place permanently.
 */
function mapExistenceStatusForDb(status) {
  // Original four values pass through unchanged.
  if (
    status === 'existence_verified' ||
    status === 'existence_not_found' ||
    status === 'existence_uncertain' ||
    status === 'not_applicable'
  ) return status;
  // New Round 6 statuses → fold down to existence_uncertain. Both
  // mean "CourtListener returned a hit but something doesn't match
  // the cited form," which is exactly what existence_uncertain
  // already meant. The flag itself (with full message text) is
  // preserved on the citation's flags list — only the DB enum value
  // is downgraded.
  if (status === 'existence_name_mismatch' || status === 'existence_location_mismatch') {
    return 'existence_uncertain';
  }
  // Anything else (defensive): default to not_applicable.
  return status || 'not_applicable';
}

const VALID_CITATION_TYPES = new Set([
  'case', 'statute', 'regulation', 'constitutional',
  'book', 'periodical', 'internet', 'court_document',
  'short_form_id', 'short_form_supra', 'short_form_case', 'unknown',
]);
function mapCitationType(t) {
  return VALID_CITATION_TYPES.has(t) ? t : 'unknown';
}

function hashString(s) {
  // Tiny non-crypto fallback used only when extract.js failed to set the
  // hash (shouldn't happen — extract.js always sets it). Picked to never
  // collide with the SHA-256 hex format so it's identifiable in audit.
  return 'fallback-' + Buffer.from(String(s)).toString('hex').slice(0, 32);
}
