import Database from "better-sqlite3";
import { fetchBulkDealsCsv, toNseDateParam } from "../lib/nse-bulk-deals";
import { parseBulkDealsCsv, upsertBulkDeals } from "../lib/bulk-deals-csv";

/**
 * Daily refresh of the bulk_deals table straight from NSE. Designed to be run
 * unattended by cron (scripts/cron/refresh-bulk-deals.sh) after the bulk-deal
 * report is published, which is well after the 15:30 IST close — empirically
 * around 18:00-19:00 IST.
 *
 * Deliberately fetches a trailing WINDOW, not just today:
 *   - A single-day fetch permanently loses a day whenever the job doesn't run
 *     (box asleep, network blip, NSE 5xx) — nothing would ever backfill it.
 *   - Re-fetching is free to correct for: the table's
 *     UNIQUE(deal_date, symbol, client_name, side, quantity, price) plus
 *     ON CONFLICT DO NOTHING makes overlapping windows idempotent.
 *   - It also picks up NSE's own late additions/corrections to a prior day,
 *     which do happen.
 * The default 7 days therefore tolerates a nearly week-long outage with zero
 * intervention; widen LOOKBACK_DAYS after a longer gap (the API caps at 365).
 *
 * Env:
 *   PORTFOLIO_DB_PATH  default ./data/portfolio.db
 *   LOOKBACK_DAYS      default 7
 *
 * Usage: PORTFOLIO_DB_PATH=./data/portfolio.db npx tsx scripts/refresh-bulk-deals.ts
 */

const DB_PATH = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? "7") || 7;
const MAX_LOOKBACK_DAYS = 365; // NSE's per-call cap

async function main() {
  if (LOOKBACK_DAYS > MAX_LOOKBACK_DAYS) {
    console.error(`LOOKBACK_DAYS=${LOOKBACK_DAYS} exceeds NSE's ${MAX_LOOKBACK_DAYS}-day per-call cap; use scripts/ingest-bulk-deals.ts for a longer backfill.`);
    process.exit(1);
  }

  const to = new Date();
  const from = new Date(to.getTime() - LOOKBACK_DAYS * 86_400_000);
  const fromParam = toNseDateParam(from);
  const toParam = toNseDateParam(to);

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  const before = db.prepare("SELECT COUNT(*) n, MAX(deal_date) mx FROM bulk_deals").get() as {
    n: number;
    mx: string | null;
  };

  let res;
  try {
    const csv = await fetchBulkDealsCsv(fromParam, toParam);
    const rows = parseBulkDealsCsv(csv);
    res = upsertBulkDeals(db, rows);
  } catch (e) {
    // Exit non-zero so the cron wrapper's log makes a failed run obvious
    // instead of it reading like a legitimate zero-deal day.
    console.error(JSON.stringify({
      status: "error",
      window: `${fromParam}..${toParam}`,
      message: e instanceof Error ? e.message : String(e),
    }, null, 2));
    db.close();
    process.exit(1);
  }

  const after = db.prepare("SELECT COUNT(*) n, MAX(deal_date) mx FROM bulk_deals").get() as {
    n: number;
    mx: string | null;
  };

  console.log(JSON.stringify({
    status: "ok",
    ran_at: new Date().toISOString(),
    window: `${fromParam}..${toParam}`,
    lookback_days: LOOKBACK_DAYS,
    rows_fetched: res.rows_seen,
    rows_inserted: res.rows_inserted,
    rows_skipped_incomplete: res.rows_skipped_incomplete,
    latest_deal_date_before: before.mx,
    latest_deal_date_after: after.mx,
    total_rows_before: before.n,
    total_rows_after: after.n,
  }, null, 2));
  db.close();
}

main();
