/**
 * POST /api/workspace-compare-run-background
 *   body: { run_id, user_id }
 *
 * Background function. Single LLM call comparing the base and
 * proposed documents end-to-end. Persists the diffs into
 * workspace_compare_diffs and updates the run row.
 */
import { getSupabaseAdmin } from '../lib/supabase-admin.js';
import { resolveProviderKey } from '../lib/byok-keys.js';
import { completeText, findModel } from '../lib/llm-providers.js';
import { COMPARE_SYSTEM, buildComparePrompt, parseCompareResponse } from '../lib/compare-prompt.js';

const PER_DOC_TEXT_CAP = 150_000;
const TIMEOUT_MS = 480_000;     // 8 min — comparison is one big call

export default async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const body = await req.json().catch(() => ({}));
  const runId = body.run_id;
  const userId = body.user_id;
  if (!runId || !userId) return new Response('missing run_id/user_id', { status: 400 });

  const supabase = getSupabaseAdmin();

  const fail = async (msg) => {
    console.error(`[compare] ${runId}: ${msg}`);
    await supabase.from('workspace_compare_runs')
      .update({ status: 'error', status_detail: msg.slice(0, 1000) })
      .eq('id', runId);
  };

  const { data: run } = await supabase
    .from('workspace_compare_runs')
    .select('*')
    .eq('id', runId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!run) return new Response('run not found', { status: 404 });

  await supabase.from('workspace_compare_runs').update({ status: 'running' }).eq('id', runId);

  // Load both docs + their extracted text (current version)
  const { data: docs } = await supabase
    .from('workspace_documents')
    .select('id, filename, original_filename, current_version_id')
    .in('id', [run.base_document_id, run.proposed_document_id]);
  const baseDoc = docs?.find((d) => d.id === run.base_document_id);
  const proposedDoc = docs?.find((d) => d.id === run.proposed_document_id);
  if (!baseDoc || !proposedDoc) return fail('One or both documents missing');

  const versionIds = [baseDoc.current_version_id, proposedDoc.current_version_id].filter(Boolean);
  const { data: versions } = await supabase
    .from('workspace_document_versions')
    .select('id, document_id, extracted_text')
    .in('id', versionIds);
  const baseText = versions?.find((v) => v.document_id === baseDoc.id)?.extracted_text;
  const proposedText = versions?.find((v) => v.document_id === proposedDoc.id)?.extracted_text;
  if (!baseText) return fail(`Base document has no extracted text — re-upload it`);
  if (!proposedText) return fail(`Proposed document has no extracted text — re-upload it`);

  const cap = (t) => t.length > PER_DOC_TEXT_CAP ? t.slice(0, PER_DOC_TEXT_CAP) + '\n\n[...truncated]' : t;

  const modelInfo = findModel(run.model || 'claude-sonnet-4-5');
  const { key, source } = await resolveProviderKey({ userId, provider: modelInfo.provider });
  if (!key) return fail(`No API key for ${modelInfo.provider}`);

  let raw;
  try {
    console.log(`[compare] ${runId} starting — base=${baseText.length}c proposed=${proposedText.length}c keySource=${source}`);
    const out = await withTimeout(completeText({
      provider: modelInfo.provider,
      model: modelInfo.id,
      apiKey: key,
      system: COMPARE_SYSTEM,
      messages: [{ role: 'user', content: buildComparePrompt({
        baseText: cap(baseText),
        baseFilename: baseDoc.filename,
        proposedText: cap(proposedText),
        proposedFilename: proposedDoc.filename,
        clientRole: run.client_role,
        additionalContext: run.additional_context,
      }) }],
      maxTokens: 8000,
      temperature: 0.2,
    }), TIMEOUT_MS, 'Comparison timed out');
    raw = out.text;
  } catch (err) {
    return fail(`LLM call failed: ${err.message}`);
  }

  const parsed = parseCompareResponse(raw);
  console.log(`[compare] ${runId} parsed ${parsed.diffs.length} diffs`);

  // Insert diff rows
  const diffRows = parsed.diffs.map((d) => ({
    run_id: runId,
    diff_index: d.diff_index,
    section_name: d.section_name,
    change_type: d.change_type,
    severity: d.severity,
    base_text: d.base_text,
    proposed_text: d.proposed_text,
    why_it_matters: d.why_it_matters,
    recommendation: d.recommendation,
    user_choice: 'pending',
  }));
  if (diffRows.length > 0) {
    const { error: insErr } = await supabase
      .from('workspace_compare_diffs')
      .insert(diffRows);
    if (insErr) return fail(`Diff insert failed: ${insErr.message}`);
  }

  await supabase.from('workspace_compare_runs')
    .update({
      status: 'complete',
      diffs_count: diffRows.length,
      summary: parsed.summary,
      status_detail: parsed.parse_error ? `Parse warning: ${parsed.parse_error}` : null,
    })
    .eq('id', runId);

  console.log(`[compare] ${runId} done`);
  return new Response('ok');
};

function withTimeout(promise, ms, errMsg) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(errMsg)), ms)),
  ]);
}
