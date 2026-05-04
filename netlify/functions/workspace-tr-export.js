/**
 * GET /api/workspace-tr-export?id=<uuid>&format=csv
 *
 * Returns the review as a CSV file Excel opens directly. Each row is
 * a document, columns are: Document, then one column per review
 * column showing answer, plus a paired "Source" column with the
 * verbatim quote and page number.
 *
 * Format: csv only for now. (Real .xlsx would need a library; CSV
 * imports cleanly into Excel/Sheets/Numbers and the formatting
 * difference doesn't matter for a review grid.)
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';

export default async (req) => {
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return jsonErr(auth.error, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return jsonErr('Account pending approval', 403);

  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  if (!id) return jsonErr('Missing id', 400);

  const supabase = getSupabaseAdmin();
  const { data: review } = await supabase
    .from('workspace_tabular_reviews')
    .select('*')
    .eq('id', id)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (!review) return jsonErr('Review not found', 404);

  const { data: cells } = await supabase
    .from('workspace_tabular_cells')
    .select('document_id, column_index, content, citations, status')
    .eq('review_id', id);

  const docIds = Array.from(new Set((cells || []).map((c) => c.document_id)));
  const { data: docs } = docIds.length
    ? await supabase.from('workspace_documents').select('id, filename').in('id', docIds)
    : { data: [] };
  const docName = Object.fromEntries((docs || []).map((d) => [d.id, d.filename]));

  const cols = review.columns_config || [];
  const cellMap = {};
  for (const c of cells || []) cellMap[`${c.document_id}|${c.column_index}`] = c;

  // Build CSV. RFC 4180-ish: double-quote all fields, escape internal
  // quotes by doubling.
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v).replace(/"/g, '""');
    return `"${s}"`;
  };
  const header = ['Document'];
  for (const c of cols) {
    header.push(c.name || `Column ${c.index + 1}`);
    header.push(`${c.name || `Column ${c.index + 1}`} — Source`);
  }
  const lines = [header.map(esc).join(',')];
  for (const docId of docIds) {
    const row = [docName[docId] || docId];
    for (const c of cols) {
      const cell = cellMap[`${docId}|${c.index}`];
      if (!cell) { row.push(''); row.push(''); continue; }
      row.push(cell.content || '');
      const cite = (cell.citations || [])[0];
      const sourceText = cite
        ? `"${cite.quote || ''}"${cite.page ? ` (p. ${cite.page})` : ''}`
        : '';
      row.push(sourceText);
    }
    lines.push(row.map(esc).join(','));
  }
  const csv = '﻿' + lines.join('\r\n');   // BOM for Excel UTF-8

  const filename = `${(review.title || 'review').replace(/[^a-z0-9_\- ]/gi, '_').slice(0, 80)}.csv`;
  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
};

function jsonErr(msg, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
