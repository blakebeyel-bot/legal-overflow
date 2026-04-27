@echo off
REM Mata Tracker — weekly maintenance runner.
REM Double-click this file (or run it from Task Scheduler) to:
REM   1. Discover new sanction cases on CourtListener
REM   2. Backfill federal cases via RECAP / Internet Archive
REM   3. Annotate every new case via Claude
REM   4. Print a coverage report
REM
REM Drafts land in the database with status='draft'. Review them in
REM Supabase Studio and publish manually with:
REM
REM   update annotations
REM      set status='published', reviewed_by='blake', reviewed_at=now()
REM    where status='draft';

cd /d "%~dp0..\.."
set PYTHONIOENCODING=utf-8

echo.
echo  Mata Tracker — weekly run
echo  ==========================
echo.

python -u scripts\mata\weekly_run.py %*

echo.
echo  Done. Logs are in scripts\mata\logs\
echo.
pause
