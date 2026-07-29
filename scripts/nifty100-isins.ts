import Database from "better-sqlite3";

/**
 * Emit the current Nifty 100 ISIN list as a compact JSON array on one line.
 * Used to feed the ISINS env var of analysis-status.ts / batch-analyze-fundamentals
 * without needing to know the seed file path from the caller.
 *
 *   ISINS=$(npx tsx scripts/nifty100-isins.ts) npx tsx scripts/analysis-status.ts
 */
function main(): void {
  const dbPath = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";
  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .prepare(`SELECT isin FROM nifty100_universe ORDER BY symbol`)
    .all() as { isin: string }[];
  db.close();
  process.stdout.write(JSON.stringify(rows.map((r) => r.isin)));
}

main();
