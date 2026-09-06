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

/**
 * Every snapshot date and its symbol set, loaded once.
 *
 * `loadUniverseAsOf` issues two queries per call, which is fine for a page
 * request but not for a backtest that asks "who was in the universe?" on every
 * one of ~900 trading days. A backtest loads this once and then resolves
 * membership in memory via `eligibleSymbolsAsOf`.
 */
export interface UniverseTimeline {
  /** Snapshot dates, ascending. Empty when the table has never been populated. */
  dates: string[];
  symbolsByDate: Map<string, Set<string>>;
  first_date: string | null;
  last_date: string | null;
}

export function loadUniverseTimeline(db: Database.Database): UniverseTimeline {
  const rows = db
    .prepare(
      `SELECT snapshot_date, symbol FROM universe_snapshot ORDER BY snapshot_date ASC`,
    )
    .all() as { snapshot_date: string; symbol: string }[];

  const symbolsByDate = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = symbolsByDate.get(r.snapshot_date);
    if (set) set.add(r.symbol);
    else symbolsByDate.set(r.snapshot_date, new Set([r.symbol]));
  }
  const dates = [...symbolsByDate.keys()].sort();
  return {
    dates,
    symbolsByDate,
    first_date: dates[0] ?? null,
    last_date: dates[dates.length - 1] ?? null,
  };
}

/**
 * Symbols in the universe as of `date` — the latest snapshot on or before it,
 * matching `loadUniverseAsOf`'s carry-forward semantics. Null when no snapshot
 * precedes `date`, which callers must distinguish from "an empty universe":
 * the first means "we have no idea", the second means "nothing qualified".
 */
export function eligibleSymbolsAsOf(
  timeline: UniverseTimeline,
  date: string,
): Set<string> | null {
  let found: string | null = null;
  for (const d of timeline.dates) {
    if (d <= date) found = d;
    else break;
  }
  return found === null ? null : (timeline.symbolsByDate.get(found) ?? null);
}

