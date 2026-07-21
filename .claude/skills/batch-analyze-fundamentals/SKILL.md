---
name: batch-analyze-fundamentals
description: Fetch Screener fundamentals+peers for every stale holding IN ONE PARALLEL PASS, then perform ONE batched Claude synthesis that emits a JSON array of BUY/SELL/HOLD verdicts for all of them, and bulk-write to the analysis table in a single SQLite transaction. Use INSTEAD OF fanning out per-stock fundamental-analyst subagents when running from a cron. Runs in one Claude session — no subagent spawning.
---

# batch-analyze-fundamentals

Replaces the per-stock fan-out (42 subagents × screener × persist) with one
in-process batched flow:

1. **Fetch in parallel** — for every stale ISIN, call `mcp__screener__get_fundamentals`
   and `mcp__screener__get_peers`. All 2N tool calls happen in the same Claude turn,
   which the runtime executes concurrently. Failures are captured, not fatal.
2. **Synthesize once** — a single reasoning step consumes the whole table and emits
   one JSON array with one verdict per ISIN. No follow-up LLM calls per stock.
3. **Persist once** — a single `scripts/persist-analyses-batch.ts` run writes every
   row inside one SQLite transaction.

This is what the portfolio cron should invoke when it needs today's fundamentals
refreshed — NOT the `fundamental-analyst` subagent (which is fine for interactive
one-off deep dives but too slow / too expensive to fan out from a cron).

## When to use

- The `portfolio-telegram` cron needs Section C populated before composing alerts.
- The user asks for a "portfolio-wide fundamentals refresh" or "regrade everything".
- Do NOT use for a single ad-hoc stock deep-dive — that's what `fundamental-analyst` is for.

## Steps

Working directory: `/home/ashunsah/workplace/IndianStockMarketSkills`

1. **Determine what's stale.** Skip anything already analyzed today. Same input
   contract as the per-stock flow:

   ```bash
   cd /home/ashunsah/workplace/IndianStockMarketSkills
   export PATH=/home/ashunsah/.local/node/bin:$PATH
   PORTFOLIO_DB_PATH=./data/portfolio.db npx tsx scripts/analysis-status.ts
   ```

   Parse the `{today, fresh, stale}` JSON. If `stale` is empty, print
   `{"status":"ok","persisted":0,"failed":0,"skipped":<N>}` and STOP.

   To force a full refresh, invoke with `FORCE=1` and treat every ISIN as stale.

2. **Load the symbol/exchange for each stale ISIN** from `data/holdings.json` (already
   produced by `fetch-holdings`). Build a work list of `{isin, symbol, exchange}`.

3. **Fan out Screener calls IN PARALLEL, in ONE Claude turn.** For every entry in
   the work list, issue BOTH tool calls in the same assistant message (put every
   `mcp__screener__get_fundamentals` and `mcp__screener__get_peers` call in the same
   turn — the runtime dispatches them concurrently):

   - `mcp__screener__get_fundamentals(symbol=<symbol>)`
   - `mcp__screener__get_peers(symbol=<symbol>)`

   Do NOT call `get_financials` or `get_chart` — token-heavy and not needed here.
   If either call fails for a given ISIN, mark its `fetch_status: "failed"` and
   include it anyway with `verdict: "HOLD"`, `confidence: "Low"`, and a narrative
   that explicitly says fundamentals were unavailable. Never fabricate numbers.

4. **Parse the Screener responses into normalized numeric fields.** Screener strings
   contain `₹`, `%`, `×`, commas, and `Cr`/`Cr.` suffixes. Strip them, coerce to
   Number, and store null when missing. Convert market cap in crore to paise using
   `crore × 1e9`. Same field set as `AnalysisPayload.fundamentals` in
   `lib/ingest/analysis-writer.ts`.

5. **Synthesize verdicts in ONE reasoning pass** across the full N-row table.
   For each ISIN, weigh three axes (all cited with the raw numbers):
   - **Quality:** grade PE, PB, ROE, ROCE, debt/equity, growth against sector norms.
     Use sector-aware judgement — banks/NBFCs on NIM/GNPA/CASA/ROE (not D/E),
     IT on margins/growth, cyclicals with cycle context.
   - **Valuation:** vs peer median from `get_peers`.
   - **Position:** if a matching holding exists in `data/holdings.json`, weigh
     avg cost, current P&L, and portfolio weight.
   Emit a verdict per axis-weighted score:
   - `BUY` — strong quality + fair valuation vs peers + not already overweight
   - `SELL` — weak quality OR extreme overvaluation OR sizable drawdown with no thesis left
   - `HOLD` — anything else. HOLD is the default; only cross to BUY/SELL when the
     numbers actually justify it.
   Each verdict carries a `confidence` (Low/Medium/High) and a short narrative
   (≤50 words) citing the specific ratios that drove it.

6. **Build the payload array** — one AnalysisPayload per stale ISIN in the shape:

   ```json
   {
     "isin": "...",
     "fundamentals": { "pe": 20.1, "pb": 3.2, "roe": 18, ..., "fetch_status": "ok" },
     "extra": [],
     "peers": [{ "peer_symbol": "...", "peer_company": "...", "pe": null, ... }],
     "analysis": {
       "narrative": "...",
       "verdict": "BUY|SELL|HOLD",
       "confidence": "Low|Medium|High",
       "model_version": "batch-<claude-version>",
       "prompt_version": "batch-fund-v1"
     }
   }
   ```

7. **Persist in one transaction:**

   ```bash
   cd /home/ashunsah/workplace/IndianStockMarketSkills
   export PATH=/home/ashunsah/.local/node/bin:$PATH
   # Write the JSON array to a tmp file (avoids arg-length limits at scale):
   echo '<the JSON array>' > /tmp/analyses-batch.json
   PORTFOLIO_DB_PATH=./data/portfolio.db \
     npx tsx scripts/persist-analyses-batch.ts --file /tmp/analyses-batch.json
   rm /tmp/analyses-batch.json
   ```

   Confirm it prints `{"status":"ok","persisted":<N>,...}` (or `"partial"` if some
   rows had DB errors — the log lists them).

8. **Report** one line: `Analyzed N stocks — <B> BUY, <H> HOLD, <S> SELL. K failed.`

## Failure modes

- **Screener rate limits (429):** back off 5s, retry once. If it fails again for a
  given ISIN, include it as a failed row (HOLD/Low) — do not block the batch.
- **Empty stale list:** print the OK JSON and STOP; do not synthesize anything.
- **Persist error:** the batch writer reports partial success — surface the count
  of failures. Rows that succeeded are committed; the failed ones are listed with
  their DB errors.
- **DB locked:** rare; the writer has 5s busy_timeout. If it still fails, back off
  10s and retry once.

## Why this is faster than the fan-out

The per-stock flow spends most of its time in Claude startup + MCP wiring, not in
Screener. Batching moves the fixed cost from N × per-agent-startup down to one.
For 42 stocks:

- **Old fan-out:** ~42 × (2s startup + 2 Screener calls + 1 persist + LLM synthesis)
  ≈ 6+ minutes wall-clock, hundreds of thousands of tokens.
- **This flow:** 84 concurrent Screener calls in one turn (~10-20s), one synthesis
  pass, one persist transaction. ≈ 30-45s wall-clock, one LLM inference.

## Notes

- Runs in the CURRENT Claude session — do NOT call `spawn_run`, do NOT dispatch
  `fundamental-analyst`. The whole point is to avoid the fan-out.
- ISIN is the DB key. All rows must have an ISIN — take it from `data/holdings.json`.
- The `analysis` table upserts on `(isin)` — a same-day re-run overwrites the row
  (that's what the "skip fresh unless FORCE=1" rule prevents by default).
- HOLD verdicts are still persisted so the dashboard can show them, but the
  Telegram cron reads only BUY/SELL for alerts.
