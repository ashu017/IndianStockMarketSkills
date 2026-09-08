---
name: nifty100-signal-scan
description: Scan the Nifty 100 for BUY signals using the Quality+Momentum+Breakout recipe, then compose a Telegram digest (or print to stdout in dry-run mode). Signals include entry, stop, target, and R:R. Read-only — never places orders. Runs the OHLC refresh (NSE bhavcopy) and fundamentals refresh (batch-analyze-fundamentals on Nifty 100 ISINs) before scanning.
---

# nifty100-signal-scan

Full pipeline: refresh data → scan → post. Read-only. Never places orders.

## When to use

- The `nifty100-signals` cron fires (3× on weekdays at 10:00, 12:00, 15:00 IST).
- The user asks for a Nifty 100 scan.
- Do NOT use for portfolio-only alerts — those live in `portfolio-telegram`.

## Steps

Working directory: `/home/ashunsah/workplace/IndianStockMarketSkills`

1. **Ensure PATH prioritizes Node 22 and .env is loaded:**

   ```bash
   cd /home/ashunsah/workplace/IndianStockMarketSkills
   export PATH=/home/ashunsah/.local/node/bin:$PATH
   ```

2. **Ensure a valid Kite session is not required for this scan** — the bhavcopy
   source is public NSE data. However, if the seed script needs a rerun (rare —
   only when NSE rebalances the index every 6 months), you'll separately reseed
   with `scripts/seed-nifty100-instruments.ts`. For a normal daily scan, skip.

3. **Refresh OHLC** (idempotent; only fetches missing trade dates):

   ```bash
   OHLC_DAYS=10 PORTFOLIO_DB_PATH=./data/portfolio.db \
     npx tsx scripts/refresh-nifty100-ohlc.ts
   ```

   Use `OHLC_DAYS=10` for daily refreshes (only the last few sessions are missing
   from a well-warmed DB). For a first-ever run, use `OHLC_DAYS=500` — but the
   backfill takes ~4-5 minutes; use the cron's own timeout budget accordingly.

   Expected output on a normal run: `{"status":"ok","inserted_rows":N,...}` where
   N is small (0-100 rows per new trading day, times how many missing days).

4. **Refresh fundamentals for Nifty 100** (only stocks stale for today):

   ```bash
   ISINS=$(npx tsx scripts/nifty100-isins.ts)
   ISINS="$ISINS" PORTFOLIO_DB_PATH=./data/portfolio.db \
     npx tsx scripts/analysis-status.ts
   ```

   Parse the `{today, fresh, stale}` output. If `stale` is empty, skip to step 5.
   If any ISINs are stale, invoke the `batch-analyze-fundamentals` skill in-line
   (same Claude session — do NOT spawn subagents) with the same `ISINS` list.
   The batch skill fans out Screener MCP calls in one turn, synthesizes verdicts
   once, and bulk-persists into the `analysis` + `fundamentals` tables. If the
   Screener MCP is unavailable, note it in the run log and continue — the
   scanner has an `IGNORE_QUALITY_GATE=1` fallback (used only when explicitly
   set; NOT enabled by default because it produces lower-quality signals).

5. **Run the scanner:**

   ```bash
   PORTFOLIO_DB_PATH=./data/portfolio.db \
     npx tsx scripts/scan-nifty100-signals.ts
   ```

   The scanner prints one JSON block with `regime`, `signals_emitted`, and the
   `signals[]` array. In a bear-regime session (Nifty 100 median < its 200-SMA),
   `signals_emitted` is always 0 by design. Signals are also persisted to the
   `signals` SQLite table with UNIQUE(symbol, exchange, scan_date, side) dedup —
   re-running the same scan on the same day is a no-op.

6. **Compose the Telegram message** from the scanner's JSON output:

   ```
   📈 Nifty 100 signals — <Weekday HH:MM IST>
   Regime: <bull|bear> (<reason>)
   Universe 100 · Quality pass <N> · Top-momentum <30> · Signals <K>

   [BUY] SYMBOL  (mom rank R/30)
     Entry ≤ Rs<entry>   Target Rs<target> (+X.X%)   Stop Rs<stop> (−Y.Y%)   R:R 1:<rr>
     Q: ROCE X% · ROE Y% · D/E Z · sales A% · profit B% · promoter C%
     T: px>200D · 50D>200D · 20D breakout · vol N.Nx · mom 12-1: S

   [BUY] SYMBOL  ...

   Managed: <exit_rule.description>

   [Active positions]
   SYMBOL · entered <date> at Rs<entry> · <qty_open> of <qty> sh · now Rs<close> (+X%)
     · stop Rs<stop> · <bars_held>d held · part booked at Rs<partial_exit_rs> (+RsN realized), runner stopped at entry

   Educational only — not SEBI-registered investment advice. At your own risk.
   ```

   Derive every number from the JSON — do NOT hardcode the recipe:
   - `R:R` is `reward_pct / risk_pct`, not a constant. The stop/target geometry
     is versioned (it moved from 2×ATR/3R to 1.75×ATR/5R on 2026-08-31), so a
     literal like `R:R 3.0` describes trades the engine no longer places.
   - `Managed:` is `exit_rule.description` verbatim from the scanner. It states
     the rule NEW entries open on.
   - In `[Active positions]`, quote `qty_open` (shares still held), and show the
     `of <qty>` suffix only when `scaled_out` is true. Append `part booked …`
     when `scaled_out`; use the plain `stop moved to breakeven` wording only for
     a position at breakeven that has booked nothing — those are grandfathered
     rows still on the older rule, where breakeven at 1R was automatic.

   Special cases:
   - If `regime.bull=false`, replace the signal blocks with a single line:
     `Bear regime — long signals paused. No trades this scan.`
   - If `regime.bull=true` and `signals_emitted=0`, use:
     `No stocks met all filters this scan.`
   - Omit `[Active positions]` when `active_positions` is empty.
   - If `position_update.scaled_out > 0`, add a `[Part booked since last scan]`
     section. Do NOT count these as closes — the runner is still open.
   - Include the disclaimer regardless.

7. **DRY_RUN handling:**

   - If env `DRY_RUN=1`, print the composed message to stdout and STOP. Do NOT
     post to Telegram. Do NOT write the dedup hash. The scan itself DID persist
     to the `signals` table, which is fine.
   - Otherwise: dedup-hash-check the message content (sha256 of the normalized
     body, stripping the timestamp header line), compare to the file
     `/home/ashunsah/.meshclaw/workspace/telegram-server/.nifty100-last-hash`.
     If unchanged, skip the send. Else POST to
     `http://127.0.0.1:8765/send` and overwrite the hash file.

8. **Report** one line: `Scan complete — <N> signals, regime <bull|bear>, <posted|skipped-dedup|dry-run>.`

## Rules

- Read-only. Do NOT place orders, modify orders, or cancel orders.
- Do NOT spawn subagents (no spawn_run, no fundamental-analyst dispatch).
  Fundamentals refresh is inline via the batch-analyze-fundamentals skill.
- Never fabricate signals. If a step fails, the composed message must say so
  explicitly (e.g. `[Fundamentals] refresh failed — using stale quality data`).
- silent=true. Do NOT also post to Slack.
- Overall run budget: 90 seconds for a daily refresh (OHLC=10 days).

## Notes on the recipe

Full recipe is documented in `docs/superpowers/plans/2026-07-22-nifty100-strategy.md`
(if that file exists) or the header comment of `scripts/scan-nifty100-signals.ts`.
Do not tune thresholds in this skill — thresholds are code-defined so the recipe
is reproducible across scans and testable.

