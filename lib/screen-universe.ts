import type Database from "better-sqlite3";

/**
 * One scannable stock: the price/sector context the scanner needs, resolved from
 * `index_universe`. See `db/schema.sql` for storage details.
 */
export type ScreenUniverseRow = {
  symbol: string;
  exchange: string;
  isin: string;
  instrument_token: number;
  sector: string | null;
};

/**
 * Resolve a Screener-screen symbol list into scannable universe rows.
 *
 * Screener tells us WHICH stocks pass the quality gate but nothing about price,
 * so each symbol is joined to `index_universe` for OHLC and sector context. A
 * symbol with no row there is dropped: we have no bars for it.
 *
 * The subtlety this function exists for: `index_universe` is keyed
 * `(index_name, symbol, exchange)` — one row PER INDEX MEMBERSHIP. A stock in
 * both `NIFTY 500` and `NSE-ALL` therefore has two rows, and they disagree on
 * the columns we select: the `NSE-ALL` row carries a placeholder `SYM-<symbol>`
 * isin and an empty sector. `SELECT DISTINCT` cannot collapse rows that differ,
 * so a naive query returns the stock twice and the scanner scans it twice —
 * emitting the signal twice and padding the momentum ranking pool with
 * phantoms. (Observed 2026-09-01: 38 screened symbols became 61 rows.)
 *
 * So rows are ordered richest-first and one is kept per `(symbol, exchange)` —
 * the key the rest of the pipeline uses. Preferring a non-empty sector is not
 * cosmetic: with `SECTOR_DEMEAN=1` the scanner demeans momentum within sector,
 * and the `NSE-ALL` row would silently contribute a sectorless stock.
 */
export function loadScreenUniverse(
  db: Database.Database,
  symbols: string[],
): ScreenUniverseRow[] {
  if (symbols.length === 0) return [];
  const placeholders = symbols.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT symbol, exchange, isin, instrument_token, sector
         FROM index_universe
        WHERE symbol IN (${placeholders})
        ORDER BY symbol,
                 CASE WHEN sector IS NOT NULL AND sector != '' THEN 0 ELSE 1 END,
                 CASE WHEN isin LIKE 'SYM-%' THEN 1 ELSE 0 END`,
    )
    .all(...symbols) as ScreenUniverseRow[];

  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = `${r.symbol}|${r.exchange}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
