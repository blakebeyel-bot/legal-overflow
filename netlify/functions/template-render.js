/**
 * POST /api/template-render
 *
 * Body shape — EITHER:
 *   {
 *     template_id: uuid,
 *     source_message_id: uuid,   // pull content from this chat message
 *     chat_id?: uuid              // optional, used for back-linking
 *   }
 * OR:
 *   {
 *     template_id: uuid,
 *     values: { key: value, ... },  // direct values (used by Phase 3 + 5)
 *     chat_id?: uuid,
 *     focus_key?: string            // refinement: only update this field
 *   }
 *
 * Pipeline:
 *   1. Auth + ownership check (template_id must belong to user OR be
 *      a published system template).
 *   2. Load template_schema. Resolve original .docx bytes via
 *      template_storage_path OR source_doc_id → current version.
 *   3. If source_message_id provided: run extraction model to map
 *      message content → schema values. Merge with any direct values.
 *      If values provided directly: use them as-is.
 *   4. Run mergeTemplate to produce the merged .docx bytes.
 *   5. Upload merged bytes to library bucket at
 *      <user_id>/drafts/<vault_item_id>.docx
 *   6. Insert a workspace_vault_items row with source_kind='draft',
 *      rendered_from_template_id, rendered_values, rendered_storage_path,
 *      content = a plain-text rendering of the merged fields (so it's
 *      searchable in vault + chat-anchors).
 *   7. Return {
 *        draft_id, download_url, missing_fields, filled_count,
 *        rendered_values
 *      }
 */
import { requireUser, getSupabaseAdmin, checkUserApproval } from '../lib/supabase-admin.js';
import { mergeTemplate, mergeTemplateBody, computeMissingFields, extractBodyContent, wrapInLetterhead } from '../lib/template-merge.js';
import { extractValues } from '../lib/template-extract.js';

const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const auth = await requireUser(req.headers.get('Authorization'));
  if (auth.error) return json({ error: auth.error }, auth.status);
  const approval = await checkUserApproval(auth.user.id);
  if (!approval.approved) return json({ error: 'Account pending approval', pending_approval: true }, 403);

  const body = await req.json().catch(() => ({}));
  const templateId = body.template_id;
  const sourceMessageId = body.source_message_id || null;
  // Raw fallback content — used when the caller doesn't have a server
  // message id yet (e.g. clicking "Use in template" on a still-streaming
  // bubble). We treat this as authenticated content from the user's
  // browser; ownership is implicit through requireUser above.
  const sourceContent = typeof body.source_content === 'string' && body.source_content.trim()
    ? body.source_content
    : null;
  const directValues = (body.values && typeof body.values === 'object' && !Array.isArray(body.values)) ? body.values : null;
  const chatId = body.chat_id || null;
  const focusKey = body.focus_key || null;
  // Render mode — 'fields' (default) fills placeholders; 'body'
  // writes the source content into the document body while keeping
  // header / footer / styles intact (for letterhead-only templates).
  const mode = (body.mode === 'body') ? 'body' : 'fields';
  // For body mode: optional raw text the user wants in the body
  // instead of (or in addition to) pulling from the source message.
  const directBodyText = typeof body.body_text === 'string' ? body.body_text : null;
  // Apply user's default letterhead — when true, after the normal
  // merge runs we extract the body XML and inject it into the
  // letterhead template (preserving the letterhead's header / footer
  // with logo + firm info). Defaults to true; pass false to opt out.
  const applyLetterhead = body.apply_letterhead !== false;
  // Optional: if the caller is iterating on an existing draft, pass
  // the prior draft_id so we can pull its rendered_values forward and
  // merge with the new extraction (full revision-loop behavior).
  const priorDraftId = body.prior_draft_id || null;
  if (!templateId) return json({ error: 'Missing template_id' }, 400);
  if (!sourceMessageId && !sourceContent && !directValues) {
    return json({ error: 'Provide source_message_id, source_content, or values' }, 400);
  }

  const supabase = getSupabaseAdmin();

  // 1. Load template — must be owned by user OR a published system
  //    template (user_id IS NULL with source_kind='template').
  const { data: tmpl, error: tmplErr } = await supabase
    .from('workspace_vault_items')
    .select('id, user_id, source_kind, title, template_schema, template_storage_path, source_doc_id, content')
    .eq('id', templateId)
    .or(`user_id.eq.${auth.user.id},user_id.is.null`)
    .maybeSingle();
  if (tmplErr) return json({ error: tmplErr.message }, 500);
  if (!tmpl) return json({ error: 'Template not found' }, 404);
  if (tmpl.source_kind !== 'template') {
    return json({ error: 'Item is not a template (run "Promote to template" first)' }, 400);
  }
  const schema = tmpl.template_schema && Array.isArray(tmpl.template_schema.vars)
    ? tmpl.template_schema
    : { vars: [] };

  // 2. Resolve original .docx bytes.
  const docxBuffer = await resolveTemplateBytes({ supabase, template: tmpl });
  if (!docxBuffer) {
    return json({
      error: 'Original .docx not available for this template. Re-upload the template as a .docx to enable rendering.',
    }, 400);
  }

  // 3. Determine values / body text depending on the mode.
  let values = {};
  let bodyText = '';
  let modelUsed = null;
  // Pull prior values if continuing a revision (fields mode only).
  if (priorDraftId) {
    const { data: priorDraft } = await supabase
      .from('workspace_vault_items')
      .select('id, rendered_values, rendered_from_template_id')
      .eq('id', priorDraftId)
      .eq('user_id', auth.user.id)
      .maybeSingle();
    if (priorDraft?.rendered_values && typeof priorDraft.rendered_values === 'object') {
      values = { ...priorDraft.rendered_values };
    }
  }
  // Resolve the actual source text once — preferring the canonical
  // DB version when we have a message id, falling back to the
  // caller-provided raw content. Either path produces `sourceText`.
  let sourceText = '';
  if (sourceMessageId) {
    const { data: msg } = await supabase
      .from('workspace_chat_messages')
      .select('id, chat_id, content, role')
      .eq('id', sourceMessageId)
      .maybeSingle();
    if (!msg) return json({ error: 'Source message not found' }, 404);
    const { data: chat } = await supabase
      .from('workspace_chats')
      .select('id, user_id')
      .eq('id', msg.chat_id)
      .eq('user_id', auth.user.id)
      .maybeSingle();
    if (!chat) return json({ error: 'Chat ownership failed' }, 403);
    sourceText = String(msg.content || '');
  } else if (sourceContent) {
    sourceText = sourceContent;
  }

  if (sourceText) {
    if (mode === 'body') {
      // Body mode: source text becomes the document body verbatim.
      // No extraction needed — the AI already wrote what should be in the doc.
      bodyText = sourceText;
    } else {
      // Fields mode: extract structured values from the source text.
      // Pass userId so the extractor uses the user's BYOK key
      // (Anthropic or Google) first, falling back to server env.
      const { values: extracted, model_used } = await extractValues({
        vars: schema.vars,
        content: sourceText,
        existingValues: values,
        focusKey,
        userId: auth.user.id,
      });
      values = extracted;
      modelUsed = model_used;
    }
  }
  if (mode === 'body' && directBodyText) {
    // Direct body text takes precedence over source-message content.
    bodyText = directBodyText;
  }
  if (mode === 'fields' && directValues) {
    // Direct values take precedence over extraction.
    for (const [k, v] of Object.entries(directValues)) {
      values[k] = v;
    }
  }
  if (mode === 'body' && !bodyText.trim()) {
    return json({ error: 'Body mode requires source content (source_message_id or body_text).' }, 400);
  }

  // 4. Merge — pick path based on mode.
  let mergedBuffer;
  try {
    if (mode === 'body') {
      mergedBuffer = mergeTemplateBody({ docxBuffer, bodyContent: bodyText });
    } else {
      mergedBuffer = mergeTemplate({ docxBuffer, vars: schema.vars, values });
    }
  } catch (err) {
    console.error('[template-render] merge failed:', err);
    return json({ error: 'Merge failed: ' + (err.message || err) }, 500);
  }

  // 4b. Apply user's default letterhead if they have one and didn't
  //     opt out. Skip when the source template IS the letterhead
  //     itself (would no-op anyway, but better to short-circuit).
  let letterheadApplied = false;
  let letterheadTitle = null;
  if (applyLetterhead) {
    const { data: letterhead } = await supabase
      .from('workspace_vault_items')
      .select('id, title, template_storage_path, source_doc_id')
      .eq('user_id', auth.user.id)
      .eq('source_kind', 'template')
      .eq('is_default_letterhead', true)
      .is('archived_at', null)
      .maybeSingle();
    if (letterhead && letterhead.id !== tmpl.id) {
      try {
        const letterheadBuffer = await resolveTemplateBytes({ supabase, template: letterhead });
        if (letterheadBuffer) {
          // Strip any leading right-aligned paragraphs (the "fake
          // letterhead block" pre-built letter templates use to look
          // right standalone) — the user's letterhead already has
          // that info in its actual header.
          const bodyXml = extractBodyContent(mergedBuffer, { stripLetterheadBlock: true });
          mergedBuffer = wrapInLetterhead({ letterheadBuffer, bodyXml });
          letterheadApplied = true;
          letterheadTitle = letterhead.title;
        } else {
          console.warn(`[template-render] letterhead bytes unresolvable for ${letterhead.id}; skipping wrap`);
        }
      } catch (err) {
        console.warn(`[template-render] letterhead wrap failed: ${err?.message || err}`);
        // Continue with un-wrapped output rather than failing the whole render.
      }
    }
  }

  // 5. Insert the draft vault item FIRST so we have an id for the
  //    storage path. We'll patch the storage_path after upload.
  const filledCount = (mode === 'body')
    ? (bodyText.trim() ? 1 : 0)
    : schema.vars.filter((v) => values[v.key] !== null && values[v.key] !== undefined && String(values[v.key] ?? '').trim() !== '').length;
  const totalFields = (mode === 'body') ? 1 : schema.vars.length;
  const missing = (mode === 'body') ? [] : computeMissingFields({ vars: schema.vars, values });
  const renderedContent = (mode === 'body')
    ? `# ${tmpl.title || 'Draft'}\n\n${bodyText}`
    : buildPlainTextRendering({ title: tmpl.title, vars: schema.vars, values });
  const draftTitle = `Draft – ${tmpl.title || 'Template'} – ${new Date().toLocaleString()}`;

  const { data: draftRow, error: draftErr } = await supabase
    .from('workspace_vault_items')
    .insert({
      user_id: auth.user.id,
      source_kind: 'draft',
      source_chat_id: chatId,
      source_message_id: sourceMessageId,
      title: draftTitle.slice(0, 500),
      content: renderedContent.slice(0, 200000),
      tags: ['draft', mode === 'body' ? 'template-body' : 'template-merge'],
      rendered_from_template_id: tmpl.id,
      rendered_values: (mode === 'body') ? { body_text: bodyText } : values,
    })
    .select('*')
    .single();
  if (draftErr) {
    console.error('[template-render] draft insert failed:', draftErr);
    return json({ error: draftErr.message }, 500);
  }

  // 6. Upload merged .docx to storage.
  const storageKey = `${auth.user.id}/drafts/${draftRow.id}.docx`;
  const { error: upErr } = await supabase.storage
    .from('library')
    .upload(storageKey, mergedBuffer, {
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      upsert: true,
    });
  if (upErr) {
    console.error('[template-render] upload failed:', upErr);
    // Roll back the draft row so we don't have a phantom record.
    await supabase.from('workspace_vault_items').delete().eq('id', draftRow.id).catch(() => {});
    return json({ error: 'Storage upload failed: ' + upErr.message }, 500);
  }

  await supabase
    .from('workspace_vault_items')
    .update({ rendered_storage_path: storageKey })
    .eq('id', draftRow.id);

  // 7. Signed URL for immediate download in the chat bubble.
  const { data: signed, error: sigErr } = await supabase.storage
    .from('library')
    .createSignedUrl(storageKey, SIGNED_URL_TTL_SECONDS, {
      download: `${(tmpl.title || 'draft').replace(/[^A-Za-z0-9 _.-]/g, '_')}.docx`,
    });
  if (sigErr) {
    console.warn('[template-render] signed url failed:', sigErr);
  }

  console.log(`[template-render] user=${auth.user.id} template=${templateId} draft=${draftRow.id} mode=${mode} filled=${filledCount}/${totalFields} model=${modelUsed || 'direct'}`);

  return json({
    draft_id: draftRow.id,
    draft_title: draftTitle,
    download_url: signed?.signedUrl || null,
    storage_path: storageKey,
    filled_count: filledCount,
    total_fields: totalFields,
    missing_fields: missing,
    rendered_values: (mode === 'body') ? { body_text: bodyText } : values,
    model_used: modelUsed,
    mode,
    letterhead_applied: letterheadApplied,
    letterhead_title: letterheadTitle,
  });
};

/**
 * Resolve the original .docx bytes for a template. Tries, in order:
 *   1. template_storage_path on the vault item (preferred — set when
 *      the user uploads a .docx directly as a template).
 *   2. source_doc_id → current version's storage_path (works for any
 *      vault item that was auto-detected as a template after a normal
 *      library upload — most common case).
 *
 * Returns Buffer or null.
 */
async function resolveTemplateBytes({ supabase, template }) {
  // Path 1 — explicit storage path on the template row.
  if (template.template_storage_path) {
    try {
      const { data, error } = await supabase.storage
        .from('library')
        .download(template.template_storage_path);
      if (!error && data) {
        const ab = await data.arrayBuffer();
        return Buffer.from(ab);
      }
    } catch (err) {
      console.warn('[template-render] template_storage_path download failed:', err?.message || err);
    }
  }

  // Path 2 — chase source_doc_id to its current version.
  if (template.source_doc_id) {
    try {
      const { data: doc } = await supabase
        .from('workspace_documents')
        .select('id, current_version_id')
        .eq('id', template.source_doc_id)
        .maybeSingle();
      if (!doc?.current_version_id) return null;
      const { data: ver } = await supabase
        .from('workspace_document_versions')
        .select('id, storage_path')
        .eq('id', doc.current_version_id)
        .maybeSingle();
      if (!ver?.storage_path) return null;
      // Only .docx is mergeable — confirm by extension.
      if (!/\.docx$/i.test(ver.storage_path)) return null;
      const { data, error } = await supabase.storage
        .from('library')
        .download(ver.storage_path);
      if (error || !data) return null;
      const ab = await data.arrayBuffer();
      return Buffer.from(ab);
    } catch (err) {
      console.warn('[template-render] source_doc_id resolution failed:', err?.message || err);
    }
  }

  return null;
}

/**
 * Plain-text rendering of the merged template, used as the draft
 * vault item's `content` field so it's searchable.
 */
function buildPlainTextRendering({ title, vars, values }) {
  const lines = [`# ${title || 'Draft'}`, ''];
  for (const v of (vars || [])) {
    const val = values?.[v.key];
    const display = val === null || val === undefined || val === '' ? '[unfilled]' : String(val);
    lines.push(`${v.label || v.key}: ${display}`);
  }
  return lines.join('\n');
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
