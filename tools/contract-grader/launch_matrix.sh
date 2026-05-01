#!/bin/bash
# Launch the remaining Round 1 scenarios in parallel.
# run-01 already completed (smoke test).

set -e
cd "$(dirname "$0")/../.."

CONTRACT_DOCX="tools/contract-grader/test_contracts/msa_reasoning_test.docx"
CONTRACT_PDF="tools/contract-grader/test_contracts/msa_reasoning_test.pdf"
PROFILE_BUYER="tools/contract-grader/test_profiles/profile_buyer_positions.json"
PROFILE_EMPTY="tools/contract-grader/test_profiles/profile_empty.json"
PLAYBOOK="playbook:tools/contract-grader/test_profiles/playbook_buyer_positions.docx"

run() {
  local label="$1"
  local contract="$2"
  local profile="$3"
  local posture="$4"
  local logfile="tools/contract-grader/runs/${label}.log"
  echo "[launch] $label ($contract / $profile / $posture)"
  node tools/contract-grader/harness.mjs "$label" "$contract" "$profile" "$posture" \
    > "$logfile" 2>&1 &
  echo $! > "tools/contract-grader/runs/${label}.pid"
}

# Profile_buyer × 3 remaining postures (run-01 = our_paper, already done)
run "run-02" "$CONTRACT_DOCX" "$PROFILE_BUYER" "their_paper_high_leverage"
run "run-03" "$CONTRACT_DOCX" "$PROFILE_BUYER" "their_paper_low_leverage"
run "run-04" "$CONTRACT_DOCX" "$PROFILE_BUYER" "negotiated_draft"

# Profile_empty × 4 postures
run "run-05" "$CONTRACT_DOCX" "$PROFILE_EMPTY" "our_paper"
run "run-06" "$CONTRACT_DOCX" "$PROFILE_EMPTY" "their_paper_high_leverage"
run "run-07" "$CONTRACT_DOCX" "$PROFILE_EMPTY" "their_paper_low_leverage"
run "run-08" "$CONTRACT_DOCX" "$PROFILE_EMPTY" "negotiated_draft"

# Playbook (prose → profile via configurator) × 4 postures
run "run-09" "$CONTRACT_DOCX" "$PLAYBOOK" "our_paper"
run "run-10" "$CONTRACT_DOCX" "$PLAYBOOK" "their_paper_high_leverage"
run "run-11" "$CONTRACT_DOCX" "$PLAYBOOK" "their_paper_low_leverage"
run "run-12" "$CONTRACT_DOCX" "$PLAYBOOK" "negotiated_draft"

# PDF parity: rerun runs 2 and 6 with PDF input
run "run-02-pdf" "$CONTRACT_PDF" "$PROFILE_BUYER" "their_paper_high_leverage"
run "run-06-pdf" "$CONTRACT_PDF" "$PROFILE_EMPTY" "their_paper_high_leverage"

echo "[launch] all 13 scenarios launched in background"
echo "[launch] watch progress: tail -f tools/contract-grader/runs/*.log"
