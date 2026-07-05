import type Database from "better-sqlite3";
import type { Exchange, StockMetaRow, PortfolioSummaryRow } from "@/lib/types";

/**
 * A single holding row for a snapshot. Money values are ALREADY in minor units:
 *   avg_price   -> price units (rupees x 10000)
 *   ltp         -> paise       (rupees x 100)
 *   close_price -> paise       (rupees x 100)
 * (user_id / snapshot_date are supplied at the payload level, not per-holding.)
 */
export interface SnapshotHolding {
  symbol: string;
  exchange: Exchange;
  qty: number;
  avg_price: number;
  ltp: number;
  close_price: number;
}

/** Portfolio-level totals for the snapshot (paise, except the counters). */
export type SnapshotTotals = Omit<
  PortfolioSummaryRow,
  "user_id" | "snapshot_date"
>;

export interface SnapshotPayload {
  userId: string;
  snapshotDate: string; // YYYY-MM-DD (IST)
  meta: StockMetaRow[];
  holdings: SnapshotHolding[];
  totals: SnapshotTotals;
}

/**
 * Idempotently persist one day's snapshot. Everything happens inside a single
 * db.transaction() so a partial failure rolls back cleanly. Writes in FK order:
 * stock_meta (parent) -> holding_snapshots -> portfolio_snapshots. Each statement
 * upserts via INSERT ... ON CONFLICT(<unique>) DO UPDATE using the exact unique
 * constraints from db/schema.sql, so re-running for the same day overwrites the
 * existing rows instead of duplicating them.
 */
export function writeSnapshot(db: Database.Database, p: SnapshotPayload): void {
  const meta = db.prepare(
    `INSERT INTO stock_meta(symbol,exchange,isin,company,sector)
     VALUES(@symbol,@exchange,@isin,@company,@sector)
     ON CONFLICT(symbol,exchange) DO UPDATE SET
       isin=excluded.isin, company=excluded.company, sector=excluded.sector`,
  );

  const hs = db.prepare(
    `INSERT INTO holding_snapshots(user_id,snapshot_date,symbol,exchange,qty,avg_price,ltp,close_price)
     VALUES(@user_id,@snapshot_date,@symbol,@exchange,@qty,@avg_price,@ltp,@close_price)
     ON CONFLICT(user_id,snapshot_date,symbol,exchange) DO UPDATE SET
       qty=excluded.qty, avg_price=excluded.avg_price,
       ltp=excluded.ltp, close_price=excluded.close_price`,
  );

  const ps = db.prepare(
    `INSERT INTO portfolio_snapshots(user_id,snapshot_date,current_value,invested,total_pnl,day_pnl,holdings_count,winners,losers)
     VALUES(@user_id,@snapshot_date,@current_value,@invested,@total_pnl,@day_pnl,@holdings_count,@winners,@losers)
     ON CONFLICT(user_id,snapshot_date) DO UPDATE SET
       current_value=excluded.current_value, invested=excluded.invested,
       total_pnl=excluded.total_pnl, day_pnl=excluded.day_pnl,
       holdings_count=excluded.holdings_count, winners=excluded.winners, losers=excluded.losers`,
  );

  const tx = db.transaction(() => {
    for (const m of p.meta) {
      meta.run({
        symbol: m.symbol,
        exchange: m.exchange,
        isin: m.isin ?? null,
        company: m.company ?? null,
        sector: m.sector ?? null,
      });
    }
    for (const h of p.holdings) {
      hs.run({ ...h, user_id: p.userId, snapshot_date: p.snapshotDate });
    }
    ps.run({ ...p.totals, user_id: p.userId, snapshot_date: p.snapshotDate });
  });

  tx();
}
