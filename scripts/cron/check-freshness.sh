#!/usr/bin/env bash
#
# Cron wrapper for scripts/check-freshness.ts — the watchdog over the other jobs.
#
# Install:
#   30 15 * * 1-5 /local/home/ashunsah/workplace/IndianStockMarketSkills/scripts/cron/check-freshness.sh
#
# 15:30 UTC = 21:00 IST, deliberately last: after the final scan (15:00 IST), the
# universe snapshot (19:50 IST) and the bulk-deals refresh (20:17 IST). Running it
# earlier would flag feeds that simply had not been refreshed yet.
#
# WHY IT WATCHES THE DATABASE AND NOT THE JOBS: a cron entry that cannot execute
# writes no log and returns no exit code — it is indistinguishable from a quiet
# day. Both daily jobs sat unexecutable at mode 644 for weeks and nothing noticed.
# This asks the only question that cannot be faked: is the data actually there?
#
set -uo pipefail
# shellcheck source=scripts/cron/_lib.sh
source "$(dirname "$0")/_lib.sh"

cron_init check-freshness
export REPO_DIR="$REPO"
cron_step "freshness" npx tsx scripts/check-freshness.ts
cron_finish
