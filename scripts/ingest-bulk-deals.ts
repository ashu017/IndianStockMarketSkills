import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseBulkDealsCsv, upsertBulkDeals } from "../lib/bulk-deals-csv";

/**
 * Backfill entry point: ingests already-downloaded NSE bulk-deals CSVs from a
 * directory. Used for the original multi-year backfill (NSE's export API caps
 * each call at 365 days, so a long history is several files).
 *
 * For keeping the table current day to day, use scripts/refresh-bulk-deals.ts
 * instead — it fetches from NSE itself. Both share the parser and upsert in
 * lib/bulk-deals-csv.ts, so a CSV quirk fixed in one is fixed for both.
 *
 * Usage: PORTFOLIO_DB_PATH=./data/portfolio.db npx tsx scripts/ingest-bulk-deals.ts <dir-of-csvs>
 */

const DB_PATH = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";

function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error("Usage: npx tsx scripts/ingest-bulk-deals.ts <dir-of-csvs>");
    process.exit(1);
  }
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  const files = readdirSync(dir).filter((f) => f.endsWith(".csv"));
  let totalRows = 0, totalInserted = 0, totalSkipped = 0;

  for (const f of files) {
    const rows = parseBulkDealsCsv(readFileSync(join(dir, f), "utf-8"));
    const res = upsertBulkDeals(db, rows);
    console.error(`${f}: ${res.rows_seen} rows parsed, ${res.rows_inserted} new`);
    totalRows += res.rows_seen;
    totalInserted += res.rows_inserted;
    totalSkipped += res.rows_skipped_incomplete;
  }

  const instCount = (db.prepare("SELECT COUNT(*) n FROM bulk_deals WHERE is_institution=1").get() as { n: number }).n;
  const totalCount = (db.prepare("SELECT COUNT(*) n FROM bulk_deals").get() as { n: number }).n;
  console.log(JSON.stringify({
    files: files.length,
    rows_parsed: totalRows,
    rows_inserted_this_run: totalInserted,
    rows_skipped_incomplete: totalSkipped,
    total_rows_in_table: totalCount,
    institutional_rows_in_table: instCount,
  }, null, 2));
  db.close();
}

main();
