import "server-only";
import { getDb } from "./connection";
import type {
  HoldingRow,
  PortfolioSummaryRow,
  FundamentalsRow,
  FundamentalsExtraRow,
  PeerRow,
  AnalysisRow,
  StockMetaRow,
  Range,
} from "../types";

// range → inclusive start date (YYYY-MM-DD). ALL returns a floor date.
function startDateFor(range: Range): string {
  if (range === "ALL") return "0000-00-00";
  const days: Record<Exclude<Range, "ALL">, number> = {
    "1M": 30,
    "3M": 91,
    "6M": 182,
    "1Y": 365,
  };
  const d = new Date(Date.now() - days[range] * 86400000);
  return d.toISOString().slice(0, 10);
}

// ---- Reads: user-scoped (userId always required) ----

export async function getHoldings(userId: string): Promise<HoldingRow[]> {
  return getDb()
    .prepare(
      `SELECT v.user_id, v.snapshot_date, v.symbol, v.exchange, v.qty, v.avg_price, v.ltp, v.close_price,
              m.company, m.sector, m.isin
       FROM v_holdings_current v
       JOIN stock_meta m ON m.symbol = v.symbol AND m.exchange = v.exchange
       WHERE v.user_id = ?`,
    )
    .all(userId) as HoldingRow[];
}

export async function getPortfolioSummary(
  userId: string,
): Promise<PortfolioSummaryRow | null> {
  return (
    (getDb()
      .prepare(
        `SELECT * FROM portfolio_snapshots WHERE user_id = ? ORDER BY snapshot_date DESC LIMIT 1`,
      )
      .get(userId) as PortfolioSummaryRow | undefined) ?? null
  );
}

export async function getPortfolioHistory(
  userId: string,
  range: Range,
): Promise<PortfolioSummaryRow[]> {
  return getDb()
    .prepare(
      `SELECT * FROM portfolio_snapshots WHERE user_id = ? AND snapshot_date >= ? ORDER BY snapshot_date`,
    )
    .all(userId, startDateFor(range)) as PortfolioSummaryRow[];
}

export async function getHolding(
  userId: string,
  symbol: string,
  exchange: string,
): Promise<HoldingRow | null> {
  return (
    (getDb()
      .prepare(
        `SELECT v.user_id, v.snapshot_date, v.symbol, v.exchange, v.qty, v.avg_price, v.ltp, v.close_price,
                m.company, m.sector, m.isin
         FROM v_holdings_current v
         JOIN stock_meta m ON m.symbol = v.symbol AND m.exchange = v.exchange
         WHERE v.user_id = ? AND v.symbol = ? AND v.exchange = ?`,
      )
      .get(userId, symbol, exchange) as HoldingRow | undefined) ?? null
  );
}

export async function getHoldingHistory(
  userId: string,
  symbol: string,
  exchange: string,
  range: Range,
): Promise<HoldingRow[]> {
  return getDb()
    .prepare(
      `SELECT * FROM holding_snapshots
       WHERE user_id = ? AND symbol = ? AND exchange = ? AND snapshot_date >= ?
       ORDER BY snapshot_date`,
    )
    .all(userId, symbol, exchange, startDateFor(range)) as HoldingRow[];
}

// ---- Reads: global reference (no userId) ----

export async function getFundamentals(
  isin: string,
): Promise<{ core: FundamentalsRow | null; extra: FundamentalsExtraRow[] }> {
  const db = getDb();
  const core =
    (db
      .prepare(
        `SELECT * FROM fundamentals WHERE isin = ? ORDER BY as_of_date DESC LIMIT 1`,
      )
      .get(isin) as FundamentalsRow | undefined) ?? null;
  const extra = db
    .prepare(
      `SELECT * FROM fundamentals_extra WHERE isin = ? ORDER BY as_of_date DESC`,
    )
    .all(isin) as FundamentalsExtraRow[];
  return { core, extra };
}

export async function getPeers(isin: string): Promise<PeerRow[]> {
  return getDb()
    .prepare(`SELECT * FROM peers WHERE isin = ? ORDER BY as_of_date DESC`)
    .all(isin) as PeerRow[];
}

export async function getAnalysis(isin: string): Promise<AnalysisRow | null> {
  return (
    (getDb()
      .prepare(`SELECT * FROM analysis WHERE isin = ?`)
      .get(isin) as AnalysisRow | undefined) ?? null
  );
}

export async function getStockMeta(
  symbol: string,
  exchange: string,
): Promise<StockMetaRow | null> {
  return (
    (getDb()
      .prepare(`SELECT * FROM stock_meta WHERE symbol = ? AND exchange = ?`)
      .get(symbol, exchange) as StockMetaRow | undefined) ?? null
  );
}
