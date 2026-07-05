import type { HoldingRow, Holding } from "./types";
import { deriveHolding } from "./derive";
import { paiseToRupees } from "./money";

// Total current portfolio value (rupees) from raw holding rows — used for weight.
export function totalCurrentRupees(rows: HoldingRow[]): number {
  return rows.reduce((sum, r) => sum + r.qty * paiseToRupees(r.ltp), 0);
}

export function toHolding(r: HoldingRow, totalRupees: number): Holding {
  const d = deriveHolding(r, totalRupees);
  return {
    symbol: r.symbol,
    company: r.company ?? r.symbol,
    exchange: r.exchange,
    sector: r.sector ?? "",
    qty: r.qty,
    avgPrice: d.avgPrice,
    ltp: d.ltp,
    dayChangePct: d.dayChangePct,
    invested: d.invested,
    current: d.current,
    pnl: d.pnl,
    pnlPct: d.pnlPct,
    dayPnl: d.dayPnl,
    weight: d.weight,
  };
}

export function toHoldings(rows: HoldingRow[]): Holding[] {
  const total = totalCurrentRupees(rows);
  return rows.map((r) => toHolding(r, total));
}
