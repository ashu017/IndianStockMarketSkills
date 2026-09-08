#!/usr/bin/env bash
#
# Brings the Next dev server back on 127.0.0.1:3000 after a reboot.
#
# Install:
#   @reboot /local/home/ashunsah/workplace/IndianStockMarketSkills/scripts/cron/start-dev-server.sh
#
# WHY: this host takes an automated kernel-patch reboot every Saturday at about
# 19:13 UTC (Sunday 00:43 IST) — eight consecutive Saturdays observed. crond and
# the MeshClaw systemd unit both come back on their own; the dev server does not,
# because nothing owns it. So the dashboard was silently down every Sunday until
# someone opened it and noticed. The reboot lands outside market hours, so no scan
# is ever lost to it — only the UI.
#
# This is a DEV server on purpose, not `next start`: the app is bound to
# 127.0.0.1 for a single local reader, hot-reload is wanted, and there is no
# build artifact to keep current. It is not serving anyone but this desktop.
#
# @reboot runs once at crond start, so this does not use the shared harness —
# there is no per-run log to rotate and no exit code for cron to act on. It does
# still take the lock, so a manual re-run cannot start a second server.
set -uo pipefail

REPO="/local/home/ashunsah/workplace/IndianStockMarketSkills"
LOG="$REPO/logs/dev-server.log"
PORT=3000

export PATH="/home/ashunsah/.local/node/bin:$PATH"
export PORTFOLIO_DB_PATH="$REPO/data/portfolio.db"

mkdir -p "$REPO/logs"

exec 9>"/tmp/dev-server.lock"
if ! flock -n 9; then
  echo "[$(date -u +%FT%TZ)] another start-dev-server is running; leaving it alone" >>"$LOG"
  exit 0
fi

cd "$REPO" || exit 1

# Already up? Do nothing. Makes the script safe to run by hand at any time,
# including as a poor man's health check.
if curl -sf -o /dev/null --max-time 5 "http://127.0.0.1:$PORT/"; then
  echo "[$(date -u +%FT%TZ)] port $PORT already serving; nothing to do" >>"$LOG"
  exit 0
fi

# Truncate rather than append: this log is the current server's output and grows
# for as long as the process lives, so a week of rotation-free appends from the
# previous boot is not worth keeping.
{
  echo "=== [$(date -u +%FT%TZ)] starting next dev on 127.0.0.1:$PORT ==="
} >"$LOG"

# setsid detaches from crond's process group so the server survives crond
# reaping its @reboot children. Without it the server dies seconds after start.
setsid nohup npx next dev --hostname 127.0.0.1 --port "$PORT" >>"$LOG" 2>&1 &
disown

# Give Turbopack time to compile before declaring anything. Next takes a few
# seconds cold, and reporting "up" before it binds would make this log lie.
for _ in $(seq 1 30); do
  sleep 2
  if curl -sf -o /dev/null --max-time 5 "http://127.0.0.1:$PORT/"; then
    echo "=== [$(date -u +%FT%TZ)] up on 127.0.0.1:$PORT ===" >>"$LOG"
    exit 0
  fi
done

echo "=== [$(date -u +%FT%TZ)] FAILED: no response on port $PORT after 60s ===" >>"$LOG"
exit 1
