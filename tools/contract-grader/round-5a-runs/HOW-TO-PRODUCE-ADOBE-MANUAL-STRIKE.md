# How to produce `adobe-manual-strike.pdf` for QuadPoints comparison

If `synthetic-delete-marked-v3.pdf` still doesn't render the strikethrough through the middle of the text, we need ground-truth QuadPoints from Adobe's own Strikethrough tool to match exactly.

## Steps

1. Open `tools/contract-grader/test_contracts/msa_reasoning_test.pdf` in Adobe Acrobat (the SOURCE PDF, no annotations yet).
2. From the Acrobat menu: **Tools → Comment** (or click the Comment icon in the right sidebar).
3. Select the **Strikethrough Text** tool (looks like an "S" with a line through it; keyboard shortcut is `Shift+Ctrl+K` on some Acrobat builds).
4. Find a small chunk of text — anything single-line on page 1 works. Suggested target: the phrase **"Lattice Telemetry, Inc."** at the top of page 1, or any short phrase from the test contract.
5. Drag-select the phrase to apply the strikethrough.
6. **File → Save As** and save the result to `tools/contract-grader/round-5a-runs/adobe-manual-strike.pdf`. (Overwrite if it exists.)
7. Tell me when it's saved.

## What I'll do with it

I'll run:

```
node tools/contract-grader/round-5a-runs/compare-quadpoints.mjs \
  tools/contract-grader/round-5a-runs/adobe-manual-strike.pdf
```

That dumps the QuadPoints Adobe wrote — the four (x, y) corner pairs for each strikethrough — plus the derived height, width, and midpoint percentage. I'll compare those numbers to what `addStrikeOutAnnotation()` is currently writing for the same text run, identify the geometric delta, and adjust our code to match Adobe exactly.

## Font Capture popup workaround

If the Font Capture / `0xc06d007e` popup blocks Acrobat from working with `msa_reasoning_test.pdf`, you can also strike text in any other PDF (e.g. a real contract you have on disk that Acrobat opens cleanly), save it as `adobe-manual-strike.pdf`, and it will work for the QuadPoints comparison — we don't need it to be on the test contract. The comparison just needs Adobe's geometry on ANY text it can see clearly.
