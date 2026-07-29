import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Point-in-time snapshot of the scanner universe.
 *
 * Merges `index_universe` (Nifty 500 + ad-hoc Screener-seeded stocks) with the
 * latest `screener_screen_cache` run for today, and upserts one row per
 * (symbol, exchange) into `universe_snapshot`. Re-running on the same IST date
 * is idempotent (INSERT OR REPLACE on the (snapshot_date, symbol, exchange)
 * primary key).
 *
 * Guards against survivorship bias in walk-forward backtests: without this,
 * a stock delisted or dropped from the ₹5,000 Cr floor in 2023 would be
 * silently missing from any historical "as-of-2023" analysis.
 *
 * Prints one JSON line summary; does NOT throw on empty universe — an empty
 * universe still writes zero rows and returns status "ok".
 */

function istDate(now: number = Date.now()): string {
  return new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);
}

/** Deduplicate rows from `index_universe` by (symbol, exchange). Prefer the
 *  entry with a non-empty sector; on ties, prefer the more specific index
 *  (NIFTY 500 > NIFTY 200 > NIFTY 100 > AD-HOC > NSE-ALL). This mirrors how
 *  the scanner treats the universe: one logical entry per instrument. */
type IndexRow = {
  index_name: string;
  symbol: string;
  exchange: string;
  isin: string | null;
  sector: string | null;
};
function dedupeUniverse(rows: IndexRow[]): Map<string, IndexRow> {
  const rank: Record<string, number> = {
    "NIFTY 500": 5,
    "NIFTY 200": 4,
    "NIFTY 100": 3,
    "AD-HOC": 2,
    "NSE-ALL": 1,
  };
  const chosen = new Map<string, IndexRow>();
  for (const row of rows) {
    const key = `${row.symbol}|${row.exchange}`;
    const prev = chosen.get(key);
    if (!prev) {
      chosen.set(key, row);
      continue;
    }
    // Prefer non-empty sector, then higher-ranked index.
    const prevHasSector = !!(prev.sector && prev.sector.trim().length > 0);
    const rowHasSector = !!(row.sector && row.sector.trim().length > 0);
    if (rowHasSector && !prevHasSector) {
      chosen.set(key, row);
      continue;
    }
    if (rowHasSector === prevHasSector) {
      if ((rank[row.index_name] ?? 0) > (rank[prev.index_name] ?? 0)) {
        chosen.set(key, row);
      }
    }
  }
  return chosen;
}

/** Try to pull a market-cap number (Rs Crore) out of a Screener metrics blob.
 *  Screener returns display strings like "62229.49" for `"Mar Cap Rs.Cr."`. */
function parseMcapRsCr(metricsJson: string | null): number | null {
  if (!metricsJson) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(metricsJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  const candidateKeys = ["mcap_rs_cr", "Mar Cap Rs.Cr.", "Market Cap", "Market Capitalization"];
  for (const key of candidateKeys) {
    const v = parsed[key];
    if (v == null) continue;
    const num = typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, ""));
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function main(): void {
  const dbPath = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";
  const snapshotDate = istDate();

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  // Idempotent — safe on both fresh and already-migrated DBs.
  db.exec(readFileSync("db/schema.sql", "utf8"));

  try {
    // 1. Load the current universe (may be empty on a fresh DB).
    const universeRows = db
      .prepare(
        `SELECT index_name, symbol, exchange, isin, sector
           FROM index_universe`,
      )
      .all() as IndexRow[];
    const universe = dedupeUniverse(universeRows);

    // 2. Load latest Screener passers. `screener_screen_cache` may hold multiple
    //    query_hashes (e.g., different screens); take the most recent run_date
    //    across all of them and union its passers. Ties are broken by run_ts.
    const latestRun = db
      .prepare(
        `SELECT run_date FROM screener_screen_cache
          ORDER BY run_date DESC, run_ts DESC LIMIT 1`,
      )
      .pluck()
      .get() as string | undefined;

    const screenerBySymbol = new Map<string, number | null>();
    if (latestRun) {
      const rows = db
        .prepare(
          `SELECT symbol, metrics FROM screener_screen_cache
            WHERE run_date = ?`,
        )
        .all(latestRun) as { symbol: string; metrics: string | null }[];
      for (const r of rows) {
        screenerBySymbol.set(r.symbol, parseMcapRsCr(r.metrics));
      }
    }

    // 3. Also include Screener passers that are NOT in index_universe — a stock
    //    can pass the Screener screen without being in any NSE index we track
    //    (Screener has broader coverage). Use "NSE" as the default exchange.
    for (const symbol of screenerBySymbol.keys()) {
      const nseKey = `${symbol}|NSE`;
      if (!universe.has(nseKey)) {
        universe.set(nseKey, {
          index_name: "SCREENER",
          symbol,
          exchange: "NSE",
          isin: null,
          sector: null,
        });
      }
    }

    // 4. Upsert one row per (symbol, exchange) into the snapshot.
    const ins = db.prepare(
      `INSERT OR REPLACE INTO universe_snapshot
         (snapshot_date, symbol, exchange, isin, sector, index_name, in_screener, mcap_rs_cr)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let rowsWritten = 0;
    let inScreenerCount = 0;
    const tx = db.transaction((entries: IterableIterator<IndexRow>) => {
      for (const row of entries) {
        const inScreener = screenerBySymbol.has(row.symbol);
        const mcap = inScreener ? (screenerBySymbol.get(row.symbol) ?? null) : null;
        ins.run(
          snapshotDate,
          row.symbol,
          row.exchange,
          row.isin,
          row.sector,
          row.index_name,
          inScreener ? 1 : 0,
          mcap,
        );
        rowsWritten += 1;
        if (inScreener) inScreenerCount += 1;
      }
    });
    tx(universe.values());

    process.stdout.write(
      JSON.stringify({
        status: "ok",
        snapshot_date: snapshotDate,
        rows_written: rowsWritten,
        in_screener_count: inScreenerCount,
      }) + "\n",
    );
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  process.stdout.write(
    JSON.stringify({
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    }) + "\n",
  );
  process.exit(1);
}
