#!/usr/bin/env bash
#
# Cron wrapper for scripts/refresh-bulk-deals.ts.
#
# Install (already done once; shown here so it can be re-created or removed):
#   crontab -l | grep refresh-bulk-deals            # check
#   47 14 * * 1-5 /local/home/ashunsah/workplace/IndianStockMarketSkills/scripts/cron/refresh-bulk-deals.sh
#
# 14:47 UTC = 20:17 IST, comfortably after NSE publishes the day's bulk-deal
# report (~18:00-19:00 IST, itself well after the 15:30 close). Weekdays only —
# the exchange is shut at weekends, and the 7-day trailing window means a
# Monday run would re-cover any weekend anyway.
#
set -uo pipefail

REPO="/local/home/ashunsah/workplace/IndianStockMarketSkills"
LOG_DIR="$REPO/logs"
LOG="$LOG_DIR/refresh-bulk-deals.log"
LOCK="/tmp/refresh-bulk-deals.lock"

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
  echo "=== [$(date -u +%FT%TZ)] refresh-bulk-deals start ==="
  npx tsx scripts/refresh-bulk-deals.ts 2>&1
  status=$?
  echo "=== exit=$status ==="
} >>"$LOG" 2>&1

# Keep the log bounded — this runs every weekday forever.
if [ "$(wc -l <"$LOG")" -gt 2000 ]; then
  tail -n 1000 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
