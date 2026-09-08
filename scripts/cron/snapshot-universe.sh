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
# shellcheck source=scripts/cron/_lib.sh
source "$(dirname "$0")/_lib.sh"

cron_init snapshot-universe
cron_step "snapshot" npx tsx scripts/snapshot-universe.ts
cron_finish
