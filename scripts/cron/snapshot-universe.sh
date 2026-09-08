#!/usr/bin/env bash
#
# Cron wrapper for scripts/snapshot-universe.ts.
#
# Install (already done once; shown here so it can be re-created or removed):
#   crontab -l | grep snapshot-universe             # check
#   20 14 * * 1-5 /local/home/ashunsah/workplace/IndianStockMarketSkills/scripts/cron/snapshot-universe.sh
#
# 14:20 UTC = 19:50 IST — after the 15:30 IST close (so the day's membership and
# the Screener-seeded ad-hoc list are settled) and 27 minutes ahead of the
# bulk-deals refresh, so the two never contend for the same SQLite writer even
# if one runs long.
#
# WHY THIS RUNS DAILY AT ALL: a snapshot can only be taken in the present. Every
# weekday this misses is a day of index membership that is gone for good, and the
# gap shows up later as survivorship bias — a stock delisted or dropped from the
# ₹5,000 Cr floor is silently absent from any "as-of-then" analysis. lib/backtest.ts
# checks whether universe_snapshot covers the backtest window and reports
# universe_mode "static_today" until it does, then switches itself to
# "point_in_time" with no code change. This cron is what eventually flips it.
#
set -uo pipefail

REPO="/local/home/ashunsah/workplace/IndianStockMarketSkills"
LOG_DIR="$REPO/logs"
LOG="$LOG_DIR/snapshot-universe.log"
LOCK="/tmp/snapshot-universe.lock"

# Cron gets a near-empty PATH, and the system node is 18 (ABI 108) which cannot
# load better-sqlite3's binary (built for ABI 127) — this prepend is
# load-bearing, not tidiness.
export PATH="/home/ashunsah/.local/node/bin:$PATH"
export PORTFOLIO_DB_PATH="$REPO/data/portfolio.db"

mkdir -p "$LOG_DIR"

# -n: if a previous run is somehow still going, skip rather than pile up a
# second writer on the same SQLite file.
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "[$(date -u +%FT%TZ)] SKIPPED: previous run still holding $LOCK" >>"$LOG"
  exit 0
fi

cd "$REPO" || exit 1

{
  echo "=== [$(date -u +%FT%TZ)] snapshot-universe start ==="
  npx tsx scripts/snapshot-universe.ts 2>&1
  status=$?
  echo "=== exit=$status ==="
} >>"$LOG" 2>&1

# Keep the log bounded — this runs every weekday forever.
if [ "$(wc -l <"$LOG")" -gt 2000 ]; then
  tail -n 1000 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
