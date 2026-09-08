#!/usr/bin/env bash
#
# The signal scan: refresh price data, refresh the quality screen, scan, report.
#
# Install (weekdays, IST — crond on this host runs in UTC, so these are the
# UTC equivalents of 10:00 / 12:00 / 14:00 / 15:00 IST):
#   30  4 * * 1-5 .../scripts/cron/scan-signals.sh   # 10:00 IST — post-open
#   30  6 * * 1-5 .../scripts/cron/scan-signals.sh   # 12:00 IST — midday
#   30  8 * * 1-5 .../scripts/cron/scan-signals.sh   # 14:00 IST — pre-close hour
#   30  9 * * 1-5 .../scripts/cron/scan-signals.sh   # 15:00 IST — final half hour
#
# WHY THIS IS A SHELL SCRIPT: it used to be a scheduled prompt to a language
# model, which meant an eight-step deterministic pipeline could only run while a
# short-lived Amazon Bedrock credential was valid. The scan stopped on days the
# token lapsed — a market-data job failing for authentication reasons entirely
# unrelated to the market. None of the steps need a model; the only judgement
# call was formatting the digest, which scripts/report-scan.ts now does.
#
# WHAT THIS DELIBERATELY DOES NOT DO, carried over from the prompt it replaces:
#   - Sends nothing anywhere. No Telegram, no Slack, no HTTP to 127.0.0.1:8765.
#     The telegram-server directory is frozen pending P503463088; nothing here
#     touches it.
#   - Never writes or reads .nifty100-last-hash. That file deduplicated outbound
#     messages; with no send to deduplicate, stamping it would corrupt state.
#   - Read-only against the broker. It places no orders and does not check the
#     Kite session — the scan is independent of Kite entirely.
#
set -uo pipefail
# shellcheck source=scripts/cron/_lib.sh
source "$(dirname "$0")/_lib.sh"

cron_init scan-signals

# 1. Daily bars. Blocking: without price data there is nothing to scan.
#    OHLC_DAYS=10 keeps the trailing window small — this runs four times a day
#    and the history is already backfilled.
cron_step "refresh OHLC" env OHLC_DAYS=10 npx tsx scripts/refresh-nifty100-ohlc.ts

# 2. Intraday quotes. Non-blocking by design: NSE's NextApi is flaky, and the
#    scanner falls back to end-of-day bars when today's quote is missing. A
#    failure here degrades freshness, it does not invalidate the scan.
cron_step_optional "live quotes" npx tsx scripts/refresh-live-quotes.ts

# 3. The Screener quality screen. Exit 2 means specifically that the login
#    cookies expired (the endpoint answered with a redirect), which is worth
#    naming separately in the log because the fix is a human copying two values
#    out of a browser — nothing here can retry its way out of it.
cron_step "screener screen" npx tsx scripts/fetch-screener-screen.ts
screener_status=$?
if [ "$screener_status" -eq 2 ]; then
  echo "!!! Screener cookies have expired. Rotate SCREENER_CSRF_TOKEN and" >>"$CRON_LOG"
  echo "!!! SCREENER_SESSION_ID in .env from a logged-in browser session." >>"$CRON_LOG"
fi

# 4. Scan. Always against the Screener screen, even when step 3 just failed.
#
#    This is the deliberate change from the prompt this replaces, which dropped
#    to the raw index whenever step 3 errored. That fallback silently swapped the
#    universe for one with no fundamental filter at all, and it went unnoticed for
#    two weeks. Running against the screen regardless means a failed refresh
#    shows up as a stale run_date, which report-scan.ts detects and fails on —
#    the same underlying problem, but impossible to miss.
cron_step "scan" env USE_SCREENER_SCREEN=1 VOL_ESTIMATOR=yang_zhang \
  npx tsx scripts/scan-nifty100-signals.ts
scan_status=$?

# Copy the scanner's JSON aside: the next cron_step overwrites CRON_LAST_STDOUT.
SCAN_JSON="$(mktemp /tmp/scan-signals.json.XXXXXX)"
cp "$CRON_LAST_STDOUT" "$SCAN_JSON"

# The one case where falling back to the index is better than nothing: an empty
# screener_screen_cache makes USE_SCREENER_SCREEN=1 a hard error, so there is no
# scan at all to report on. Take the unfiltered universe so the run still
# produces a digest — but the failure is already recorded, so it stays loud.
if [ "$scan_status" -ne 0 ] && grep -q "screener_screen_cache is empty" "$SCAN_JSON" 2>/dev/null; then
  echo "!!! screener_screen_cache is empty — rescanning on the raw index." >>"$CRON_LOG"
  echo "!!! Signals from this run have NO fundamental filter behind them." >>"$CRON_LOG"
  cron_step_optional "scan (index fallback)" env VOL_ESTIMATOR=yang_zhang \
    npx tsx scripts/scan-nifty100-signals.ts
  cp "$CRON_LAST_STDOUT" "$SCAN_JSON"
fi

# 5. Format the digest and judge the run. Exit 3 from the reporter means the scan
#    completed against stale inputs — a distinct condition from the scan failing,
#    and the one that used to be invisible.
cron_step_optional "report" npx tsx scripts/report-scan.ts "$SCAN_JSON"
report_status=$?
if [ "$report_status" -eq 3 ]; then
  cron_fail "scan ran on STALE inputs — see the [!! STALE INPUTS !!] block above"
elif [ "$report_status" -ne 0 ]; then
  cron_fail "report failed (exit $report_status)"
fi

rm -f "$SCAN_JSON"
cron_finish
