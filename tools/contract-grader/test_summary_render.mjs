// Render a Review_Summary.docx from a real findings JSON so we can open
// the file in Word and verify the new styling.
import fs from 'node:fs';
import { buildReviewSummaryDocx } from '../../netlify/lib/review-summary.js';

const findingsPath = process.argv[2] || 'tools/contract-grader/runs/round4-2.json';
const outPath = process.argv[3] || 'tools/contract-grader/baseline-runs/_summary_smoke.docx';

const run = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
const findings = run.accepted_findings || run.findings || [];

const sevCounts = { blocker: 0, major: 0, moderate: 0, minor: 0 };
for (const f of findings) {
  const s = String(f.severity || '').toLowerCase();
  if (sevCounts[s] != null) sevCounts[s]++;
}

const buf = await buildReviewSummaryDocx({
  filename: 'msa_reasoning_test.docx',
  contractType: 'master_services_agreement',
  pipelineMode: 'standard',
  reviewerName: 'Blake Beyel',
  findings,
  priorityThree: findings.slice(0, 3),
  coveragePassAggregate: run.coverage_pass_aggregate || [],
  rejectedFindings: run.rejected_findings || [],
  specialistFailures: run.specialist_failures || [],
  unanchored: [],
  severityCounts: sevCounts,
  reviewedAt: new Date(),
});

fs.writeFileSync(outPath, buf);
console.log(`wrote ${outPath} · ${buf.length} bytes · ${findings.length} findings`);
