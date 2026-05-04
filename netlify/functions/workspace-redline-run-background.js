/**
 * POST /api/workspace-redline-run-background
 *   body: { run_id, user_id }
 *
 * Background function (15 min timeout). Reads the redline-run row
 * status='pending', runs:
 *   1. LLM call: produce JSON edits from doc + concerns
 *   2. POST original .docx + edits to LibreOffice service /redline
 *   3. Upload result to Supabase Storage as a new version
 *   4. Insert document_versions row with source='redline'
 *   5. Update run row with summary + new version_id + status='complete'
 *
 * Errors at any stage are persisted on the run row so the polling UI
 * can show them.
 */
import { getSupabaseAdmin } from '../lib/supabase-admin.js';
import { resolveProviderKey } from '../lib/byok-keys.js';
import { completeText, findModel } from '../lib/llm-providers.js';
import { REDLINE_SYSTEM, buildRedlinePrompt, parseRedlineResponse } from '../lib/redline-prompt.js';

export default async (req) => {
  const body = await req.json().catch(() => ({}));
  const runId = body.run_id;
  const userId = body.user_id;
  if (!runId || !userId) return new Response('missing run_id/user_id', { status: 400 });

  const supabase = getSupabaseAdmin();

  const { data: run, error: runErr } = await supabase
    .from('workspace_redline_runs')
    .select('*')
    .eq('id', runId)
    .eq('user_id', userId)
    .single();
  if (runErr || !run) return new Response('run not found', { status: 404 });

  const fail = async (msg) => {
    console.error(`[redline] ${runId}: ${msg}`);
    await supabase.from('workspace_redline_runs')
      .update({ status: 'error', status_detail: msg.slice(0, 1000) })
      .eq('id', runId);
  };

  await supabase.from('workspace_redline_runs').update({ status: 'running' }).eq('id', runId);

  // 1. Load doc + extracted text
  const { data: doc } = await supabase
    .from('workspace_documents')
    .select('*, current_version:current_version_id(id, storage_path, extracted_text)')
    .eq('id', run.document_id)
    .eq('user_id', userId)
    .maybeSingle();
  if (!doc) return fail('Document not found');
  if (!doc.original_filename?.toLowerCase().endsWith('.docx')) {
    return fail('Redlining requires a .docx (Word) file. PDFs and other formats not supported yet.');
  }
  const text = doc.current_version?.extracted_text;
  if (!text) return fail('Document has no extracted text — re-upload it');

  // 2. LLM call to produce edits
  const modelInfo = findModel(run.model || 'claude-sonnet-4-5');
  const { key } = await resolveProviderKey({ userId, provider: modelInfo.provider });
  if (!key) return fail(`No API key for ${modelInfo.provider}`);

  let raw, summary, edits;
  try {
    const out = await completeText({
      provider: modelInfo.provider,
      model: modelInfo.id,
      apiKey: key,
      system: REDLINE_SYSTEM,
      messages: [{ role: 'user', content: buildRedlinePrompt({ documentText: text, documentName: doc.filename, concerns: run.concerns }) }],
      maxTokens: 4096,
      temperature: 0.2,
    });
    raw = out.text;
    const parsed = parseRedlineResponse(raw);
    summary = parsed.summary;
    edits = parsed.edits;
    if (parsed.parse_error) {
      console.warn(`[redline] ${runId} parse warning: ${parsed.parse_error}`);
    }
  } catch (err) {
    return fail(`LLM call failed: ${err.message}`);
  }
  console.log(`[redline] ${runId} edits=${edits.length}`);

  if (edits.length === 0) {
    await supabase.from('workspace_redline_runs')
      .update({
        status: 'complete',
        status_detail: 'no edits suggested',
        edits_summary: summary || 'The model proposed no edits for these concerns.',
        edits_count: 0,
      })
      .eq('id', runId);
    return new Response('done — no edits');
  }

  // 3. Download original from storage
  let originalBytes;
  try {
    const { data: file, error: dlErr } = await supabase.storage.from('library').download(doc.current_version.storage_path);
    if (dlErr) throw dlErr;
    const ab = await file.arrayBuffer();
    originalBytes = Buffer.from(ab);
  } catch (err) {
    return fail(`Storage download failed: ${err.message}`);
  }

  // 4. POST to Fly LibreOffice service
  const flyUrl = process.env.LIBREOFFICE_SERVICE_URL;
  const flyToken = process.env.LIBREOFFICE_SERVICE_TOKEN;
  if (!flyUrl || !flyToken) return fail('LIBREOFFICE_SERVICE_URL / TOKEN not set');

  let modifiedBytes;
  try {
    const flyRes = await fetch(`${flyUrl.replace(/\/$/, '')}/redline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${flyToken}` },
      body: JSON.stringify({
        docx_b64: originalBytes.toString('base64'),
        edits,
        author: 'Legal Overflow',
      }),
    });
    if (!flyRes.ok) {
      const errText = await flyRes.text().catch(() => '');
      return fail(`Redline service ${flyRes.status}: ${errText.slice(0, 500)}`);
    }
    const flyJson = await flyRes.json();
    modifiedBytes = Buffer.from(flyJson.docx_b64, 'base64');
  } catch (err) {
    return fail(`Redline service error: ${err.message}`);
  }

  // 5. Upload as new version
  const newVersionId = crypto.randomUUID();
  const ext = 'docx';
  const newPath = `${userId}/${doc.id}/${newVersionId}.${ext}`;
  try {
    const { error: upErr } = await supabase.storage
      .from('library')
      .upload(newPath, modifiedBytes, { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', upsert: false });
    if (upErr) throw upErr;
  } catch (err) {
    return fail(`Storage upload failed: ${err.message}`);
  }

  // 6. Determine version number
  const { data: maxV } = await supabase
    .from('workspace_document_versions')
    .select('version_number')
    .eq('document_id', doc.id)
    .order('version_number', { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextVersion = (maxV?.version_number || 0) + 1;

  const { data: newVersion, error: vErr } = await supabase
    .from('workspace_document_versions')
    .insert({
      id: newVersionId,
      document_id: doc.id,
      version_number: nextVersion,
      storage_path: newPath,
      source: 'redline',
      display_name: `v${nextVersion} — redline by ${modelInfo.label || modelInfo.id}`,
      size_bytes: modifiedBytes.length,
      extraction_status: 'skipped',   // we don't re-extract text from the redlined file
      extraction_detail: 'tracked-changes version; original text used for analysis',
    })
    .select('*')
    .single();
  if (vErr) return fail(`Version row insert failed: ${vErr.message}`);

  // 7. Mark run complete
  await supabase.from('workspace_redline_runs')
    .update({
      status: 'complete',
      status_detail: null,
      edits_summary: summary,
      edits_count: edits.length,
      result_version_id: newVersion.id,
    })
    .eq('id', runId);

  console.log(`[redline] ${runId} complete — ${edits.length} edits, version ${newVersion.id}`);
  return new Response('ok');
};
