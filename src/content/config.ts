// Content collections were retired in favor of database-backed articles
// (migration 0013 + admin UI at /admin/articles/). The src/content/articles/
// markdown files were imported via tools/articles/import-existing.mjs and
// can be deleted from disk after verifying the public site renders the
// DB articles correctly.
//
// We keep this file (empty collections export) so Astro's content
// pipeline doesn't error if any other code still imports from
// 'astro:content'. If nothing references content collections anywhere,
// this file can be deleted along with the src/content/articles/ directory.

export const collections = {};
