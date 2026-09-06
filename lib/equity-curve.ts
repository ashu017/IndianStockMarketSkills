import type { EquityPoint } from "./metrics";

/**
 * Turns a set of backtest trades into a daily portfolio equity curve.
 *
 * WHY A CONVENTION IS NEEDED. lib/backtest.ts caps NEW ENTRIES at 5 per day but
 * holds each trade for up to 60 bars, so concurrent open positions can reach
 * the low hundreds. That is fine for measuring a signal's trade-level edge —
 * which is all that engine ever claimed to measure — but it is not a portfolio
 * anyone could fund, and volatility, drawdown and Sharpe are all portfolio-level
 * quantities. So a weighting rule has to be stated rather than assumed:
 *
 *   Each open position is weighted 1 / max(openPositions, SLOTS).
 *
 * With SLOTS notional slots (default 20) and fewer than that open, each holds
 * 1/SLOTS of capital and the remainder sits in cash. Above SLOTS open, the
 * positions dilute each other to 1/openPositions and the book is fully invested.
 * Consequences, deliberate:
 *   - Never levered: weights sum to at most 1.
 *   - No trade is ever dropped, so the curve describes the SAME trade
 *     population the trade-level statistics describe. (The alternative — a hard
 *     slot cap that rejects signals — changes which trades exist and would make
 *     the two sets of numbers disagree.)
 *   - Idle cash earns 0, not the risk-free rate. Under-deployed strategies are
 *     therefore penalized slightly relative to a real account earning liquid-fund
 *     interest on the cash leg.
 *
 * MARKING. Returns accrue on every day AFTER entry through the exit day
 * inclusive (entry executes at the signal bar's own close, matching
 * lib/verdict.ts's convention). The exit day is marked at the trade's actual
 * exit price — the stop or target level, not that day's close — and carries the
 * full round-trip cost, so a single-position curve reproduces that trade's net
 * return exactly.
 */

/** Minimal trade shape — deliberately not lib/backtest.ts's BacktestTrade, so
 *  the overnight engine and any future strategy can reuse this. */
export interface CurveTrade {
  symbol: string;
  entry_date: string;
  exit_date: string;
  exit_paise: number;
}

export interface CurveBar {
  trade_date: string;
  close: number;
}

export interface EquityCurveResult {
  curve: EquityPoint[];
  /** Days with at least one position held — feeds exposure_time_pct. */
  periods_in_market: number;
  /** Peak simultaneous holdings. When this exceeds `slots`, the dilution branch
   *  of the weighting rule was active and the figure is worth surfacing. */
  max_concurrent_positions: number;
  slots: number;
  starting_rupees: number;
  /** Days a held symbol had no bar (exchange gap, missing backfill) and was
   *  therefore carried unmarked at the prior value. */
  unmarked_position_days: number;
}

export const DEFAULT_EQUITY_SLOTS = 20;
export const DEFAULT_STARTING_RUPEES = 100_000;

/** Index of the first element >= target, or -1. Dates are sorted ascending. */
function firstAtOrAfter(dates: string[], target: string): number {
  for (let i = 0; i < dates.length; i++) if (dates[i] >= target) return i;
  return -1;
}

/** Index of the last element <= target, or -1. */
function lastAtOrBefore(dates: string[], target: string): number {
  for (let i = dates.length - 1; i >= 0; i--) if (dates[i] <= target) return i;
  return -1;
}

export function buildEquityCurve(opts: {
  trades: CurveTrade[];
  /** ReadonlyMap of a readonly array, so callers can pass a richer bar type
   *  (lib/backtest.ts's Bar, with open/high/low/volume) without a cast — a
   *  mutable Map<string, Bar[]> is not assignable to Map<string, CurveBar[]>. */
  barsBySymbol: ReadonlyMap<string, readonly CurveBar[]>;
  /** All trading dates, ascending — the portfolio's time axis. */
  tradingDates: string[];
  costBpsRoundtrip: number;
  slots?: number;
  startingRupees?: number;
}): EquityCurveResult | null {
  const slots = opts.slots ?? DEFAULT_EQUITY_SLOTS;
  const startingRupees = opts.startingRupees ?? DEFAULT_STARTING_RUPEES;
  if (opts.trades.length === 0 || opts.tradingDates.length === 0) return null;

  // Per-symbol close series with a date index, so a day's mark is O(1).
  const series = new Map<string, { closes: number[]; idxByDate: Map<string, number> }>();
  for (const [symbol, bars] of opts.barsBySymbol) {
    const idxByDate = new Map<string, number>();
    for (let i = 0; i < bars.length; i++) idxByDate.set(bars[i].trade_date, i);
    series.set(symbol, { closes: bars.map((b) => b.close), idxByDate });
  }

  const entriesByDate = new Map<string, CurveTrade[]>();
  let firstEntry = opts.trades[0].entry_date;
  let lastExit = opts.trades[0].exit_date;
  for (const t of opts.trades) {
    const arr = entriesByDate.get(t.entry_date);
    if (arr) arr.push(t);
    else entriesByDate.set(t.entry_date, [t]);
    if (t.entry_date < firstEntry) firstEntry = t.entry_date;
    if (t.exit_date > lastExit) lastExit = t.exit_date;
  }

  const startIdx = firstAtOrAfter(opts.tradingDates, firstEntry);
  const endIdx = lastAtOrBefore(opts.tradingDates, lastExit);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return null;

  const costFrac = opts.costBpsRoundtrip / 10_000;
  let equity = startingRupees;
  let open: CurveTrade[] = [];
  const curve: EquityPoint[] = [];
  let periodsInMarket = 0;
  let maxConcurrent = 0;
  let unmarked = 0;

  for (let i = startIdx; i <= endIdx; i++) {
    const d = opts.tradingDates[i];

    // Weight is set by what was held THROUGH this day, i.e. before today's
    // entries (which execute at today's close and so earn nothing today).
    const nOpen = open.length;
    if (nOpen > maxConcurrent) maxConcurrent = nOpen;
    if (nOpen > 0) periodsInMarket++;
    const weight = nOpen > 0 ? 1 / Math.max(nOpen, slots) : 0;

    let dayReturn = 0;
    const stillOpen: CurveTrade[] = [];
    for (const t of open) {
      const isExit = t.exit_date === d;
      const s = series.get(t.symbol);
      const idx = s?.idxByDate.get(d);
      if (!s || idx === undefined || idx === 0 || s.closes[idx - 1] <= 0) {
        // No usable bar today — carry the position unmarked rather than
        // inventing a return.
        unmarked++;
        if (!isExit) stillOpen.push(t);
        continue;
      }
      const prevClose = s.closes[idx - 1];
      const r = isExit
        ? (t.exit_paise / prevClose) * (1 - costFrac) - 1
        : s.closes[idx] / prevClose - 1;
      dayReturn += weight * r;
      if (!isExit) stillOpen.push(t);
    }

    equity *= 1 + dayReturn;
    curve.push({ date: d, value_rupees: equity });
    open = stillOpen;
    for (const t of entriesByDate.get(d) ?? []) open.push(t);
  }

  return {
    curve,
    periods_in_market: periodsInMarket,
    max_concurrent_positions: maxConcurrent,
    slots,
    starting_rupees: startingRupees,
    unmarked_position_days: unmarked,
  };
}

