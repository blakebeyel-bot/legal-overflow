#!/usr/bin/env node
/**
 * Sync src/content/articles/*.md → Supabase `articles` table.
 *
 * One-shot, idempotent. Reads every markdown file in the articles
 * directory, parses its frontmatter, upserts the row to Supabase by
 * slug, and deletes any rows whose slug no longer has a backing .md
 * file. Run after editing article content so the admin page (and
 * the public site at next build) reflects the changes.
 *
 * Usage:
 *   node scripts/sync-articles-to-supabase.mjs
 *
 * Behavior is conservative — by default it dry-runs the delete step
 * and prompts for confirmation. Pass --yes to skip the prompt.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const articlesDir = path.join(root, 'src/content/articles');

// Minimal .env loader (same pattern as seed-system-templates.mjs).
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

const args = new Set(process.argv.slice(2));
const SKIP_PROMPT = args.has('--yes') || args.has('-y');
const DRY_RUN = args.has('--dry-run');

/**
 * Parse the YAML-ish frontmatter block at the top of a markdown file.
 * Returns { frontmatter, body }. The frontmatter shape we support is
 * deliberately narrow — single-line key: value pairs, optionally with
 * the value wrapped in double quotes. Multiline / nested YAML isn't
 * needed for these article files (already verified by reading them).
 */
function parseMarkdown(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) {
    return { frontmatter: {}, body: text };
  }
  const fmText = m[1];
  const body = m[2];
  const fm = {};
  for (const rawLine of fmText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    // Strip surrounding quotes.
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // Coerce booleans + numbers where obvious.
    if (val === 'true') val = true;
    else if (val === 'false') val = false;
    else if (/^-?\d+$/.test(val)) val = parseInt(val, 10);
    fm[key] = val;
  }
  return { frontmatter: fm, body };
}

/**
 * Map .md frontmatter → DB row shape. The DB column names differ
 * slightly from the frontmatter keys (read_minutes vs readMinutes).
 * status: derived from `draft: true/false` field — DB uses
 * 'draft' / 'published' enum.
 */
function rowFromFile(slug, frontmatter, body) {
  const draft = !!frontmatter.draft;
  return {
    slug,
    title: String(frontmatter.title || ''),
    dek: String(frontmatter.dek || ''),
    kind: String(frontmatter.kind || 'Essay'),
    track: String(frontmatter.track || 'legal'),
    read_minutes: Number.isFinite(frontmatter.readMinutes) ? frontmatter.readMinutes : 5,
    topic: String(frontmatter.topic || 'General'),
    cover: String(frontmatter.cover || 'ph-b'),
    featured: !!frontmatter.featured,
    status: draft ? 'draft' : 'published',
    body_md: body.trim(),
    date: String(frontmatter.date || new Date().toISOString().slice(0, 10)),
  };
}

async function main() {
  console.log('[sync-articles] reading', articlesDir);
  const files = fs.readdirSync(articlesDir).filter((f) => f.endsWith('.md'));
  console.log(`[sync-articles] found ${files.length} markdown files`);

  // 1. Parse every file → row.
  const rows = [];
  for (const file of files) {
    const slug = file.replace(/\.md$/, '');
    const text = fs.readFileSync(path.join(articlesDir, file), 'utf8');
    const { frontmatter, body } = parseMarkdown(text);
    if (!frontmatter.title) {
      console.warn(`[sync-articles] ${file}: no title in frontmatter — skipping`);
      continue;
    }
    rows.push(rowFromFile(slug, frontmatter, body));
  }
  console.log(`[sync-articles] parsed ${rows.length} valid articles`);

  // 2. Fetch current slugs in the DB so we can identify deletions.
  const { data: existing, error: listErr } = await supabase
    .from('articles')
    .select('slug, id');
  if (listErr) {
    console.error('[sync-articles] failed to fetch existing slugs:', listErr.message);
    process.exit(1);
  }
  const existingSlugs = new Set((existing || []).map((r) => r.slug));
  const fileSlugs = new Set(rows.map((r) => r.slug));
  const toDelete = [...existingSlugs].filter((s) => !fileSlugs.has(s));

  console.log('[sync-articles] existing DB slugs:', [...existingSlugs].sort());
  console.log('[sync-articles] file slugs:       ', [...fileSlugs].sort());

  if (toDelete.length > 0) {
    console.log(`[sync-articles] will DELETE ${toDelete.length} rows: ${toDelete.join(', ')}`);
    if (DRY_RUN) {
      console.log('[sync-articles] --dry-run: skipping deletes');
    } else if (!SKIP_PROMPT) {
      // Lightweight prompt — read a single character from stdin.
      const answer = await new Promise((resolve) => {
        process.stdout.write('[sync-articles] proceed with deletes? [y/N]: ');
        process.stdin.setEncoding('utf8');
        process.stdin.once('data', (data) => resolve(data.trim().toLowerCase()));
      });
      if (answer !== 'y' && answer !== 'yes') {
        console.log('[sync-articles] aborted by user — no deletes performed. Upserts will still run.');
        toDelete.length = 0;
      }
    }
    if (toDelete.length > 0 && !DRY_RUN) {
      const { error: delErr } = await supabase
        .from('articles')
        .delete()
        .in('slug', toDelete);
      if (delErr) {
        console.error('[sync-articles] delete failed:', delErr.message);
        process.exit(1);
      }
      console.log(`[sync-articles] deleted ${toDelete.length} rows`);
    }
  } else {
    console.log('[sync-articles] no deletes needed');
  }

  // 3. Upsert every row.
  const upserts = [];
  const failures = [];
  for (const row of rows) {
    if (DRY_RUN) {
      console.log(`[sync-articles] --dry-run: would upsert ${row.slug} (status=${row.status}, read=${row.read_minutes}min)`);
      continue;
    }
    const { error: upErr } = await supabase
      .from('articles')
      .upsert(row, { onConflict: 'slug' });
    if (upErr) {
      console.error(`[sync-articles] upsert ${row.slug} failed: ${upErr.message}`);
      failures.push({ slug: row.slug, error: upErr.message });
      continue;
    }
    upserts.push(row.slug);
    console.log(`[sync-articles] upserted ${row.slug} (status=${row.status}, read=${row.read_minutes}min)`);
  }

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({
    upserted: upserts.length,
    deleted: DRY_RUN ? 0 : toDelete.length,
    failures: failures.length,
    failure_detail: failures,
  }, null, 2));
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error('[sync-articles] fatal:', err);
  process.exit(1);
});
