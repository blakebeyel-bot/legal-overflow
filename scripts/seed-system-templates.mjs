#!/usr/bin/env node
/**
 * Standalone template seed runner — bypasses Netlify dev's function
 * bundler (which currently chokes on the `docx` package). Same logic
 * as netlify/functions/template-seed-system.js, run directly under
 * Node from your local terminal.
 *
 * Usage:
 *   node scripts/seed-system-templates.mjs
 *
 * Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Minimal .env loader so we don't drag in dotenv as a dep.
function loadEnv() {
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/i);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const { createClient } = await import('@supabase/supabase-js');
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const { SYSTEM_TEMPLATES, buildTemplateDocx } = await import(
  path.join(root, 'netlify/lib/template-seed-content.js').replace(/\\/g, '/').replace(/^([A-Z]):/, 'file:///$1:')
);

const seeded = [];
const failed = [];

for (const entry of SYSTEM_TEMPLATES) {
  try {
    console.log(`[seed] building ${entry.slug}…`);
    const { buffer } = await buildTemplateDocx(entry.slug);
    const storageKey = `system/templates/${entry.slug}.docx`;

    const { error: upErr } = await supabase.storage
      .from('library')
      .upload(storageKey, buffer, {
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        upsert: true,
      });
    if (upErr) {
      console.error(`[seed] upload ${entry.slug}: ${upErr.message}`);
      failed.push({ slug: entry.slug, stage: 'upload', error: upErr.message });
      continue;
    }

    const previewLines = [`# ${entry.title}`, '', entry.summary, ''];
    for (const v of entry.schema.vars) {
      previewLines.push(`- ${v.label} (${v.type}): ${v.hint || ''}`);
    }
    const content = previewLines.join('\n');

    const slugTag = `system-template:${entry.slug}`;
    const { data: existing } = await supabase
      .from('workspace_vault_items')
      .select('id')
      .is('user_id', null)
      .eq('source_kind', 'template')
      .contains('tags', [slugTag])
      .maybeSingle();

    const row = {
      source_kind: 'template',
      title: entry.title,
      summary: entry.summary,
      tags: ['system-template', slugTag],
      content,
      template_schema: {
        vars: entry.schema.vars,
        auto_detected: false,
        detected_at: new Date().toISOString(),
        confidence: 1.0,
        model_used: null,
        system_seeded: true,
      },
      template_status: 'ready',
      template_storage_path: storageKey,
    };

    if (existing?.id) {
      const { error: updErr } = await supabase
        .from('workspace_vault_items')
        .update(row)
        .eq('id', existing.id);
      if (updErr) {
        console.error(`[seed] update ${entry.slug}: ${updErr.message}`);
        failed.push({ slug: entry.slug, stage: 'update', error: updErr.message });
        continue;
      }
      console.log(`[seed] updated ${entry.slug}`);
    } else {
      const { error: insErr } = await supabase
        .from('workspace_vault_items')
        .insert({ ...row, user_id: null });
      if (insErr) {
        console.error(`[seed] insert ${entry.slug}: ${insErr.message}`);
        failed.push({ slug: entry.slug, stage: 'insert', error: insErr.message });
        continue;
      }
      console.log(`[seed] inserted ${entry.slug}`);
    }
    seeded.push(entry.slug);
  } catch (err) {
    console.error(`[seed] failed ${entry.slug}: ${err?.message || err}`);
    failed.push({ slug: entry.slug, stage: 'exception', error: err?.message || String(err) });
  }
}

console.log('\n=== RESULT ===');
console.log(JSON.stringify({ seeded, failed }, null, 2));
process.exit(failed.length ? 1 : 0);
