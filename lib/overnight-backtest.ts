import type Database from "better-sqlite3";
import {
  computeEquityMetrics,
  toSeries,
  DEFAULT_RISK_FREE_RATE_PCT,
  type EquityMetrics,
  type EquityPoint,
} from "./metrics";
import { benchmarkCaveat, compareToBenchmark, type BenchmarkComparison } from "./benchmark";

/**
 * Overnight close-to-open backtest for a single, user-chosen symbol.
 *
 * Rule (unconditional, every trading day, per the user's own spec):
 *   Buy at today's close. Sell at tomorrow's open. Repeat for every
 *   consecutive trading-day pair in the cached history. No entry filter.
 *
 * Position sizing: compounding. Starts at STARTING_CAPITAL_PAISE; each
 * overnight trade re-invests the FULL current value (whole-share rounding
 * is intentionally skipped here — this models capital efficiency, not literal
 * order execution, since the point is "what would ₹1L have grown into").
 *
 * Caveat modeled explicitly rather than ignored: this app's ohlc_daily is
 * NOT split/bonus-adjusted (see the corporate-actions discussion earlier in
 * this project). A stock split between one day's close and the next day's
 * open would show up as a huge fake "overnight loss" that never actually
 * happened. NSE's circuit-breaker bands mean a GENUINE overnight move can't
 * realistically exceed ~20% for most stocks, so any close-to-open change
 * larger than that is treated as a probable corporate-action artifact and
 * EXCLUDED from the compounding walk (not compounded as a real loss/gain) —
 * counted and reported, not silently dropped.
 */

const STARTING_CAPITAL_PAISE = 100_000 * 100; // ₹1,00,000
const COST_BPS_ROUNDTRIP = 20; // matches lib/backtest.ts's convention
const IMPLAUSIBLE_OVERNIGHT_MOVE_FRAC = 0.20; // beyond this, assume corporate action

interface Bar {
  trade_date: string;
  open: number;
  close: number;
}

export interface OvernightTrade {
  buy_date: string;
  buy_paise: number;
  sell_date: string;
  sell_paise: number;
  return_pct: number; // net of cost, this trade only
  excluded_as_corporate_action: boolean;
}

/** Re-exported (it now lives in lib/metrics.ts, which is where the metric
 *  functions that consume it live) so existing importers keep working. */
export type { EquityPoint };

export interface OvernightBacktestResult {
  symbol: string;
  exchange: string;
  n_trades: number;
  n_excluded_corporate_action: number;
  win_rate_pct: number | null;
  avg_return_pct: number | null;
  median_return_pct: number | null;
  best_trade_pct: number | null;
  worst_trade_pct: number | null;
  profit_factor: number | null;
  starting_value_rupees: number;
  final_value_rupees: number;
  total_return_pct: number;
  first_date: string | null;
  last_date: string | null;
  equity_curve: EquityPoint[];
  /** Risk-adjusted metrics over equity_curve. This strategy is in the market
   *  every single night, so exposure is ~100% and its Sharpe is directly
   *  comparable to a buy-and-hold Sharpe on the same symbol. */
  metrics: EquityMetrics | null;
  benchmark: BenchmarkComparison | null;
  benchmark_curve: EquityPoint[];
  cost_bps_roundtrip: number;
  caveats: string[];
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

export async function resolveSymbol(
  db: Database.Database,
  symbol: string,
): Promise<{ symbol: string; exchange: string; instrument_token: number } | null> {
  const priorities = ["NIFTY 200", "NIFTY 100", "NIFTY 500", "AD-HOC", "NSE-ALL"];
  for (const idx of priorities) {
    const row = db
      .prepare(
        `SELECT symbol, exchange, instrument_token FROM index_universe
         WHERE index_name=? AND symbol=? LIMIT 1`,
      )
      .get(idx, symbol) as { symbol: string; exchange: string; instrument_token: number } | undefined;
    if (row) return row;
  }
  const any = db
    .prepare(`SELECT symbol, exchange, instrument_token FROM index_universe WHERE symbol=? LIMIT 1`)
    .get(symbol) as { symbol: string; exchange: string; instrument_token: number } | undefined;
  return any ?? null;
}

export async function runOvernightBacktest(
  db: Database.Database,
  symbolInput: string,
): Promise<OvernightBacktestResult | null> {
  const resolved = await resolveSymbol(db, symbolInput);
  if (!resolved) return null;

  const bars = db
    .prepare(`SELECT trade_date, open, close FROM ohlc_daily WHERE instrument_token=? ORDER BY trade_date ASC`)
    .all(resolved.instrument_token) as Bar[];

  const caveats: string[] = [
    "Buys at every day's close, sells at the next day's open, unconditionally — no entry filter of any kind.",
    "Prices are NOT split/bonus-adjusted. Overnight moves beyond ±20% are treated as probable corporate-action artifacts and excluded from compounding (counted below), since a genuine overnight move can't realistically exceed NSE's circuit-breaker bands.",
    `${COST_BPS_ROUNDTRIP}bps round-trip cost assumption applied to every trade.`,
  ];

  if (bars.length < 2) {
    return {
      symbol: resolved.symbol,
      exchange: resolved.exchange,
      n_trades: 0,
      n_excluded_corporate_action: 0,
      win_rate_pct: null,
      avg_return_pct: null,
      median_return_pct: null,
      best_trade_pct: null,
      worst_trade_pct: null,
      profit_factor: null,
      starting_value_rupees: STARTING_CAPITAL_PAISE / 100,
      final_value_rupees: STARTING_CAPITAL_PAISE / 100,
      total_return_pct: 0,
      first_date: bars[0]?.trade_date ?? null,
      last_date: bars[0]?.trade_date ?? null,
      equity_curve: [],
      metrics: null,
      benchmark: null,
      benchmark_curve: [],
      cost_bps_roundtrip: COST_BPS_ROUNDTRIP,
      caveats: [...caveats, "Not enough price history for this symbol to run any overnight trade."],
    };
  }

  const costFrac = COST_BPS_ROUNDTRIP / 10_000;
  const trades: OvernightTrade[] = [];
  let value = STARTING_CAPITAL_PAISE;
  const equityCurve: EquityPoint[] = [{ date: bars[0].trade_date, value_rupees: value / 100 }];

  for (let i = 0; i < bars.length - 1; i++) {
    const buyDay = bars[i];
    const sellDay = bars[i + 1];
    if (buyDay.close <= 0 || sellDay.open <= 0) continue;
    const grossReturn = sellDay.open / buyDay.close - 1;
    const excluded = Math.abs(grossReturn) > IMPLAUSIBLE_OVERNIGHT_MOVE_FRAC;
    const netReturn = excluded ? 0 : (1 + grossReturn) * (1 - costFrac) - 1;

    trades.push({
      buy_date: buyDay.trade_date,
      buy_paise: buyDay.close,
      sell_date: sellDay.trade_date,
      sell_paise: sellDay.open,
      return_pct: netReturn * 100,
      excluded_as_corporate_action: excluded,
    });

    if (!excluded) {
      value = value * (1 + netReturn);
      equityCurve.push({ date: sellDay.trade_date, value_rupees: value / 100 });
    }
  }

  const scored = trades.filter((t) => !t.excluded_as_corporate_action);
  const returns = scored.map((t) => t.return_pct);
  const wins = returns.filter((r) => r > 0);
  const losses = returns.filter((r) => r <= 0);
  const nExcluded = trades.length - scored.length;

  if (nExcluded > 0) {
    caveats.push(`${nExcluded} day(s) excluded as probable corporate-action artifacts (overnight move beyond ±20%).`);
  }

  // Risk-adjusted view of the compounding walk. One overnight hold per trading
  // day, so the natural annualization is 252 periods/year (lib/metrics.ts's
  // default) and exposure is every period on the curve.
  const metrics = computeEquityMetrics(toSeries(equityCurve), {
    periodsInMarket: Math.max(0, equityCurve.length - 1),
  });
  const bench = compareToBenchmark(db, equityCurve);
  if (metrics) {
    caveats.push(
      `Sharpe, Sortino and alpha use a ${DEFAULT_RISK_FREE_RATE_PCT}% annual risk-free rate, annualized at 252 trading days — note this strategy holds capital only overnight, so it is exposed for a fraction of each 24 hours while being charged a full day of risk-free opportunity cost.`,
    );
    if (bench) caveats.push(benchmarkCaveat(bench.comparison));
  }

  return {
    symbol: resolved.symbol,
    exchange: resolved.exchange,
    n_trades: scored.length,
    n_excluded_corporate_action: nExcluded,
    win_rate_pct: scored.length > 0 ? (wins.length / scored.length) * 100 : null,
    avg_return_pct: returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : null,
    median_return_pct: returns.length > 0 ? median(returns) : null,
    best_trade_pct: returns.length > 0 ? Math.max(...returns) : null,
    worst_trade_pct: returns.length > 0 ? Math.min(...returns) : null,
    profit_factor:
      losses.length > 0 && losses.reduce((a, b) => a + b, 0) < 0
        ? wins.reduce((a, b) => a + b, 0) / -losses.reduce((a, b) => a + b, 0)
        : wins.length > 0
          ? Infinity
          : null,
    starting_value_rupees: STARTING_CAPITAL_PAISE / 100,
    final_value_rupees: value / 100,
    total_return_pct: (value / STARTING_CAPITAL_PAISE - 1) * 100,
    first_date: bars[0].trade_date,
    last_date: bars[bars.length - 1].trade_date,
    equity_curve: equityCurve,
    metrics,
    benchmark: bench?.comparison ?? null,
    benchmark_curve: bench?.points ?? [],
    cost_bps_roundtrip: COST_BPS_ROUNDTRIP,
    caveats,
  };
}

