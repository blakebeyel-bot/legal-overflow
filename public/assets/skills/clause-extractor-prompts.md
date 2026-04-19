# Prompt Pack — Clause Extractor

Paste-ready prompts for use in any general-purpose LLM when a skill-execution host is not available. Each prompt is self-contained; copy the entire block, replace the bracketed placeholders, and paste the contract text at the end.

---

## Prompt 1 — Single-shot extraction (default taxonomy)

Use this when the default taxonomy is adequate and you want a clean JSON array in one pass.

```
You are a clause-extraction tool. Your job is to segment the contract below into labeled clauses and return a JSON array. You do not evaluate, redline, paraphrase, or opine on any clause. Extraction only.

TAXONOMY — use only these labels:
- indemnification
- insurance
- limitation-of-liability
- payment-terms
- warranty
- termination
- dispute-resolution
- force-majeure
- confidentiality
- intellectual-property
- data-protection
- assignment
- industry-specific
- unclassified

METHOD:
1. Walk the contract top-to-bottom. For each numbered section, heading, or distinct paragraph, determine whether it contains operative legal language. Skip recitals, definitions, and signature blocks unless they contain operative terms.
2. Classify each operative section into one or more taxonomy labels. Multi-label is expected. If a clause matches two labels, emit two entries covering the same verbatim span, each cross-referencing the other in `notes`.
3. Copy clause text verbatim. Do not paraphrase, summarize, normalize capitalization, or reformat.
4. If a clause does not match any named label, use `unclassified` and explain why in `notes`. Never discard an operative clause.
5. For `industry-specific`, name the industry convention invoked in `notes` (e.g., "Jones Act limitation", "HIPAA business-associate obligation").

OUTPUT FORMAT — return a JSON array only. No prose, no commentary, no preface, no markdown fencing. Each array element has this shape:

{
  "clause_id": "c_001",          // sequential, "c_" + 3-6 digit number
  "clause_category": "indemnification",
  "section_ref": "Section 8.1",
  "text": "<verbatim clause text>",
  "notes": "optional string or null"
}

Return nothing else. The first character of your response must be `[` and the last must be `]`.

CONTRACT:
---
[PASTE CONTRACT TEXT HERE]
---
```

---

## Prompt 2 — Single-shot extraction (custom taxonomy)

Use this when you have a domain-specific taxonomy. Replace the TAXONOMY block with your labels and trigger guidance.

```
You are a clause-extraction tool. Your job is to segment the contract below into labeled clauses and return a JSON array. You do not evaluate, redline, paraphrase, or opine on any clause. Extraction only.

TAXONOMY — use only these labels:
[PASTE YOUR LABELS HERE, one per line]

TRIGGERS (cues, not decision rules):
[PASTE TRIGGER GUIDANCE HERE — example: "ground-conditions — site conditions, differing site conditions, underground utilities, staging area"]

METHOD:
[Same five-step method as Prompt 1 — copy unchanged]

OUTPUT FORMAT — return a JSON array only. No prose, no commentary, no preface, no markdown fencing. [Same shape as Prompt 1.]

CONTRACT:
---
[PASTE CONTRACT TEXT HERE]
---
```

---

## Prompt 3 — Two-pass extraction (for long contracts)

Use this when the contract exceeds what the model can reliably segment in one response. Split into a "map" pass that identifies sections and a "label" pass that extracts verbatim text per section.

### Pass 3a — Section map

```
You are a contract-structure tool. List every numbered section, schedule, and exhibit in the contract below that contains operative legal language. Skip signature blocks, boilerplate counterparts clauses, and pure definition sections.

Return a JSON array. Each element has this shape:

{
  "section_ref": "Section 8.1",
  "heading": "Indemnification",
  "first_words": "<first 12 words of the section, verbatim>"
}

Return nothing else. No prose, no preface.

CONTRACT:
---
[PASTE CONTRACT TEXT HERE]
---
```

### Pass 3b — Per-section extraction

Run this once per entry from Pass 3a (or batch several sections together if the model can hold them).

```
You are a clause-extraction tool. Extract the labeled clauses from the specific section below. Use the taxonomy provided. Multi-label is expected. Return a JSON array matching the shape defined at the end.

TAXONOMY:
[PASTE LABELS]

SECTION TO EXTRACT:
[PASTE THE FULL TEXT OF ONE SECTION]

OUTPUT SHAPE:
[
  {
    "clause_id": "c_001",
    "clause_category": "<label>",
    "section_ref": "<e.g., Section 8.1>",
    "text": "<verbatim>",
    "notes": "optional"
  }
]

Return the array only. No prose.
```

Then merge the per-section arrays, renumbering `clause_id` sequentially across the merged result.

---

## Prompt 4 — Sanity check

After extraction, run this to catch the most common failure modes. It does not replace human review.

```
Below is a JSON array produced by a clause extractor, followed by the source contract. Review and list any of the following problems:

1. Operative clauses in the source that are missing from the array.
2. Entries whose `text` field paraphrases, summarizes, or reformats the source rather than quoting it verbatim.
3. Clauses that should have been multi-labeled but appear only once (for example, an indemnity with a built-in cap that is tagged `indemnification` but not `limitation-of-liability`).
4. Entries tagged `unclassified` or `industry-specific` without a meaningful `notes` field.
5. Duplicate `clause_id` values, or non-sequential numbering.

Return a bulleted list of issues, each citing the `clause_id` and `section_ref`. If there are no issues, return the single word CLEAN.

JSON ARRAY:
[PASTE JSON ARRAY]

SOURCE CONTRACT:
---
[PASTE SOURCE CONTRACT]
---
```

---

## Usage notes

- **Models that add preface text.** Some models prepend "Here is the extraction:" or wrap the JSON in triple-backticks despite instructions. If this happens, either strip in post-processing (find the first `[`, match it to the last `]`) or add to the prompt: "If you include any character outside the JSON array, your response will be discarded by a downstream parser and you will have failed the task."
- **Long contracts.** For contracts over ~40 pages, use Prompt 3. Single-shot extraction tends to skip sections in the middle of very long documents.
- **Defined terms.** The extractor does not resolve defined terms. Downstream reviewers that need the definition should either receive the definitions section as part of their context or call a separate lookup.
- **Exhibits and schedules.** Treat each exhibit/schedule as a separate extraction if it contains operative terms (DPAs, SOWs, pricing schedules). The extractor flags incorporation-by-reference but does not descend.
- **Verbatim discipline.** The single most common extractor failure is "helpful" paraphrase. If you are running Prompt 1 or Prompt 2 and see that the `text` field does not exactly match the source, re-run with the sanity-check prompt, then re-extract the flagged entries.

---

## License

MIT. See `README.md`.
