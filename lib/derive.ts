import { paiseToRupees, priceToRupees } from "./money";

export interface RawHolding {
  qty: number;
  avg_price: number; // ×10000
  ltp: number; // paise
  close_price: number; // paise
}

export interface DerivedHolding {
  invested: number;
  current: number;
  pnl: number;
  pnlPct: number;
  dayChangePct: number;
  dayPnl: number;
  weight: number;
  avgPrice: number;
  ltp: number;
}

// All P&L math lives here, operating on minor units → rupees. `totalCurrentRupees`
// is the portfolio's total current value (rupees) used for the portfolio-relative
// weight, which is never stored.
export function deriveHolding(
  r: RawHolding,
  totalCurrentRupees: number,
): DerivedHolding {
  const avg = priceToRupees(r.avg_price);
  const ltp = paiseToRupees(r.ltp);
  const close = paiseToRupees(r.close_price);
  const invested = r.qty * avg;
  const current = r.qty * ltp;
  const pnl = current - invested;
  const pnlPct = invested ? (pnl / invested) * 100 : 0;
  const dayChangePct = close ? ((ltp - close) / close) * 100 : 0;
  const dayPnl = r.qty * (ltp - close);
  const weight = totalCurrentRupees ? (current / totalCurrentRupees) * 100 : 0;
  return { invested, current, pnl, pnlPct, dayChangePct, dayPnl, weight, avgPrice: avg, ltp };
}
