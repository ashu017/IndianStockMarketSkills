#!/usr/bin/env bash
#
# Shared harness for scripts/cron/*.sh. Sourced, never executed directly.
#
# WHY THIS EXISTS: every wrapper here previously ended with a log-rotation `if`,
# so the script's exit status was the status of *that* test rather than of the
# work. refresh-bulk-deals.sh returned 0 to cron for weeks while logging
# "exit=1" from a hard SQLITE_ERROR — the table it wrote to did not exist at
# all. A cron job that cannot fail cannot be monitored, so exit-code
# propagation is the whole point of this file, not a convenience.
#
# Usage:
#   source "$(dirname "$0")/_lib.sh"
#   cron_init snapshot-universe
#   cron_step   "snapshot" npx tsx scripts/snapshot-universe.ts
#   cron_step_optional "live quotes" npx tsx scripts/refresh-live-quotes.ts
#   cron_finish
#
# cron_step marks the run failed on a non-zero exit; cron_step_optional never
# does (for steps the pipeline is designed to survive, e.g. a live-quote fetch
# that falls back to end-of-day bars). Both return the child's real exit code,
# so callers can branch on it. The last step's stdout is always left at
# $CRON_LAST_STDOUT for a following step to parse.

set -uo pipefail

REPO="/local/home/ashunsah/workplace/IndianStockMarketSkills"

# Cron gets a near-empty PATH, and the system node is 18 (ABI 108) which cannot
# load better-sqlite3's binary (built for ABI 127) — this prepend is
# load-bearing, not tidiness.
export PATH="/home/ashunsah/.local/node/bin:$PATH"
export PORTFOLIO_DB_PATH="$REPO/data/portfolio.db"

# Set by cron_init.
CRON_JOB=""
CRON_LOG=""
CRON_FAILED=0
CRON_FAILED_STEPS=""
CRON_LAST_STDOUT=""

# cron_init <job-name>
#
# Takes an exclusive lock, opens the log, and cds to the repo. Exits 0 (not an
# error) if a previous run still holds the lock: overlapping runs would put two
# writers on the same SQLite file, and skipping is the correct response, not a
# failure worth alerting on.
cron_init() {
  CRON_JOB="$1"
  CRON_LOG="$REPO/logs/$CRON_JOB.log"
  CRON_LAST_STDOUT="$(mktemp "/tmp/$CRON_JOB.stdout.XXXXXX")"

  mkdir -p "$REPO/logs" || exit 1

  exec 9>"/tmp/$CRON_JOB.lock"
  if ! flock -n 9; then
    echo "[$(date -u +%FT%TZ)] SKIPPED: previous run still holding the lock" >>"$CRON_LOG"
    exit 0
  fi

  cd "$REPO" || exit 1

  # .env holds the Screener session cookies the quality screen needs. Cron does
  # not read it, and `set -a` is what makes the assignments exported rather than
  # shell-local. Absent .env is not fatal: the affected step reports its own
  # status and the caller falls back.
  if [ -f "$REPO/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$REPO/.env"
    set +a
  fi

  {
    echo
    echo "=== [$(date -u +%FT%TZ)] $CRON_JOB start ==="
  } >>"$CRON_LOG"

  trap cron_cleanup EXIT
}

cron_cleanup() {
  [ -n "$CRON_LAST_STDOUT" ] && rm -f "$CRON_LAST_STDOUT"
}

# Internal: run a command, tee stdout to both the log and $CRON_LAST_STDOUT.
_cron_exec() {
  local label="$1"
  shift
  echo "--- [$(date -u +%FT%TZ)] $label ---" >>"$CRON_LOG"
  # stdout goes to a file rather than through a pipe so $? is the child's own
  # status, not a pipeline's last element — and so a later step can re-read it.
  "$@" >"$CRON_LAST_STDOUT" 2>>"$CRON_LOG"
  local status=$?
  cat "$CRON_LAST_STDOUT" >>"$CRON_LOG"
  echo "--- $label exit=$status ---" >>"$CRON_LOG"
  return $status
}

# cron_step <label> <command...>  — failure marks the whole run failed.
cron_step() {
  local label="$1"
  _cron_exec "$@"
  local status=$?
  if [ "$status" -ne 0 ]; then
    CRON_FAILED=1
    CRON_FAILED_STEPS="$CRON_FAILED_STEPS${CRON_FAILED_STEPS:+, }$label"
  fi
  return $status
}

# cron_step_optional <label> <command...> — logged, never marks the run failed.
cron_step_optional() {
  local label="$1"
  _cron_exec "$@"
  local status=$?
  if [ "$status" -ne 0 ]; then
    echo "--- $label failed (non-blocking, continuing) ---" >>"$CRON_LOG"
  fi
  return $status
}

# cron_fail <reason> — mark the run failed from wrapper-level logic (a condition
# no single command's exit code expresses, e.g. "today's data never landed").
cron_fail() {
  CRON_FAILED=1
  CRON_FAILED_STEPS="$CRON_FAILED_STEPS${CRON_FAILED_STEPS:+, }$1"
  echo "!!! $1" >>"$CRON_LOG"
}

# cron_finish — record the verdict, rotate the log, then exit non-zero if
# anything failed.
#
# The exit happens last and unconditionally so the rotation can never mask it,
# which is exactly the bug this harness replaces.
#
# The verdict is ALSO appended to logs/cron-status.tsv, and that file is the part
# that actually gets read. A non-zero exit is only useful to cron if cron can
# tell someone: its sole response is to mail the output, and this host has no
# sendmail and an inactive postfix, so cron mail is silently discarded. Exiting
# non-zero into a void is not monitoring. One append-only line per run gives
# scripts/check-freshness.ts something durable to look at, so a job that ran and
# failed reads differently from a job that never ran at all.
cron_finish() {
  local ts
  ts="$(date -u +%FT%TZ)"
  if [ "$CRON_FAILED" -eq 0 ]; then
    echo "=== [$ts] $CRON_JOB OK ===" >>"$CRON_LOG"
    printf '%s\t%s\tOK\t\n' "$ts" "$CRON_JOB" >>"$REPO/logs/cron-status.tsv"
  else
    echo "=== [$ts] $CRON_JOB FAILED: $CRON_FAILED_STEPS ===" >>"$CRON_LOG"
    printf '%s\t%s\tFAILED\t%s\n' "$ts" "$CRON_JOB" "$CRON_FAILED_STEPS" >>"$REPO/logs/cron-status.tsv"
  fi

  # Bounded like the per-job logs, but with a longer tail: this is the only
  # cross-job history there is, and six jobs a day fill it slowly.
  local status_file="$REPO/logs/cron-status.tsv"
  if [ -f "$status_file" ] && [ "$(wc -l <"$status_file")" -gt 5000 ]; then
    tail -n 2500 "$status_file" >"$status_file.tmp" && mv "$status_file.tmp" "$status_file"
  fi

  # Keep the log bounded — these run every weekday forever.
  if [ -f "$CRON_LOG" ] && [ "$(wc -l <"$CRON_LOG")" -gt 2000 ]; then
    tail -n 1000 "$CRON_LOG" >"$CRON_LOG.tmp" && mv "$CRON_LOG.tmp" "$CRON_LOG"
  fi

  exit "$CRON_FAILED"
}
