import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { refreshLiveQuotes } from "../lib/live-quotes";

/**
 * Refresh intraday LTPs for the whole index universe from NSE's public NextApi.
 *
 * The fetching, the concurrency pool and the ohlc_intraday upsert all live in
 * lib/live-quotes.ts, because app/api/quotes/route.ts refreshes the same table
 * on demand when a strategy page is opened. Two implementations of "what is
 * this stock worth now" would drift, and the one that drifted would be the one
 * nobody was watching. This script is the whole-universe caller; the route is
 * the few-symbols caller.
 *
 * Env:
 *   PORTFOLIO_DB_PATH=./data/portfolio.db
 *   INDEX_NAME       optional; restrict to one index (default: all universe)
 *   ONLY_SYMBOLS     comma-separated for testing
 *   CONCURRENCY      default 4
 *   REQUEST_DELAY_MS default 200 (between requests, per concurrent slot)
 */

async function main(): Promise<void> {
  const dbPath = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";
  const onlySymbols = process.env.ONLY_SYMBOLS
    ? process.env.ONLY_SYMBOLS.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync("db/schema.sql", "utf8"));

  const res = await refreshLiveQuotes(db, {
    symbols: onlySymbols,
    indexName: process.env.INDEX_NAME ?? null,
    concurrency: Number(process.env.CONCURRENCY ?? "4"),
    requestDelayMs: Number(process.env.REQUEST_DELAY_MS ?? "200"),
    // The cron is the thing that makes the table fresh in the first place, so it
    // never reuses an existing row, and it takes the free peer coverage.
    reuseWithinSeconds: 0,
    opportunisticPeers: true,
  });

  const total = (
    db
      .prepare(`SELECT COUNT(*) as n FROM ohlc_intraday WHERE quote_date = ?`)
      .get(res.quote_date) as { n: number }
  ).n;
  db.close();

  process.stdout.write(
    JSON.stringify({
      status: "ok",
      quote_date: res.quote_date,
      requested: res.requested,
      fetched: res.fetched,
      opportunistic_peers: res.opportunistic_peers,
      failed: res.failed,
      total_intraday_rows_today: total,
    }) + "\n",
  );
}

main().catch((err) => {
  process.stdout.write(
    JSON.stringify({ status: "error", message: err instanceof Error ? err.message : String(err) }) + "\n",
  );
  process.exit(1);
});
