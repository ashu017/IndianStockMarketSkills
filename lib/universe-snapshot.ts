import type Database from "better-sqlite3";

/**
 * A single row from the point-in-time universe snapshot.
 *
 * See `db/schema.sql` (table `universe_snapshot`) for storage details. Boolean
 * `in_screener` is projected from the underlying INTEGER 0/1 column so callers
 * don't have to remember the SQLite convention.
 */
export type UniverseSnapshotRow = {
  symbol: string;
  exchange: string;
  isin: string | null;
  sector: string | null;
  index_name: string | null;
  in_screener: boolean;
  mcap_rs_cr: number | null;
};

type RawRow = {
  symbol: string;
  exchange: string;
  isin: string | null;
  sector: string | null;
  index_name: string | null;
  in_screener: number;
  mcap_rs_cr: number | null;
};

/**
 * Load the point-in-time scanner universe as of `date` (IST YYYY-MM-DD).
 *
 * If an exact snapshot for `date` exists, its rows are returned. Otherwise the
 * closest PRIOR snapshot date is used — this matches how a walk-forward backtest
 * would query "what was in the universe when this bar closed?". If no snapshot
 * on or before `date` exists, returns an empty array.
 */
export function loadUniverseAsOf(
  db: Database.Database,
  date: string,
): UniverseSnapshotRow[] {
  const priorDate = db
    .prepare(
      `SELECT snapshot_date
         FROM universe_snapshot
        WHERE snapshot_date <= ?
        ORDER BY snapshot_date DESC
        LIMIT 1`,
    )
    .pluck()
    .get(date) as string | undefined;

  if (!priorDate) return [];

  const rows = db
    .prepare(
      `SELECT symbol, exchange, isin, sector, index_name, in_screener, mcap_rs_cr
         FROM universe_snapshot
        WHERE snapshot_date = ?
        ORDER BY symbol, exchange`,
    )
    .all(priorDate) as RawRow[];

  return rows.map((r) => ({
    symbol: r.symbol,
    exchange: r.exchange,
    isin: r.isin,
    sector: r.sector,
    index_name: r.index_name,
    in_screener: r.in_screener === 1,
    mcap_rs_cr: r.mcap_rs_cr,
  }));
}
