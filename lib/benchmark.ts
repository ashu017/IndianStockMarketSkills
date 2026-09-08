import type Database from "better-sqlite3";
import {
  computeBenchmarkRelative,
  toSeries,
  type BenchmarkRelative,
  type EquityMetricsOptions,
  type EquityPoint,
} from "./metrics";

/**
 * Nifty benchmark series for backtest comparison.
 *
 * "+18% over three years" is unreadable without knowing what the index did
 * over the same window, which is why backtesting.py reports Buy & Hold Return,
 * Alpha and Beta by default. This module supplies the comparison leg.
 *
 * PROXY, NOT THE INDEX: this app's ohlc_daily only holds tradeable instruments,
 * not index levels, so the benchmark is an ETF that tracks the Nifty 50 rather
 * than the index itself. Consequences, reported rather than hidden:
 *   - It is a PRICE series, so index dividends are missing (a ~1-1.5%/yr
 *     understatement of the true benchmark return, which flatters any strategy
 *     compared against it).
 *   - ETF liquidity gaps mean it has fewer bars than the equity universe, so
 *     `coverage_pct` is reported and beta is computed on the date intersection
 *     (see lib/metrics.ts's computeBenchmarkRelative).
 *   - It tracks the Nifty 50, while the strategies trade a Nifty 500 universe —
 *     a large-cap yardstick held against a broader opportunity set.
 *
 * The raw series needs cleaning before it can serve as a yardstick at all, and
 * both defects are real in this app's data:
 *   - A 1:10 split on 2026-07-31 (₹2786.51 -> ₹280.58). ohlc_daily is not
 *     corporate-action adjusted, so the unadjusted series reads as the Nifty 50
 *     losing 90% in a day. Splits are back-adjusted out (see SPLIT_MOVE_FRAC).
 *   - A bad print on 2024-02-19: a close of ₹2848 on 20 shares traded, snapping
 *     back the next day. Thin ETF liquidity means the closing print sometimes
 *     detaches from NAV; left in, it injects a spurious ±15% round trip that
 *     wrecks beta and volatility. Spike-and-revert bars are dropped (see
 *     OUTLIER_MOVE_FRAC).
 * These guards are specific to an INDEX proxy — a single stock genuinely can
 * move 30% on news, so the same thresholds would be wrong for lib/backtest.ts.
 * Both counts are reported rather than silently applied.
 *
 * No `server-only` and `db` is passed in, so scripts and route handlers share
 * one implementation.
 */

/** Invesco India Nifty ETF. Also referenced by
 *  scripts/analyze-bulk-deal-holds.ts, which imported its own copy of this
 *  constant before this module existed. */
export const BENCHMARK_SYMBOL = "IVZINNIFTY";
export const BENCHMARK_LABEL = "Nifty 50 (IVZINNIFTY ETF, price-only)";

/** A one-day move beyond this is a corporate action, not a market move: the
 *  Nifty 50's worst day on record is about -13% (2020-03-23), so 25% leaves a
 *  wide margin over anything the index has ever actually done. */
const SPLIT_MOVE_FRAC = 0.25;

/** Spike-and-revert threshold for thin-liquidity bad prints. A bar qualifies
 *  only if it moves more than this AND the move reverses next bar, leaving the
 *  two surrounding closes within this band of each other — so a genuine crash
 *  that keeps falling (2020) is kept, while a one-tick outlier is dropped. */
const OUTLIER_MOVE_FRAC = 0.08;

export interface BenchmarkSeries {
  symbol: string;
  label: string;
  points: EquityPoint[];
  first_date: string;
  last_date: string;
  n_bars: number;
  /** Bars present as a share of the trading dates the rest of the universe had
   *  over the same window — the honest measure of how gappy this proxy is. */
  coverage_pct: number;
  /** Corporate actions back-adjusted out of the window. */
  n_split_adjustments: number;
  /** Thin-liquidity bad prints dropped from the window. */
  n_outlier_bars_dropped: number;
}

interface RawBar {
  trade_date: string;
  close: number;
}

/** Drop spike-and-revert bars (bad closing prints on negligible volume). */
function dropOutlierPrints(bars: RawBar[]): { kept: RawBar[]; dropped: number } {
  if (bars.length < 3) return { kept: bars, dropped: 0 };
  const kept: RawBar[] = [bars[0]];
  let dropped = 0;
  for (let i = 1; i < bars.length - 1; i++) {
    const prev = kept[kept.length - 1].close;
    const cur = bars[i].close;
    const next = bars[i + 1].close;
    const moveIn = cur / prev - 1;
    const roundTrip = Math.abs(next / prev - 1);
    if (Math.abs(moveIn) > OUTLIER_MOVE_FRAC && roundTrip < OUTLIER_MOVE_FRAC) {
      dropped++;
      continue;
    }
    kept.push(bars[i]);
  }
  kept.push(bars[bars.length - 1]);
  return { kept, dropped };
}

/**
 * Forward-adjust across corporate actions so the series is continuous.
 *
 * Forward rather than backward adjustment keeps the earliest close as the base,
 * which is the one the caller normalizes on anyway — so a split partway through
 * the window scales the post-split leg back up to pre-split terms instead of
 * silently rebasing the whole chart.
 */
function adjustForSplits(bars: RawBar[]): { adjusted: RawBar[]; adjustments: number } {
  if (bars.length < 2) return { adjusted: bars, adjustments: 0 };
  const adjusted: RawBar[] = [bars[0]];
  let factor = 1;
  let adjustments = 0;
  for (let i = 1; i < bars.length; i++) {
    const rawMove = bars[i].close / bars[i - 1].close - 1;
    if (Math.abs(rawMove) > SPLIT_MOVE_FRAC) {
      factor *= bars[i - 1].close / bars[i].close;
      adjustments++;
    }
    adjusted.push({ trade_date: bars[i].trade_date, close: bars[i].close * factor });
  }
  return { adjusted, adjustments };
}

/**
 * Load the benchmark, normalized so it starts at `startingRupees` on its first
 * bar within [fromDate, toDate]. Normalizing (rather than returning raw prices)
 * lets the caller chart it directly against a strategy equity curve that began
 * with the same notional capital.
 *
 * Returns null when the benchmark instrument is untracked or has fewer than two
 * bars in the window — callers should degrade to "no benchmark available"
 * rather than fabricate one.
 */
export function loadBenchmarkSeries(
  db: Database.Database,
  opts: { fromDate: string; toDate: string; startingRupees: number },
): BenchmarkSeries | null {
  const token = db
    .prepare(`SELECT instrument_token FROM index_universe WHERE symbol=? LIMIT 1`)
    .pluck()
    .get(BENCHMARK_SYMBOL) as number | undefined;
  if (token === undefined) return null;

  const rawBars = db
    .prepare(
      `SELECT trade_date, close FROM ohlc_daily
        WHERE instrument_token=? AND trade_date >= ? AND trade_date <= ? AND close > 0
        ORDER BY trade_date ASC`,
    )
    .all(token, opts.fromDate, opts.toDate) as RawBar[];
  if (rawBars.length < 2) return null;

  const { kept, dropped } = dropOutlierPrints(rawBars);
  const { adjusted: bars, adjustments } = adjustForSplits(kept);
  if (bars.length < 2) return null;

  const universeDates = db
    .prepare(
      `SELECT COUNT(DISTINCT trade_date) FROM ohlc_daily
        WHERE trade_date >= ? AND trade_date <= ?`,
    )
    .pluck()
    .get(opts.fromDate, opts.toDate) as number;

  const base = bars[0].close;
  return {
    symbol: BENCHMARK_SYMBOL,
    label: BENCHMARK_LABEL,
    points: bars.map((b) => ({
      date: b.trade_date,
      value_rupees: (opts.startingRupees * b.close) / base,
    })),
    first_date: bars[0].trade_date,
    last_date: bars[bars.length - 1].trade_date,
    n_bars: bars.length,
    coverage_pct: universeDates > 0 ? (bars.length / universeDates) * 100 : 0,
    n_split_adjustments: adjustments,
    n_outlier_bars_dropped: dropped,
  };
}

/** What an engine reports about its benchmark leg. The series itself is kept
 *  separate (see compareToBenchmark's return) so a summary object stays small. */
export interface BenchmarkComparison {
  symbol: string;
  label: string;
  n_bars: number;
  coverage_pct: number;
  n_split_adjustments: number;
  n_outlier_bars_dropped: number;
  relative: BenchmarkRelative | null;
}

/**
 * Load the benchmark over a strategy curve's own window and compare against it.
 *
 * Both backtest engines need exactly this glue — window derived from the curve,
 * benchmark normalized to the curve's starting capital, then
 * computeBenchmarkRelative — so it lives here once rather than being retyped in
 * each engine. Returns null when there's no usable benchmark for the window;
 * callers should report "no benchmark" rather than substitute a guess.
 */
export function compareToBenchmark(
  db: Database.Database,
  strategyCurve: EquityPoint[],
  opts: EquityMetricsOptions = {},
): { comparison: BenchmarkComparison; points: EquityPoint[] } | null {
  if (strategyCurve.length < 2) return null;
  const series = loadBenchmarkSeries(db, {
    fromDate: strategyCurve[0].date,
    toDate: strategyCurve[strategyCurve.length - 1].date,
    startingRupees: strategyCurve[0].value_rupees,
  });
  if (!series) return null;
  return {
    comparison: {
      symbol: series.symbol,
      label: series.label,
      n_bars: series.n_bars,
      coverage_pct: series.coverage_pct,
      n_split_adjustments: series.n_split_adjustments,
      n_outlier_bars_dropped: series.n_outlier_bars_dropped,
      relative: computeBenchmarkRelative(toSeries(strategyCurve), toSeries(series.points), opts),
    },
    points: series.points,
  };
}

/** Standing caveat text for the proxy, so every consumer words it the same way. */
export function benchmarkCaveat(c: BenchmarkComparison): string {
  const cleaned: string[] = [];
  if (c.n_split_adjustments > 0) {
    cleaned.push(`${c.n_split_adjustments} corporate action(s) back-adjusted out (ohlc_daily is unadjusted)`);
  }
  if (c.n_outlier_bars_dropped > 0) {
    cleaned.push(`${c.n_outlier_bars_dropped} thin-liquidity bad print(s) dropped`);
  }
  return (
    `Benchmark is ${c.label} — a price series, so index dividends (~1-1.5%/yr) are missing, which flatters the strategy. ` +
    `It covers ${c.coverage_pct.toFixed(0)}% of the window's trading dates, and it tracks the Nifty 50 — a large-cap yardstick that may not match what this strategy actually trades.` +
    (cleaned.length > 0 ? ` Series cleaning applied: ${cleaned.join("; ")}.` : "")
  );
}
