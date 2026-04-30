#!/usr/bin/env python3
"""
Run grader against all briefs in the corpus and emit a combined report.

Usage:
  run_corpus.py --inputs path/to/dir/with/marked-source-files
  run_corpus.py --inputs ./inputs --prev_dir ./last_run

Expects:
  inputs/
    acme.docx          (the marked-source for Acme)
    titan.docx         (the marked-source for Titan)
    brief3.docx        (the marked-source for Brief 3)
  answer_keys/
    acme.json
    titan.json
    brief3.json

Emits:
  ./grader_output/<brief>/grade.json
  ./grader_output/<brief>/report.md
  ./grader_output/<brief>/claude_code.md
  ./grader_output/CORPUS_REPORT.md      (combined view + ship/no-ship verdict)
  ./grader_output/CLAUDE_CODE_PROMPT.md (combined Claude Code instructions)
"""

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

# Import grade.py from same directory
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from grade import (
    extract_comments,
    grade,
    detect_regressions,
    render_report,
    render_claude_code_prompt,
)


CORPUS = [
    {"name": "acme", "label": "Acme Logistics v. Coastal Freight"},
    {"name": "titan", "label": "Titan Aerospace v. Northwind Defense"},
    {"name": "brief3", "label": "Meridian Biotech v. Crestwood Pharma"},
    {"name": "brief4", "label": "Harbor Energy v. Cascade Grid"},
    {"name": "brief5", "label": "Westbrook Publishing v. Atlas Digital Media"},
    {"name": "brief6", "label": "Halverson Pharmaceuticals v. FTC"},
    {"name": "brief7", "label": "Arrowhead Capital v. Vanguard Investment Trust"},
    {"name": "brief8", "label": "Okonkwo v. Horizon Global Industries"},
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--inputs", required=True,
                    help="Directory containing acme.docx, titan.docx, brief3.docx")
    ap.add_argument("--keys", default="answer_keys",
                    help="Directory of answer key JSON files")
    ap.add_argument("--prev_dir", default=None,
                    help="Previous corpus run directory (for regression check)")
    ap.add_argument("--out", default="grader_output", help="Output directory")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    results = {}

    for brief in CORPUS:
        name = brief["name"]
        docx_path = os.path.join(args.inputs, f"{name}.docx")
        key_path = os.path.join(args.keys, f"{name}.json")

        if not os.path.exists(docx_path):
            print(f"⚠️  {name}: marked file not found at {docx_path} — skipping")
            continue
        if not os.path.exists(key_path):
            print(f"⚠️  {name}: answer key not found at {key_path} — skipping")
            continue

        # Grade
        comments = extract_comments(docx_path)
        with open(key_path) as f:
            key = json.load(f)
        result = grade(comments, key)

        # Regression check
        regression = None
        if args.prev_dir:
            prev_path = os.path.join(args.prev_dir, name, "grade.json")
            if os.path.exists(prev_path):
                with open(prev_path) as f:
                    prev = json.load(f)
                regression = detect_regressions(result, prev)

        # Write per-brief outputs
        brief_out = os.path.join(args.out, name)
        os.makedirs(brief_out, exist_ok=True)
        with open(os.path.join(brief_out, "grade.json"), "w") as f:
            json.dump(result, f, indent=2)
        with open(os.path.join(brief_out, "report.md"), "w") as f:
            f.write(render_report(result, regression))
        with open(os.path.join(brief_out, "claude_code.md"), "w") as f:
            f.write(render_claude_code_prompt(result, regression))

        results[name] = {"result": result, "regression": regression, "label": brief["label"]}

        # Console summary
        t = result["totals"]
        print(f"\n=== {brief['label']} ===")
        print(f"Comments: {t['comments']}  ·  Real: {t['real_catches']}/{t['seeded_errors']}  ·  FP: {t['false_positives']}  ·  Miss: {t['misses']}")
        print(f"Precision: {result['precision']:.0%}  ·  Recall: {result['recall']:.0%}")
        if regression:
            if regression["is_regression"]:
                print(f"❌ REGRESSION: {len(regression['dropped_catches'])} catch(es) dropped")
            else:
                print(f"✅ No regressions vs previous run")

    # Combined corpus report
    write_corpus_report(results, args.out)
    write_combined_claude_code(results, args.out)

    # Ship/no-ship verdict
    any_regression = any(r["regression"] and r["regression"]["is_regression"] for r in results.values())
    if any_regression:
        print(f"\n❌ BUILD NOT READY — at least one brief regressed.")
        sys.exit(1)
    else:
        print(f"\n✅ Build passes regression check across {len(results)} brief(s).")
        sys.exit(0)


def write_corpus_report(results, out_dir):
    lines = [f"# Corpus grading — {datetime.now().isoformat(timespec='seconds')}", ""]
    lines.append("| Brief | Comments | Real / Seeded | FP | Miss | Precision | Recall | Regression |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for name, info in results.items():
        r = info["result"]
        t = r["totals"]
        reg = info["regression"]
        if reg is None:
            reg_cell = "—"
        elif reg["is_regression"]:
            reg_cell = f"❌ {len(reg['dropped_catches'])} dropped"
        else:
            reg_cell = "✅ none"
        lines.append(
            f"| {info['label']} | {t['comments']} | {t['real_catches']}/{t['seeded_errors']} | "
            f"{t['false_positives']} | {t['misses']} | {r['precision']:.0%} | {r['recall']:.0%} | {reg_cell} |"
        )
    lines.append("")
    lines.append("## Per-brief details")
    lines.append("")
    for name, info in results.items():
        lines.append(f"- **{info['label']}** → see `{name}/report.md`")
    with open(os.path.join(out_dir, "CORPUS_REPORT.md"), "w") as f:
        f.write("\n".join(lines))


def write_combined_claude_code(results, out_dir):
    lines = ["# Round results across the full corpus", ""]
    any_regression = False

    for name, info in results.items():
        r = info["result"]
        t = r["totals"]
        reg = info["regression"]
        lines.append(f"## {info['label']}")
        lines.append("")
        lines.append(f"- Precision: {r['precision']:.0%}  ·  Recall: {r['recall']:.0%}")
        lines.append(f"- Real catches: {t['real_catches']}/{t['seeded_errors']}  ·  FP: {t['false_positives']}  ·  Miss: {t['misses']}")
        if reg and reg["is_regression"]:
            any_regression = True
            lines.append(f"- ❌ **REGRESSION** — dropped: {reg['dropped_catches']}")
        elif reg:
            lines.append(f"- ✅ No regressions")
        if r["misses"]:
            lines.append("")
            lines.append("**Missed catches:**")
            for m in r["misses"]:
                lines.append(f"- `{m['error_id']}` ({m['rule']}): {m['description']}")
        if r["false_positives"]:
            lines.append("")
            lines.append("**False positives:**")
            for fp in r["false_positives"]:
                tag = " (on control citation)" if fp["on_control"] else ""
                lines.append(f"- Comment #{fp['comment_id']}{tag}: anchor `{fp['anchor']}`")
        lines.append("")

    lines.append("## Required actions")
    lines.append("")
    if any_regression:
        lines.append("1. **Fix all regressions first.** A build that drops a prior catch does not ship. Restore each dropped catch before adding new functionality.")
    else:
        lines.append("1. No regressions to fix this round.")
    lines.append("2. Add missing rules per the per-brief miss list above.")
    lines.append("3. Tighten triggers to eliminate false positives, especially any flagged on control citations.")
    lines.append("4. Run the auto-grader against all briefs after changes. Do not ship the build unless every brief in the corpus shows: zero regressions, zero false positives on controls, and recall ≥ previous build.")

    with open(os.path.join(out_dir, "CLAUDE_CODE_PROMPT.md"), "w") as f:
        f.write("\n".join(lines))


if __name__ == "__main__":
    main()
