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
# shellcheck source=scripts/cron/_lib.sh
source "$(dirname "$0")/_lib.sh"

cron_init refresh-bulk-deals
cron_step "refresh" npx tsx scripts/refresh-bulk-deals.ts
cron_finish
