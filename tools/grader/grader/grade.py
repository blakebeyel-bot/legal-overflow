#!/usr/bin/env python3
"""
Legal Overflow auto-grader.

Usage:
  grade.py --marked path/to/marked-source.docx --key path/to/answer_key.json
  grade.py --regression  (runs all briefs in test_corpus/, compares to last_run/)

Reads marked-source-X.docx files, extracts comments and anchors, grades
against a JSON answer key, and emits a structured report with:
  - real catches (matched a seeded error)
  - false positives (comment with no matching seeded error)
  - misses (seeded errors with no matching comment)
  - regressions (catches that worked in a prior build but don't now)

Outputs:
  - report.md          human-readable grading
  - report.json        machine-readable grading
  - claude_code.md     ready-to-paste instructions for Claude Code
"""

import argparse
import json
import os
import re
import sys
import zipfile
from datetime import datetime
from pathlib import Path
from xml.etree import ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}


# --------------------------------------------------------------------
# Comment extraction
# --------------------------------------------------------------------

def extract_comments(docx_path):
    """Return a list of {id, body, anchor} dicts from a marked .docx."""
    with zipfile.ZipFile(docx_path) as z:
        try:
            comments_xml = z.read("word/comments.xml")
        except KeyError:
            return []
        document_xml = z.read("word/document.xml")

    # Comment bodies
    croot = ET.fromstring(comments_xml)
    bodies = {}
    for c in croot.findall("w:comment", NS):
        cid = c.get(f"{W}id")
        text = "".join((t.text or "") for t in c.findall(".//w:t", NS))
        bodies[cid] = text.strip()

    # Anchors via commentRangeStart / commentRangeEnd
    droot = ET.fromstring(document_xml)
    open_ranges = {}
    anchors = {}

    def walk(elem):
        for child in elem:
            tag = child.tag
            if tag == f"{W}commentRangeStart":
                open_ranges[child.get(f"{W}id")] = []
            elif tag == f"{W}commentRangeEnd":
                cid = child.get(f"{W}id")
                if cid in open_ranges:
                    anchors[cid] = "".join(open_ranges[cid])
                    del open_ranges[cid]
            elif tag in (f"{W}t", f"{W}delText"):
                txt = child.text or ""
                for k in open_ranges:
                    open_ranges[k].append(txt)
            else:
                walk(child)

    walk(droot)

    out = []
    for cid in sorted(bodies.keys(), key=lambda x: int(x)):
        out.append({
            "id": cid,
            "body": bodies[cid],
            "anchor": anchors.get(cid, ""),
        })
    return out


# --------------------------------------------------------------------
# Grading
# --------------------------------------------------------------------

def normalize(s):
    """Lowercase, strip punctuation noise, collapse whitespace."""
    s = s.lower()
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def comment_matches_error(comment, error):
    """
    Decide whether a comment fires on a given seeded error.

    Match rules (any of):
      - error.anchor_substring appears in comment.anchor (case-insensitive)
      - error.rule appears in comment.body
      - error.keyword(s) appear in comment.body
    Required: the comment is anchored to a substring near the error location.
    """
    anchor = normalize(comment["anchor"])
    body = normalize(comment["body"])

    # Anchor proximity check - the comment must be anchored on or near the error
    anchor_match = False
    for sub in error.get("anchor_substrings", []):
        if normalize(sub) in anchor:
            anchor_match = True
            break

    if not anchor_match:
        return False

    # Rule citation match (preferred signal)
    rule = error.get("rule", "")
    if rule and rule.lower().replace(" ", "") in body.replace(" ", ""):
        return True

    # Keyword fallback - any one keyword from the error must appear
    for kw in error.get("keywords", []):
        if kw.lower() in body:
            return True

    return False


def grade(comments, answer_key):
    """
    Return dict with: real_catches, false_positives, misses, summary.
    """
    errors = answer_key["errors"]
    controls = answer_key.get("controls", [])

    matched_error_ids = set()
    matched_comment_ids = set()
    real_catches = []  # list of (comment, error)

    # Two-pass matching:
    # Pass 1: For each error, find the BEST matching unmatched comment (rule cite > keyword).
    # Pass 2: Sweep up any unmatched comments; if a comment matches an already-claimed
    #         error, it's a duplicate (count as a real catch but don't claim a new error).
    def comment_score(comment, error):
        """Higher = better match. 0 = no match."""
        if not comment_matches_error(comment, error):
            return 0
        body = normalize(comment["body"])
        rule = error.get("rule", "").lower().replace(" ", "")
        if rule and rule in body.replace(" ", ""):
            return 2  # rule cite present
        return 1  # keyword match only

    # Pass 1: greedy best-match per error
    for error in errors:
        best_comment = None
        best_score = 0
        for comment in comments:
            if comment["id"] in matched_comment_ids:
                continue
            s = comment_score(comment, error)
            if s > best_score:
                best_score = s
                best_comment = comment
        if best_comment is not None:
            real_catches.append({
                "comment_id": best_comment["id"],
                "error_id": error["id"],
                "error_description": error["description"],
                "comment_body": best_comment["body"][:200],
            })
            matched_error_ids.add(error["id"])
            matched_comment_ids.add(best_comment["id"])

    # Pass 2: any remaining unmatched comments — see if they match any error
    # (counting as duplicate-but-real-catch, which we still credit but flag)
    for comment in comments:
        if comment["id"] in matched_comment_ids:
            continue
        for error in errors:
            if comment_matches_error(comment, error):
                real_catches.append({
                    "comment_id": comment["id"],
                    "error_id": error["id"],
                    "error_description": error["description"] + " [duplicate]",
                    "comment_body": comment["body"][:200],
                })
                matched_comment_ids.add(comment["id"])
                break

    # Misses: errors not matched by any comment
    misses = [
        {"error_id": e["id"], "description": e["description"], "rule": e.get("rule", "")}
        for e in errors
        if e["id"] not in matched_error_ids
    ]

    # False positives: comments not matched to any error
    false_positives = []
    for comment in comments:
        if comment["id"] in matched_comment_ids:
            continue
        # Check whether comment is anchored to a control citation
        is_on_control = any(
            normalize(sub) in normalize(comment["anchor"])
            for ctrl in controls
            for sub in ctrl.get("anchor_substrings", [])
        )
        false_positives.append({
            "comment_id": comment["id"],
            "anchor": comment["anchor"][:80],
            "body": comment["body"][:200],
            "on_control": is_on_control,
        })

    total_errors = len(errors)
    total_comments = len(comments)
    distinct_errors_caught = len(matched_error_ids)
    real_count = len(real_catches)
    duplicate_count = real_count - distinct_errors_caught
    fp_count = len(false_positives)
    miss_count = len(misses)

    precision = (distinct_errors_caught + 0) / total_comments if total_comments else 1.0
    # Note: precision counts distinct catches; duplicates are not credited toward
    # precision but are surfaced separately in the report.
    recall = distinct_errors_caught / total_errors if total_errors else 1.0

    return {
        "brief": answer_key.get("brief_name", "?"),
        "totals": {
            "comments": total_comments,
            "real_catches": distinct_errors_caught,
            "duplicates": duplicate_count,
            "false_positives": fp_count,
            "misses": miss_count,
            "seeded_errors": total_errors,
            "controls": len(controls),
        },
        "precision": round(precision, 3),
        "recall": round(recall, 3),
        "real_catches": real_catches,
        "false_positives": false_positives,
        "misses": misses,
    }


# --------------------------------------------------------------------
# Regression detection
# --------------------------------------------------------------------

def detect_regressions(current, previous):
    """
    Compare current grading result vs. previous to find:
      - dropped catches (in previous, not in current)
      - new catches (in current, not in previous)
      - new false positives
      - resolved false positives
    """
    prev_caught_ids = {c["error_id"] for c in previous["real_catches"]}
    curr_caught_ids = {c["error_id"] for c in current["real_catches"]}

    dropped = sorted(prev_caught_ids - curr_caught_ids)
    new_catches = sorted(curr_caught_ids - prev_caught_ids)

    prev_fp_anchors = {fp["anchor"] for fp in previous["false_positives"]}
    curr_fp_anchors = {fp["anchor"] for fp in current["false_positives"]}

    new_fps = sorted(curr_fp_anchors - prev_fp_anchors)
    resolved_fps = sorted(prev_fp_anchors - curr_fp_anchors)

    return {
        "dropped_catches": dropped,
        "new_catches": new_catches,
        "new_false_positives": new_fps,
        "resolved_false_positives": resolved_fps,
        "is_regression": len(dropped) > 0,
    }


# --------------------------------------------------------------------
# Reporting
# --------------------------------------------------------------------

def render_report(grade_result, regression=None):
    g = grade_result
    t = g["totals"]
    lines = []
    lines.append(f"# Grading report — {g['brief']}")
    lines.append(f"_Generated {datetime.now().isoformat(timespec='seconds')}_")
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append(f"- Total comments emitted: **{t['comments']}**")
    lines.append(f"- Real catches: **{t['real_catches']} / {t['seeded_errors']}**")
    lines.append(f"- False positives: **{t['false_positives']}**")
    lines.append(f"- Misses: **{t['misses']}**")
    lines.append(f"- Precision: **{g['precision']:.0%}**")
    lines.append(f"- Recall: **{g['recall']:.0%}**")

    if regression:
        lines.append("")
        lines.append("## Regression vs. previous run")
        lines.append("")
        if regression["is_regression"]:
            lines.append(f"- ❌ **REGRESSION** — {len(regression['dropped_catches'])} catch(es) dropped")
            for eid in regression["dropped_catches"]:
                lines.append(f"  - Lost: error `{eid}`")
        else:
            lines.append("- ✅ No regressions vs previous run")
        if regression["new_catches"]:
            lines.append(f"- ➕ New catches gained: {regression['new_catches']}")
        if regression["resolved_false_positives"]:
            lines.append(f"- ✅ False positives resolved: {len(regression['resolved_false_positives'])}")
        if regression["new_false_positives"]:
            lines.append(f"- ⚠️  New false positives: {len(regression['new_false_positives'])}")

    if g["misses"]:
        lines.append("")
        lines.append("## Misses (seeded errors NOT caught)")
        lines.append("")
        for m in g["misses"]:
            lines.append(f"- **{m['error_id']}** ({m['rule']}): {m['description']}")

    if g["false_positives"]:
        lines.append("")
        lines.append("## False positives")
        lines.append("")
        for fp in g["false_positives"]:
            tag = " (on control)" if fp["on_control"] else ""
            lines.append(f"- Comment #{fp['comment_id']}{tag}")
            lines.append(f"  - Anchor: `{fp['anchor']}`")
            lines.append(f"  - Body: {fp['body']}")

    lines.append("")
    lines.append("## Real catches")
    lines.append("")
    for rc in g["real_catches"]:
        lines.append(f"- ✓ Comment #{rc['comment_id']} caught **{rc['error_id']}** ({rc['error_description']})")

    return "\n".join(lines)


def render_claude_code_prompt(grade_result, regression=None):
    """
    Generate a ready-to-paste prompt for Claude Code based on this run's
    diagnostics. This is the part that automates what I've been writing
    by hand each round.
    """
    g = grade_result
    t = g["totals"]
    lines = []
    lines.append(f"# Round results: {g['brief']}")
    lines.append("")
    lines.append(f"- Precision: {g['precision']:.0%}  ·  Recall: {g['recall']:.0%}")
    lines.append(f"- Real catches: {t['real_catches']}/{t['seeded_errors']}")
    lines.append(f"- False positives: {t['false_positives']}")
    lines.append(f"- Misses: {t['misses']}")
    lines.append("")

    has_regression = regression and regression["is_regression"]
    has_misses = bool(g["misses"])
    has_fps = bool(g["false_positives"])

    if has_regression:
        lines.append("## ❌ Regression — fix this first")
        lines.append("")
        lines.append("The following catches worked in the previous build and are not firing now. Restore them before any other work:")
        lines.append("")
        for eid in regression["dropped_catches"]:
            lines.append(f"- `{eid}`")
        lines.append("")
        lines.append("Likely causes (in order of historical frequency):")
        lines.append("1. Citation extractor changed and is dropping the citation entirely — instrument extraction and verify the citation appears in extraction logs")
        lines.append("2. Validator removed or its trigger condition tightened — check the validator file")
        lines.append("3. Comment-merge filter is suppressing the catch — check Pipeline A → final merge")
        lines.append("")

    if has_misses and not has_regression:
        lines.append("## Missing catches — add these rules")
        lines.append("")
        for m in g["misses"]:
            lines.append(f"- **{m['error_id']}** — {m['description']} (rule: {m['rule'] or 'see answer key'})")
        lines.append("")

    if has_fps:
        lines.append("## False positives — fix these")
        lines.append("")
        for fp in g["false_positives"]:
            tag = " ON A CONTROL CITATION" if fp["on_control"] else ""
            lines.append(f"- Comment #{fp['comment_id']}{tag}: `{fp['anchor']}`")
            lines.append(f"  - Body: {fp['body'][:160]}")
        lines.append("")
        lines.append("For each false positive, identify which validator or pipeline stage emitted it and tighten the trigger condition.")
        lines.append("")

    lines.append("## Required regression check before shipping")
    lines.append("")
    lines.append("After making the changes above, run the tool against ALL test briefs (Acme, Titan, Brief 3, plus any others in the corpus) and confirm:")
    lines.append("")
    lines.append("1. No prior catch on any prior brief regressed")
    lines.append("2. Precision did not decrease on any prior brief")
    lines.append("3. The auto-grader passes on every brief in the corpus")
    lines.append("")
    lines.append("If any prior brief shows regression, do not ship the build — fix the regression first.")

    return "\n".join(lines)


# --------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--marked", required=True, help="Path to marked .docx output from Legal Overflow")
    ap.add_argument("--key", required=True, help="Path to answer key JSON")
    ap.add_argument("--prev", default=None, help="Optional path to previous run's grade JSON for regression check")
    ap.add_argument("--out", default="grader_output", help="Output directory")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)

    comments = extract_comments(args.marked)
    with open(args.key) as f:
        answer_key = json.load(f)

    result = grade(comments, answer_key)

    regression = None
    if args.prev and os.path.exists(args.prev):
        with open(args.prev) as f:
            prev = json.load(f)
        regression = detect_regressions(result, prev)

    # Write outputs
    json_path = os.path.join(args.out, "grade.json")
    with open(json_path, "w") as f:
        json.dump(result, f, indent=2)

    md_path = os.path.join(args.out, "report.md")
    with open(md_path, "w") as f:
        f.write(render_report(result, regression))

    cc_path = os.path.join(args.out, "claude_code.md")
    with open(cc_path, "w") as f:
        f.write(render_claude_code_prompt(result, regression))

    # Console summary
    t = result["totals"]
    print(f"\n=== {result['brief']} ===")
    print(f"Comments: {t['comments']}  ·  Real: {t['real_catches']}/{t['seeded_errors']}  ·  FP: {t['false_positives']}  ·  Miss: {t['misses']}")
    print(f"Precision: {result['precision']:.0%}  ·  Recall: {result['recall']:.0%}")
    if regression:
        if regression["is_regression"]:
            print(f"❌ REGRESSION: {len(regression['dropped_catches'])} catch(es) dropped")
        else:
            print(f"✅ No regressions")
    print(f"\nWrote: {json_path}")
    print(f"Wrote: {md_path}")
    print(f"Wrote: {cc_path}")


if __name__ == "__main__":
    main()
