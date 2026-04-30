# Legal Overflow Auto-Grader

Replaces the manual round-by-round grading flow with a script.

## Quickstart

```bash
# 1. After running Legal Overflow on each brief, drop the marked outputs into ./inputs/
#    Rename each one to match the corpus name:
#      inputs/acme.docx
#      inputs/titan.docx
#      inputs/brief3.docx

# 2. Grade the run
python3 run_corpus.py --inputs ./inputs

# 3. (After the next iteration) Grade and check for regressions
mv grader_output last_run
python3 run_corpus.py --inputs ./inputs --prev_dir ./last_run
```

## What you get

After each run, `grader_output/` contains:

```
grader_output/
├── CORPUS_REPORT.md          ← overview table: precision/recall/regression per brief
├── CLAUDE_CODE_PROMPT.md     ← ready-to-paste prompt for Claude Code
├── acme/
│   ├── grade.json
│   ├── report.md             ← detailed per-brief grading
│   └── claude_code.md        ← per-brief Claude Code instructions
├── titan/
│   └── ...
└── brief3/
    └── ...
```

The script's exit code is **0** if all briefs pass regression check, **1** if any brief regressed. Wire that into your build pipeline if you want hard ship-gate enforcement.

## What it grades

For each comment in the marked output, the grader:

1. **Checks anchor proximity** — the comment must be anchored on or near a known seeded error in the answer key.
2. **Checks rule citation** — preferred match: the comment cites the right Bluebook rule.
3. **Checks keyword fallback** — if no rule cite, any one of the error's expected keywords must appear in the comment body.

Comments that match a seeded error → **real catches**.
Comments that don't match any seeded error → **false positives** (and flagged extra-loudly if anchored to a control citation).
Seeded errors with no matching comment → **misses**.

## Adding a new brief

1. Generate the brief and write a `<name>.json` answer key in `answer_keys/`.
2. Add the brief to the `CORPUS` list in `run_corpus.py`.
3. Drop `<name>.docx` into `inputs/` after the next tool run.

## Answer key format

```json
{
  "brief_name": "Human-readable name",
  "errors": [
    {
      "id": "unique_id",
      "description": "What the seeded error is",
      "rule": "R. 10.2.1",
      "anchor_substrings": ["text that should appear in the comment's anchor"],
      "keywords": ["v.", "period"]
    }
  ],
  "controls": [
    {
      "id": "unique_id",
      "anchor_substrings": ["text from the citation"],
      "note": "Why this is a control"
    }
  ]
}
```

## Tuning the matcher

If a real catch is being scored as a false positive (or vice versa), the issue is usually in the answer key:

- **Anchor too narrow** — broaden `anchor_substrings` to include text that actually appears in the comment range.
- **Keywords too narrow** — add more synonyms or related terms to `keywords`.
- **Rule cite differs** — comments may cite "R. 10.2.1" or "R 10.2.1" or "Rule 10.2.1"; the matcher normalizes whitespace but not the prefix. Add the variant to `keywords`.

The matcher is intentionally lenient on keywords and strict on anchors — anchors are the strongest signal that a comment is actually about the seeded error.

## Documented limitations (parked)

The corpus represents 100% effective Bluebook 22e coverage for litigation use. Two parked items remain documented limitations of the underlying extractor architecture:

### Brief 5 — `ginsburg_article_italics` (R. 16.4)

R. 16.4 requires italicized article titles. Detection requires inspection of run-level italic formatting in `word/document.xml` rather than the plain-text body that mammoth currently exposes. Implementing this would require:

1. A separate XML parser for `word/document.xml` that maps each character offset to its run's `<w:rPr><w:i/></w:rPr>` state.
2. Coupling the article extractor to that offset-italic map so the title-region's italicization can be checked.

The complexity isn't justified for a single seeded error type. If a future brief seeds multiple italics-dependent catches, this becomes worth implementing.

### Brief 5 — `reyes_missing_note_designation` (R. 16.6.1)

R. 16.6.1 requires student-authored articles to be designated with "Note," / "Comment," between the author name and the title. Detection requires distinguishing student authors from faculty authors — information not present in the citation text. The Bluebook itself doesn't provide a deterministic signal; only authorial metadata (e.g., a "J.D. Candidate" affiliation note) would let the tool know. Without that metadata, we'd produce too many false positives on faculty articles to justify firing.

### Both items
Documented as known limitations; revisit only when (a) brief content explicitly seeds the relevant errors with sufficient detection signal, or (b) authorship-metadata becomes available through a separate annotation channel.
