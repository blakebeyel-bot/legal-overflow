/**
 * POST /api/workspace-tr-run-background
 *   body: { review_id, user_id }
 *
 * Background function (must end in `-background` per Netlify
 * convention; gets up to 15 min runtime). Reads all pending cells for
 * the review, runs the LLM call for each (concurrency-limited), and
 * persists the result on the cell row.
 *
 * Each cell call uses the model recorded on the review row, the user's
 * BYOK key (or server fallback), and the doc's pre-extracted text from
 * workspace_document_versions. We don't re-extract here.
 */
import { getSupabaseAdmin } from '../lib/supabase-admin.js';
import { resolveProviderKey } from '../lib/byok-keys.js';
import { completeText, findModel } from '../lib/llm-providers.js';
import { TABULAR_SYSTEM, buildCellPrompt, parseCellResponse } from '../lib/tabular-prompt.js';

const CONCURRENCY = 3;       // simultaneous LLM calls per fanout
const PER_CELL_TIMEOUT_MS = 90_000;
const PER_DOC_TEXT_CAP = 200_000;   // chars of doc text per cell prompt

export default async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const body = await req.json().catch(() => ({}));
  const reviewId = body.review_id;
  const userId = body.user_id;
  if (!reviewId || !userId) return new Response('missing review_id/user_id', { status: 400 });

  const supabase = getSupabaseAdmin();

  // Load review (and verify ownership)
  const { data: review } = await supabase
    .from('workspace_tabular_reviews')
    .select('*')
    .eq('id', reviewId)
    .eq('user_id', userId)
    .single();
  if (!review) return new Response('review not found', { status: 404 });

  await supabase.from('workspace_tabular_reviews').update({ status: 'running' }).eq('id', reviewId);

  // Pull doc texts ONCE (each doc may have N cells)
  const docIds = Array.from(new Set([])); // populated below
  const { data: cells, error: cErr } = await supabase
    .from('workspace_tabular_cells')
    .select('id, document_id, column_index, status')
    .eq('review_id', reviewId)
    .in('status', ['pending', 'error']);
  if (cErr) {
    await supabase.from('workspace_tabular_reviews').update({ status: 'error', status_detail: cErr.message }).eq('id', reviewId);
    return new Response(cErr.message, { status: 500 });
  }
  for (const c of cells) docIds.push(c.document_id);

  const uniqueDocIds = Array.from(new Set(docIds));
  const { data: docs } = await supabase
    .from('workspace_documents')
    .select('id, filename, current_version_id')
    .in('id', uniqueDocIds);
  const docByid = Object.fromEntries((docs || []).map((d) => [d.id, d]));

  const versionIds = (docs || []).map((d) => d.current_version_id).filter(Boolean);
  const { data: versions } = await supabase
    .from('workspace_document_versions')
    .select('id, document_id, extracted_text, extraction_status')
    .in('id', versionIds);
  const textByDoc = {};
  for (const v of versions || []) {
    if (v.extracted_text) {
      let t = v.extracted_text;
      if (t.length > PER_DOC_TEXT_CAP) t = t.slice(0, PER_DOC_TEXT_CAP) + '\n\n[...truncated]';
      textByDoc[v.document_id] = t;
    }
  }

  // Resolve model + key once per provider
  const modelInfo = findModel(review.model) || findModel('claude-sonnet-4-5');
  const { key, source } = await resolveProviderKey({ userId, provider: modelInfo.provider });
  if (!key) {
    await markAllCellsError(supabase, reviewId, `No API key configured for ${modelInfo.provider}`);
    await supabase.from('workspace_tabular_reviews').update({ status: 'error', status_detail: 'no api key' }).eq('id', reviewId);
    return new Response('no key', { status: 400 });
  }

  // Group cells by status; we run pending + error (retry) ones.
  const pending = cells.filter((c) => c.status === 'pending' || c.status === 'error');
  console.log(`[tr-fanout] review=${reviewId} cells=${pending.length} model=${modelInfo.id} keySource=${source}`);

  // Mark all running atomically (cosmetic — UI shows spinner)
  await supabase.from('workspace_tabular_cells')
    .update({ status: 'running', status_detail: null })
    .in('id', pending.map((c) => c.id));

  // Fan out with concurrency limit
  let completed = 0;
  let failed = 0;
  const queue = [...pending];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length > 0) {
      const cell = queue.shift();
      if (!cell) break;
      try {
        await runOneCell({
          supabase, cell, review, modelInfo, key, docByid, textByDoc,
        });
        completed++;
      } catch (err) {
        failed++;
        console.error(`[tr-fanout] cell ${cell.id} failed:`, err.message);
        await supabase.from('workspace_tabular_cells')
          .update({ status: 'error', status_detail: err.message?.slice(0, 1000) || 'unknown' })
          .eq('id', cell.id);
      }
    }
  });
  await Promise.all(workers);

  const finalStatus = failed === 0 ? 'complete' : (completed > 0 ? 'partial' : 'error');
  await supabase.from('workspace_tabular_reviews')
    .update({ status: finalStatus, status_detail: failed > 0 ? `${failed} cells failed` : null })
    .eq('id', reviewId);

  console.log(`[tr-fanout] review=${reviewId} done. completed=${completed} failed=${failed}`);
  return new Response('ok');
};

async function runOneCell({ supabase, cell, review, modelInfo, key, docByid, textByDoc }) {
  const doc = docByid[cell.document_id];
  if (!doc) throw new Error('Document not found');
  const text = textByDoc[cell.document_id];
  if (!text) throw new Error('Document has no extracted text — cannot review');

  const column = (review.columns_config || [])[cell.column_index];
  if (!column) throw new Error(`Column ${cell.column_index} not found on review`);

  const userPrompt = buildCellPrompt({
    documentText: text,
    documentName: doc.filename,
    columnPrompt: column.prompt,
  });

  const t0 = Date.now();
  const { text: raw, usage } = await withTimeout(
    completeText({
      provider: modelInfo.provider,
      model: modelInfo.id,
      apiKey: key,
      system: TABULAR_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 600,
      temperature: 0.2,
    }),
    PER_CELL_TIMEOUT_MS,
    `Cell timed out after ${PER_CELL_TIMEOUT_MS}ms`,
  );

  const parsed = parseCellResponse(raw);
  const citations = parsed.quote ? [{
    quote: parsed.quote,
    page: parsed.page,
    document_id: cell.document_id,
    document_name: doc.filename,
    not_in_document: parsed.not_in_document,
  }] : [];

  await supabase.from('workspace_tabular_cells')
    .update({
      status: 'complete',
      content: parsed.answer,
      citations,
      prompt_tokens: usage.input || null,
      completion_tokens: usage.output || null,
      status_detail: parsed.parse_error ? `Parse warning: ${parsed.parse_error}` : null,
    })
    .eq('id', cell.id);

  console.log(`[tr-fanout] cell ${cell.id} ok in ${Date.now() - t0}ms`);
}

async function markAllCellsError(supabase, reviewId, msg) {
  await supabase.from('workspace_tabular_cells')
    .update({ status: 'error', status_detail: msg.slice(0, 1000) })
    .eq('review_id', reviewId)
    .in('status', ['pending', 'running']);
}

function withTimeout(promise, ms, errMsg) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(errMsg)), ms)),
  ]);
}
