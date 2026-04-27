"""
Mata Tracker — weekly maintenance runner.

One command that orchestrates the full pipeline so new cases and issues
get picked up and annotated automatically. Drafts land in the database;
you publish them when you've reviewed them.

Pipeline (in order):
  1. discover_new_cases.py        Find new sanction orders on CourtListener.
  2. fetch_recap.py --all         RECAP/IA backfill for any federal cases
                                  still missing opinion text (catches the
                                  long tail and any fresh discoveries).
  3. annotate.py --all            Run Claude annotations on every case with
                                  opinion text and no annotation yet (status
                                  = 'opinion_fetched').
  4. missing_report.py            Print what's still uncovered.

Usage:
  python scripts/mata/weekly_run.py                # full pipeline
  python scripts/mata/weekly_run.py --no-annotate  # discover + fetch only
  python scripts/mata/weekly_run.py --lookback 60  # search last 60 days
  python scripts/mata/weekly_run.py --skip-discover # skip step 1, do steps 2-4
  python scripts/mata/weekly_run.py --dry          # preview, don't write

Env required (loaded from site/.env):
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  COURTLISTENER_TOKEN
  ANTHROPIC_API_KEY  (only needed if annotation runs)

After it finishes:
  - New annotations are saved as status='draft'
  - Review them in Supabase Studio (annotations table)
  - Publish with:
      update annotations set status='published',
                             reviewed_by='blake',
                             reviewed_at=now()
       where status='draft';
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
except Exception:
    pass

ROOT = Path(__file__).resolve().parents[2]      # ...\site
SCRIPTS = Path(__file__).resolve().parent       # ...\site\scripts\mata


def banner(title: str) -> None:
    line = "=" * 72
    print(f"\n{line}\n  {title}\n{line}\n", flush=True)


def run_step(label: str, cmd: list[str], log_path: Path) -> int:
    banner(label)
    print(f"  cmd:  {' '.join(cmd)}")
    print(f"  log:  {log_path}\n", flush=True)
    start = time.time()
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    with log_path.open("w", encoding="utf-8") as fh:
        proc = subprocess.run(
            cmd,
            cwd=str(ROOT),
            stdout=fh,
            stderr=subprocess.STDOUT,
            env=env,
            text=True,
        )
    dur = time.time() - start
    print(f"  finished in {dur:.0f}s  (exit code {proc.returncode})", flush=True)
    return proc.returncode


def tail(log_path: Path, n: int = 30) -> None:
    if not log_path.exists():
        return
    lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
    print("  --- last lines of log ---")
    for line in lines[-n:]:
        print(f"  {line}")
    print()


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--no-annotate", action="store_true",
                   help="skip the annotation step (steps 1 + 2 + report only)")
    p.add_argument("--skip-discover", action="store_true",
                   help="skip discovery (steps 2 + 3 + report only)")
    p.add_argument("--skip-recap", action="store_true",
                   help="skip the RECAP/IA backfill")
    p.add_argument("--lookback", type=int, default=None,
                   help="discovery: search last N days (default: since last run)")
    p.add_argument("--scholar", action="store_true",
                   help="discovery: also try Google Scholar (best-effort)")
    p.add_argument("--dry", action="store_true",
                   help="dry run; don't write to DB")
    args = p.parse_args()

    started = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_dir = SCRIPTS / "logs"
    log_dir.mkdir(exist_ok=True)
    print(f"\nMata Tracker · weekly run · started {started}")
    print(f"logs: {log_dir}\n")

    failed: list[str] = []

    # 1. Discover
    if not args.skip_discover:
        cmd = [sys.executable, "-u", str(SCRIPTS / "discover_new_cases.py")]
        if args.lookback:
            cmd += ["--lookback", str(args.lookback)]
        if args.scholar:
            cmd.append("--scholar")
        if args.dry:
            cmd.append("--dry")
        rc = run_step("STEP 1 / 4 · Discover new cases (CourtListener)",
                      cmd, log_dir / f"{started}_1_discover.log")
        tail(log_dir / f"{started}_1_discover.log", 25)
        if rc != 0:
            failed.append("discover")

    # 2. RECAP / IA backfill
    if not args.skip_recap and not args.dry:
        cmd = [sys.executable, "-u", str(SCRIPTS / "fetch_recap.py"),
               "--all", "--batch", "25", "--sleep", "1.0"]
        rc = run_step("STEP 2 / 4 · RECAP/IA backfill for federal cases",
                      cmd, log_dir / f"{started}_2_recap.log")
        tail(log_dir / f"{started}_2_recap.log", 12)
        if rc != 0:
            failed.append("recap")
    else:
        banner("STEP 2 / 4 · RECAP/IA backfill — SKIPPED")

    # 3. Annotate
    if not args.no_annotate and not args.dry:
        cmd = [sys.executable, "-u", str(SCRIPTS / "annotate.py"),
               "--all", "--sleep", "30.0"]
        rc = run_step("STEP 3 / 4 · Claude annotation pass",
                      cmd, log_dir / f"{started}_3_annotate.log")
        tail(log_dir / f"{started}_3_annotate.log", 12)
        if rc != 0:
            failed.append("annotate")
    else:
        banner("STEP 3 / 4 · Annotation — SKIPPED")

    # 4. Missing report
    cmd = [sys.executable, "-u", str(SCRIPTS / "missing_report.py")]
    rc = run_step("STEP 4 / 4 · Coverage report",
                  cmd, log_dir / f"{started}_4_report.log")
    if rc == 0:
        print((log_dir / f"{started}_4_report.log")
              .read_text(encoding="utf-8", errors="replace"))
    else:
        failed.append("report")

    banner("DONE")
    if failed:
        print(f"  steps with non-zero exit: {', '.join(failed)}")
        print(f"  full logs in: {log_dir}")
    else:
        print("  all steps OK")

    print()
    print("  next: review draft annotations in Supabase, then publish:")
    print("    update annotations set status='published',")
    print("                          reviewed_by='blake',")
    print("                          reviewed_at=now()")
    print("     where status='draft';")
    print()
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
