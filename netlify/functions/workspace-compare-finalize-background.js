/**
 * POST /api/workspace-compare-finalize-background
 *   header: X-Internal-Trigger: compare-finalize  (CSRF gate)
 *   body: { run_id, user_id }
 *
 * Builds the redline deliverable from a compare run's user_choice
 * decisions:
 *
 *   1. Load run + diffs + proposed document (the side that gets marked
 *      up — the counterparty's draft)
 *   2. Translate user_choice into findings[]:
 *        keep_base       → action='replace', source=proposed_text,
 *                          suggested=base_text
 *        custom          → action='replace', source=proposed_text,
 *                          suggested=user_custom_text
 *        accept_proposed → SKIP (no markup, accepts as-is)
 *        pending         → SKIP (no decision yet)
 *      external_comment = why_it_matters from the diff row
 *   3. Download the proposed doc bytes from Storage
 *   4. Apply markup:
 *        DOCX → applyDocxMarkup (in-process, native <w:ins>/<w:del>)
 *        PDF  → applyPdfMarkup (Modal/PyMuPDF — inline strikethrough
 *               on proposed text + inserted base text drawn between
 *               lines, "1B" inline redline)
 *   5. Upload modified bytes as a new version row
 *   6. Generate markdown summary memo (single LLM call) and persist
 *      on workspace_compare_runs.summary_md
 *   7. Flip status='complete', set finalized_version_id +
 *      finalized_format + finalized_at
 *
 * Errors at any stage land on workspace_compare_runs.status='error'
 * with a status_detail message for the UI.
 */
import { getSupabaseAdmin, getUserDisplayName } from '../lib/supabase-admin.js';
import { applyDocxMarkup } from '../lib/markup-docx.js';
import { applyPdfMarkup } from '../lib/markup-pdf-modal.js';
import { resolveProviderKey } from '../lib/byok-keys.js';
import { completeText, findModel } from '../lib/llm-providers.js';
import crypto from 'node:crypto';

export default async (req) => {
  // CSRF gate — same pattern as workspace-chat-verify-background and
  // workspace-redline-run-background. Browsers can't add custom
  // headers cross-origin without preflight, so this prevents external
  // callers from triggering finalize jobs on other users' run_ids.
  if (req.headers.get('X-Internal-Trigger') !== 'compare-finalize') {
    return new Response('forbidden', { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const runId = body.run_id;
  const userId = body.user_id;
  if (!runId || !userId) return new Response('missing run_id/user_id', { status: 400 });

  const supabase = getSupabaseAdmin();

  // ---- 1. Load run + diffs + docs ----
  const { data: run } = await supabase
    .from('workspace_compare_runs')
    .select('*')
    .eq('id', runId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!run) return new Response('run not found', { status: 404 });

  const fail = async (msg) => {
    console.error(`[compare-finalize] ${runId}: ${msg}`);
    await supabase.from('workspace_compare_runs')
      .update({ status: 'error', status_detail: String(msg).slice(0, 1000) })
      .eq('id', runId);
  };

  const { data: diffs } = await supabase
    .from('workspace_compare_diffs')
    .select('*')
    .eq('run_id', runId)
    .order('diff_index', { ascending: true });
  if (!diffs?.length) {
    await fail('No diffs to finalize on this run');
    return new Response('ok');
  }

  // The PROPOSED doc is the one that gets marked up — it's the
  // counterparty's draft we're sending back with our redlines.
  const { data: proposed } = await supabase
    .from('workspace_documents')
    .select('*, current_version:current_version_id(id, storage_path, size_bytes)')
    .eq('id', run.proposed_document_id)
    .eq('user_id', userId)
    .maybeSingle();
  if (!proposed?.current_version?.storage_path) {
    await fail('Proposed document or current version missing');
    return new Response('ok');
  }

  // Format detection: prefer file_type, fall back to filename
  // extension. The markup helpers diverge sharply on docx vs pdf.
  const filename = proposed.filename || proposed.original_filename || '';
  const ext = filename.toLowerCase().split('.').pop();
  const isDocx = (proposed.file_type || '').toLowerCase().includes('wordprocessingml')
    || ext === 'docx';
  const isPdf = (proposed.file_type || '').toLowerCase().includes('pdf')
    || ext === 'pdf';
  if (!isDocx && !isPdf) {
    await fail(`Unsupported proposed-doc format: ${proposed.file_type || ext}. Redline output requires DOCX or PDF.`);
    return new Response('ok');
  }
  const finalizedFormat = isDocx ? 'docx' : 'pdf';

  // ---- 2. Translate decisions → findings[] ----
  // Each finding has: action, source_text, suggested_text?,
  // external_comment, severity. The markup helpers consume this
  // shape — we mirror what fanout-background.js produces so the
  // markup pipeline doesn't need any special-casing for compare.
  //
  // Action mapping by change_type + user_choice:
  //
  //   change_type   choice            action      source       suggested
  //   ───────────   ──────────────    ─────────   ──────────   ───────────
  //   modification  keep_base         replace     proposed     base
  //   modification  custom            replace     proposed     user_custom
  //   addition      keep_base         delete      proposed     —      (reject the addition: strike it without inserting anything)
  //   addition      custom            replace     proposed     user_custom
  //   deletion      keep_base         insert      —            base   (reinstate the deleted clause; no source to strike)
  //   deletion      custom            insert      —            user_custom
  //   *             accept_proposed   SKIP (proposed already wins)
  //   *             pending           SKIP (no decision)
  //
  // The applyDocxMarkup / applyPdfMarkup helpers honor 'replace',
  // 'delete', and 'insert' actions. 'insert' uses an `anchor_text` if
  // provided, but compare diffs don't carry an anchor — the helpers
  // append at end of doc when no anchor is given. That's not ideal
  // UX for insert-only cases (a small fraction of redlines) but it
  // ensures the user's pushback is preserved somewhere visible.
  const findings = [];
  let skippedAdditionsNoSource = 0;
  let skippedDeletionsNoBase = 0;
  for (const d of diffs) {
    const choice = d.user_choice || 'pending';
    if (choice === 'pending' || choice === 'accept_proposed') continue;
    const proposedText = (d.proposed_text || '').trim();
    const baseText = (d.base_text || '').trim();
    const customText = (d.user_custom_text || '').trim();
    const ct = d.change_type || 'modification';
    const comment = (d.why_it_matters || '').slice(0, 1500);

    let action = null;
    let source = '';
    let suggested = '';

    if (ct === 'modification') {
      if (!proposedText) continue;   // truly nothing to anchor on
      action = 'replace';
      source = proposedText;
      suggested = (choice === 'custom' && customText) ? customText : baseText;
      if (!suggested) continue;
    } else if (ct === 'addition') {
      // The counterparty added language. keep_base = reject the add =
      // strike-only (no insertion). custom = strike + counter language.
      if (!proposedText) { skippedAdditionsNoSource++; continue; }
      if (choice === 'keep_base') {
        action = 'delete';
        source = proposedText;
      } else {  // custom
        action = 'replace';
        source = proposedText;
        suggested = customText || '';
        if (!suggested) continue;
      }
    } else if (ct === 'deletion') {
      // The counterparty removed language. keep_base = restore it.
      // We have no proposed_text to strike, so fall back to insert.
      // Without an anchor the markup helper appends at end of doc —
      // imperfect but preserves the pushback as visible text.
      if (!baseText && choice !== 'custom') { skippedDeletionsNoBase++; continue; }
      action = 'insert';
      suggested = (choice === 'custom' && customText) ? customText : baseText;
      if (!suggested) continue;
    } else {
      continue;
    }

    findings.push({
      id: d.id,
      action,
      source_text: source,
      suggested_text: suggested,
      external_comment: comment,
      severity: d.severity || 'medium',
      category: d.section_name || 'Compare diff',
    });
  }

  if (skippedAdditionsNoSource || skippedDeletionsNoBase) {
    console.warn(`[compare-finalize] ${runId} skipped ${skippedAdditionsNoSource} addition${skippedAdditionsNoSource === 1 ? '' : 's'} with no source text, ${skippedDeletionsNoBase} deletion${skippedDeletionsNoBase === 1 ? '' : 's'} with no base text`);
  }

  if (!findings.length) {
    await fail('No pushbacks to mark up. The diffs you selected may have empty source or replacement text — try picking diffs with substantive base/proposed content.');
    return new Response('ok');
  }

  // ---- 3. Download proposed doc bytes ----
  let originalBytes;
  try {
    const { data: file, error: dlErr } = await supabase.storage
      .from('library')
      .download(proposed.current_version.storage_path);
    if (dlErr) throw dlErr;
    const ab = await file.arrayBuffer();
    originalBytes = Buffer.from(ab);
  } catch (err) {
    await fail(`Storage download failed: ${err.message}`);
    return new Response('ok');
  }

  // ---- 4. Apply markup ----
  // Both helpers return { buffer, applied, unanchored } — destructure
  // the buffer; the previous version accidentally treated the entire
  // result object as bytes, producing corrupt .docx / .pdf files that
  // every reader rejected with "error while processing the file".
  // Author = the user's display_name (set in /account/) or 'Legal
  // Overflow' fallback. Universal across every markup path.
  const author = await getUserDisplayName(userId);
  let markedBytes;
  let unanchored = [];
  try {
    if (isDocx) {
      // applyDocxMarkup is synchronous in-process JS — fast (~1-3s
      // for typical contracts).
      const r = await applyDocxMarkup(originalBytes, findings, { author });
      markedBytes = r?.buffer;
      unanchored = r?.unanchored || [];
    } else {
      // applyPdfMarkup goes to the Modal/PyMuPDF service —
      // strikethrough on proposed text + insertion text drawn
      // between lines. Slower (~30-90s for a 50-page PDF). Falls
      // back to the legacy drawn-line markup if Modal env vars
      // aren't set.
      const r = await applyPdfMarkup(originalBytes, findings, {
        author,
        // Inline-redline mode (option 1B) — strikethrough proposed
        // text and draw inserted text between lines, mimicking
        // Word's tracked-changes look. The Modal service may not
        // recognize this; if so it produces its default annotation
        // style and the PDF still opens cleanly.
        mode: 'inline_redline',
      });
      markedBytes = r?.buffer;
      unanchored = r?.unanchored || [];
    }
    if (!markedBytes || markedBytes.length < 100) {
      throw new Error('markup helper returned empty or too-small buffer');
    }
  } catch (err) {
    await fail(`Markup failed: ${err.message}`);
    return new Response('ok');
  }
  if (unanchored.length) {
    console.warn(`[compare-finalize] ${runId} unanchored=${unanchored.length} — markup couldn't locate ${unanchored.length} text snippet${unanchored.length === 1 ? '' : 's'} in the source`);
  }

  // ---- 5. Upload as new version on the PROPOSED document ----
  const newVersionId = crypto.randomUUID();
  const newPath = `${userId}/${proposed.id}/${newVersionId}.${finalizedFormat}`;
  const contentType = isDocx
    ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    : 'application/pdf';
  try {
    const { error: upErr } = await supabase.storage
      .from('library')
      .upload(newPath, markedBytes, { contentType, upsert: false });
    if (upErr) throw upErr;
  } catch (err) {
    await fail(`Storage upload failed: ${err.message}`);
    return new Response('ok');
  }

  const { data: maxV } = await supabase
    .from('workspace_document_versions')
    .select('version_number')
    .eq('document_id', proposed.id)
    .order('version_number', { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextVersion = (maxV?.version_number || 0) + 1;

  const { data: newVersion, error: vErr } = await supabase
    .from('workspace_document_versions')
    .insert({
      id: newVersionId,
      document_id: proposed.id,
      version_number: nextVersion,
      storage_path: newPath,
      source: 'compare-finalize',
      display_name: `v${nextVersion} — compare redline (${findings.length} change${findings.length === 1 ? '' : 's'})`,
      size_bytes: markedBytes.length,
      extraction_status: 'skipped',
      extraction_detail: 'Compare-finalize redline output; not re-extracted',
    })
    .select('*')
    .single();
  if (vErr) {
    await fail(`Version row insert failed: ${vErr.message}`);
    return new Response('ok');
  }

  // ---- 6. Generate markdown summary memo ----
  // Single LLM call — uses the run's chosen model so a BYOK-Google
  // user gets Gemini, etc. Model availability already validated at
  // run-create time, so this should not 401.
  let summaryMd = '';
  try {
    const modelInfo = findModel(run.model || 'claude-sonnet-4-5');
    const { key } = await resolveProviderKey({ userId, provider: modelInfo.provider });
    if (key) {
      const decisions = diffs.map((d) => {
        const choice = d.user_choice || 'pending';
        return {
          section: d.section_name || '(no section)',
          severity: d.severity || 'medium',
          choice,
          why: d.why_it_matters || '',
          base: (d.base_text || '').slice(0, 400),
          proposed: (d.proposed_text || '').slice(0, 400),
          custom: (d.user_custom_text || '').slice(0, 400),
        };
      });
      const SUMMARY_SYSTEM = `You are a senior associate writing the cover memo that goes WITH a redlined contract you're sending back to opposing counsel. The memo is a brief, professional summary of which proposed changes you accepted, which you pushed back on, and the rationale on the substantive ones. Output is strict markdown.

Format:
# Compare summary — {{contract title}}

{{1-2 sentence overview of the negotiation character}}

## Pushed back ({{N}})
- **§ X.Y Section name** — {{1-line description of what we held to vs what they proposed}}
  Why: {{rationale}}

## Accepted ({{N}})
- **§ X.Y Section name** — {{1-line description}}

## Outstanding ({{N}})  // if any pending decisions remain
- **§ X.Y Section name** — Decision pending

Keep section descriptions ≤ 1 line. Skip "Why:" on Accepted items unless the rationale is genuinely interesting (a clever drafting concession, etc.). Group accepted items in a single paragraph if there are >5 to keep the memo skimmable. End with one short sentence on next steps if obvious. No preamble, no headings beyond what's specified.`;
      const userMsg = `Compare run title: ${run.title || 'Contract comparison'}\n\nDecisions (${diffs.length} total):\n\n${JSON.stringify(decisions, null, 2)}`;
      const out = await completeText({
        provider: modelInfo.provider,
        model: modelInfo.id,
        apiKey: key,
        system: SUMMARY_SYSTEM,
        messages: [{ role: 'user', content: userMsg }],
        maxTokens: 1500,
        temperature: 0.3,
      });
      summaryMd = (out?.text || '').trim();
    }
  } catch (err) {
    console.warn(`[compare-finalize] ${runId} summary memo failed (non-fatal):`, err?.message);
    // Don't fail the whole finalize — the redline file is the main
    // deliverable; summary is a nice-to-have. Fall back to a minimal
    // auto-generated summary so summary_md is never null.
    summaryMd = '';
  }
  if (!summaryMd) {
    // Fallback memo when the LLM call failed — pure deterministic
    // listing so the user still has SOMETHING in summary_md.
    const grouped = { keep_base: [], accept_proposed: [], custom: [], pending: [] };
    for (const d of diffs) (grouped[d.user_choice] || grouped.pending).push(d);
    const lines = [`# Compare summary — ${run.title || 'Contract comparison'}`, ''];
    if (grouped.keep_base.length) {
      lines.push(`## Pushed back (${grouped.keep_base.length})`);
      for (const d of grouped.keep_base) lines.push(`- **${d.section_name || '(section)'}** — held to template language`);
      lines.push('');
    }
    if (grouped.accept_proposed.length) {
      lines.push(`## Accepted (${grouped.accept_proposed.length})`);
      for (const d of grouped.accept_proposed) lines.push(`- **${d.section_name || '(section)'}**`);
      lines.push('');
    }
    if (grouped.custom.length) {
      lines.push(`## Counter-proposed (${grouped.custom.length})`);
      for (const d of grouped.custom) lines.push(`- **${d.section_name || '(section)'}** — countered with custom language`);
      lines.push('');
    }
    if (grouped.pending.length) {
      lines.push(`## Outstanding (${grouped.pending.length})`);
      for (const d of grouped.pending) lines.push(`- **${d.section_name || '(section)'}** — decision pending`);
    }
    summaryMd = lines.join('\n');
  }

  // ---- 7. Flip run row to complete + persist all the new fields ----
  await supabase.from('workspace_compare_runs')
    .update({
      status: 'complete',
      status_detail: null,
      finalized_version_id: newVersion.id,
      finalized_format: finalizedFormat,
      finalized_at: new Date().toISOString(),
      summary_md: summaryMd.slice(0, 20000),
    })
    .eq('id', runId);

  console.log(`[compare-finalize] ${runId} done — ${findings.length} markups, format=${finalizedFormat}, version=${newVersion.id}`);
  return new Response('ok');
};
