import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Technical screener over the live TradingView data feed for the India market.
 *
 * Design note — why this calls a Python library directly instead of the
 * atilaahmettaner/tradingview-mcp Node server: that MCP's technical-analysis tool
 * is built on `tradingview_ta`, which returns per-symbol indicators only (91 keys,
 * no server-side filtering) — you'd still have to loop over the whole universe
 * yourself and filter client-side. `tradingview_screener` (the library backing
 * its OTHER tool, stock_screener) does the filtering server-side across the whole
 * India market in one call, which is what a screener actually needs. Verified for
 * India (5,342 NSE/BSE rows, 'india' market code) before choosing this. See
 * scripts/tv_screen_query.py for the query itself; this file just spawns it,
 * parses the result, and persists it — no separate MCP process to run.
 *
 * This is a LIVE snapshot, not point-in-time: SMA/RSI/ADX/MACD are computed by
 * TradingView as of the moment of the call. Re-running later returns different
 * numbers for the same date. Fine for "what looks good right now," not valid
 * input to a backtest — for that, keep using lib/indicators.ts against
 * ohlc_daily, which IS point-in-time.
 *
 * Every technical concept here is independent from lib/verdict.ts's local
 * Golden-Cross + Donchian + volume-surge pack — this is a second, broader lens
 * (adds RSI band, ADX trend strength, MACD, TradingView's own composite
 * Recommend.All rating) over the SAME kind of signal, not a fundamentals check.
 * Nothing here reads or writes `analysis`, `fundamentals`, or `signals`.
 *
 * Env (see scripts/tv_screen_query.py for the full filter list + defaults):
 *   PORTFOLIO_DB_PATH=./data/portfolio.db
 *   PYTHON_BIN=python3                 override the interpreter
 *   TV_RSI_MIN / TV_RSI_MAX            RSI band (default 45..70)
 *   TV_REQUIRE_GOLDEN_CROSS=1|0        close > SMA200 AND SMA50 > SMA200 (default on)
 *   TV_REQUIRE_MACD_BULL=1|0           MACD.macd > MACD.signal (default on)
 *   TV_MIN_REL_VOLUME                 relative_volume_10d floor (default 1.2)
 *   TV_MIN_MARKET_CAP_CR              market cap floor, INR crore (default 5000)
 *   TV_MIN_ADX                        trend-strength floor (default 0 = off)
 *   TV_TOP_N                          rows to keep, ranked by Recommend.All (default 30)
 */

const PYTHON_BIN = process.env.PYTHON_BIN ?? "python3";

function istDate(now = Date.now()): string {
  return new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);
}

interface TvRow {
  symbol: string;
  exchange: string;
  close: number | null;
  volume: number | null;
  market_cap_basic: number | null;
  sector: string | null;
  rsi: number | null;
  adx: number | null;
  adx_plus_di: number | null;
  adx_minus_di: number | null;
  macd: number | null;
  macd_signal: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  relative_volume_10d: number | null;
  perf_1m: number | null;
  perf_3m: number | null;
  perf_6m: number | null;
  recommend_all: number | null;
}

interface QueryOutput {
  status: "ok" | "error";
  message?: string;
  total_matched?: number;
  returned?: number;
  filters?: Record<string, number | boolean>;
  rows?: TvRow[];
}

function runQuery(): QueryOutput {
  // Filter env vars are read by the Python side; forward the whole environment
  // rather than allowlisting so a new TV_* knob never needs a matching change here.
  const res = spawnSync(PYTHON_BIN, ["scripts/tv_screen_query.py"], {
    encoding: "utf8",
    env: process.env,
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error) {
    return { status: "error", message: `cannot spawn ${PYTHON_BIN}: ${res.error.message}` };
  }
  const lastLine = (res.stdout ?? "").trim().split("\n").filter(Boolean).pop() ?? "";
  try {
    return JSON.parse(lastLine) as QueryOutput;
  } catch {
    return {
      status: "error",
      message: `no parseable JSON from tv_screen_query.py: ${(res.stderr || res.stdout || "").slice(0, 500)}`,
    };
  }
}

function queryHash(filters: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(filters)).digest("hex").slice(0, 16);
}

function main(): void {
  const dbPath = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";
  const runDate = istDate();
  const runTs = new Date().toISOString();

  const result = runQuery();
  if (result.status === "error" || !result.rows) {
    process.stdout.write(JSON.stringify({ status: "error", message: result.message }) + "\n");
    process.exit(1);
    return;
  }

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync("db/schema.sql", "utf8"));

  const hash = queryHash(result.filters ?? {});
  const upsert = db.prepare(
    `INSERT INTO tv_screen_cache(query_hash, run_date, run_ts, symbol, rank, metrics)
     VALUES(@query_hash, @run_date, @run_ts, @symbol, @rank, @metrics)
     ON CONFLICT(query_hash, run_date, symbol) DO UPDATE SET
       run_ts=excluded.run_ts, rank=excluded.rank, metrics=excluded.metrics`,
  );
  const tx = db.transaction((rows: TvRow[]) => {
    rows.forEach((r, i) => {
      upsert.run({
        query_hash: hash,
        run_date: runDate,
        run_ts: runTs,
        symbol: r.symbol,
        rank: i + 1,
        metrics: JSON.stringify(r),
      });
    });
  });
  tx(result.rows);
  db.close();

  process.stdout.write(
    JSON.stringify(
      {
        status: "ok",
        run_date: runDate,
        query_hash: hash,
        universe_matched: result.total_matched,
        returned: result.returned,
        filters: result.filters,
        symbols: result.rows.map((r) => ({
          symbol: r.symbol,
          close: r.close,
          sector: r.sector,
          rsi: r.rsi !== null ? Number(r.rsi.toFixed(1)) : null,
          adx: r.adx !== null ? Number(r.adx.toFixed(1)) : null,
          macd_bull: r.macd !== null && r.macd_signal !== null ? r.macd > r.macd_signal : null,
          rel_volume_10d: r.relative_volume_10d !== null ? Number(r.relative_volume_10d.toFixed(2)) : null,
          perf_1m_pct: r.perf_1m !== null ? Number(r.perf_1m.toFixed(1)) : null,
          recommend_all: r.recommend_all !== null ? Number(r.recommend_all.toFixed(2)) : null,
        })),
      },
      null,
      2,
    ) + "\n",
  );
}

try {
  main();
} catch (err) {
  process.stdout.write(
    JSON.stringify({ status: "error", message: err instanceof Error ? err.message : String(err) }) + "\n",
  );
  process.exit(1);
}
