/**
 * Citation Verifier — composable static fixes.
 *
 * The user's complaint: "Comment 15 catches 'vs.' → 'v.' but its own
 * suggested fix retains the wrong 'S.D. Fl.' That's a bug — the tool's
 * suggested fix is propagating an error."
 *
 * Root cause: each validator emitted an independent suggested_fix that
 * fixed ONLY its own detected issue, leaving other errors in the same
 * citation untouched. The markup pipeline then surfaced ONE of those
 * partial fixes as the "Suggested fix" comment, which still contained
 * other errors.
 *
 * Fix: every validator's suggested_fix runs the candidate_text through
 * applyStaticFixes() so the final string has ALL known static
 * substitutions applied. Multiple flags can fire on the same citation —
 * the user sees each error called out individually — but every
 * suggested_fix is identical and fully-corrected.
 *
 * KEEP THIS FUNCTION DETERMINISTIC. If a substitution depends on
 * citation components (e.g., Marbury's nominative reporter), do it in
 * the validator's own logic on top of applyStaticFixes — not here.
 */

export function applyStaticFixes(text) {
  if (!text || typeof text !== 'string') return text;
  let out = text;

  // ---- "vs." / "vs " → "v."  (R. 10.2.1) ----
  out = out.replace(/\bvs\.?(\s+[A-Z])/g, 'v.$1');

  // ---- "<Cap-word> v <Cap-word>" → ...v. (missing period after v) ----
  // Only when followed directly by another capitalized party name.
  out = out.replace(/\b([A-Z][\w']*)\s+v(?!\.)(\s+[A-Z])/g, '$1 v.$2');

  // ---- "US" → "U.S." in reporter slot (digit-space-US-space-digit) ----
  out = out.replace(/\b(\d{1,4}\s+)US(\s+\d)/g, '$1U.S.$2');

  // ---- "USC" / "CFR" → canonical with periods AND insert § if absent ----
  // Order matters — do USC/CFR before "§ insertion" so we add periods first.
  out = out.replace(/\b(\d{1,3}\s+)USC\s+(\d)/g, '$1U.S.C. § $2');
  out = out.replace(/\b(\d{1,3}\s+)CFR\s+(\d)/g, '$1C.F.R. § $2');
  out = out.replace(/\b(\d{1,3}\s+)USC\b/g, '$1U.S.C.');
  out = out.replace(/\b(\d{1,3}\s+)CFR\b/g, '$1C.F.R.');

  // ---- Insert "§" after U.S.C. or C.F.R. when section number follows ----
  out = out.replace(/(\bU\.S\.C\.)\s+(\d)/g, '$1 § $2');
  out = out.replace(/(\bC\.F\.R\.)\s+(\d)/g, '$1 § $2');

  // ---- Section symbol spacing: "§351" → "§ 351"  (R. 6.2) ----
  out = out.replace(/§(\d)/g, '§ $1');

  // ---- Reporter spacing: "So.3d" → "So. 3d"  (R. 6.1) ----
  out = out.replace(/\bSo\.(\d)d\b/g, 'So. $1d');

  // ---- Stray comma before year in court parenthetical ----
  out = out.replace(/\(([A-Z][A-Za-z\.\s\d]+),\s*(\d{4})\)/g, '($1 $2)');

  // ---- T10 misuses (only when not part of a larger word) ----
  out = out.replace(/\bCalif\.(?![A-Za-z])/g, 'Cal.');
  out = out.replace(/\bPenn\.(?![A-Za-z])/g, 'Pa.');
  out = out.replace(/\bPenna\.(?![A-Za-z])/g, 'Pa.');
  out = out.replace(/\bFl\.(?![A-Za-z])/g, 'Fla.');
  out = out.replace(/\bWisc\.(?![A-Za-z])/g, 'Wis.');

  // ---- Federal Rules shorthand → canonical ----
  out = out.replace(/\bFRCP\b/g, 'Fed. R. Civ. P.');
  out = out.replace(/\bFRCrP\b/g, 'Fed. R. Crim. P.');
  out = out.replace(/\bFRAP\b/g, 'Fed. R. App. P.');
  out = out.replace(/\bFRE\b/g, 'Fed. R. Evid.');
  out = out.replace(/\bF\.R\.Civ\.P\.\b/g, 'Fed. R. Civ. P.');
  out = out.replace(/\bF\.R\.Cr\.P\.\b/g, 'Fed. R. Crim. P.');

  // ---- Restatement series form: "Restatement 2d Foo" → "Restatement (Second) of Foo" ----
  const SERIES = { '2d': 'Second', '3d': 'Third', '4th': 'Fourth' };
  for (const [bad, good] of Object.entries(SERIES)) {
    out = out.replace(
      new RegExp(`\\bRestatement\\s+${bad}\\s+(?!of\\b)([A-Z][A-Za-z\\s]+)`, 'g'),
      `Restatement (${good}) of $1`
    );
  }

  return out;
}
