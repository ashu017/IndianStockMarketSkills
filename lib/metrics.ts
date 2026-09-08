/**
 * Risk-adjusted performance metrics computed from an equity curve.
 *
 * Deliberately free of `server-only` and of any DB import so the same code can
 * be called from standalone `npx tsx` scripts, from Next.js route handlers, and
 * from vitest — the same constraint that shaped lib/bulk-deals-csv.ts. Every
 * function here is pure: series in, numbers out.
 *
 * WHY THIS EXISTS: the backtest engines used to report only trade-level
 * statistics (win rate, average return, profit factor). Those throw away the
 * time axis, and a drawdown is a property of the SEQUENCE of returns, not of
 * the bag of trades. Two strategies with identical win rates are not
 * comparable until you know their volatility and their worst peak-to-trough
 * loss, which is why the three strategies in lib/strategies.ts could not
 * previously be ranked against each other at all.
 *
 * Consumers: lib/backtest.ts, lib/overnight-backtest.ts, lib/paper.ts.
 */

export interface SeriesPoint {
  date: string; // YYYY-MM-DD
  value: number; // account value in any consistent unit (rupees, paise, index points)
}

/** The curve shape the backtest engines hand to the UI (rupees, so it can be
 *  charted and axis-labelled directly). Adapt with `toSeries` before passing to
 *  any metric function. */
export interface EquityPoint {
  date: string;
  value_rupees: number;
}

export function toSeries(points: EquityPoint[]): SeriesPoint[] {
  return points.map((p) => ({ date: p.date, value: p.value_rupees }));
}

/** Below this span, annualizing a return produces a number that says more
 *  about the sample window than the strategy. Shared with lib/strategies.ts's
 *  account-age CAGR so the app has exactly one such threshold. */
export const MIN_DAYS_FOR_CAGR = 90;

/**
 * CAGR measured against an account's age rather than an equity curve's span —
 * "starting capital grew to this over this many calendar days". Used for a
 * paper strategy's headline figure, where there is no per-strategy curve to
 * measure (see the shared-cash-pool note in lib/paper.ts's summarize()); the
 * curve-based counterpart is computeEquityMetrics().cagr_pct below.
 *
 * Returns null before MIN_DAYS_FOR_CAGR has elapsed, because annualizing a
 * short-lived return compounds noise into a huge, confident-looking number — a
 * real +5% over 23 days reads as "+115% CAGR". Callers must fall back to
 * showing total return (non-annualized) until then.
 *
 * Lives here rather than in lib/strategies.ts so the browser can recompute it
 * when live prices move the current value, without importing a server-only
 * module.
 */
export function accountAgeCagrPct(
  startingCashPaise: number,
  currentValuePaise: number,
  createdAtIso: string,
  now = Date.now(),
): number | null {
  const ageDays = (now - new Date(createdAtIso).getTime()) / 86_400_000;
  if (ageDays < MIN_DAYS_FOR_CAGR || startingCashPaise <= 0 || currentValuePaise <= 0) return null;
  const years = ageDays / 365.25;
  return (Math.pow(currentValuePaise / startingCashPaise, 1 / years) - 1) * 100;
}

/** Indian equity trading days per year. Pass an explicit override for any
 *  non-daily cadence — a weekly-rebalance curve needs 52, and annualizing a
 *  weekly series with 252 silently inflates Sharpe by ~2.2x. */
export const DEFAULT_PERIODS_PER_YEAR = 252;

/** Sharpe/Sortino/alpha are all excess-return measures, and in India the
 *  risk-free leg is not negligible — a ~6.5% T-bill is a large fraction of
 *  most strategies' gross return, so a zero-rate Sharpe flatters everything.
 *  Callers wanting the raw (rf=0) figure must pass 0 explicitly. */
export const DEFAULT_RISK_FREE_RATE_PCT = 6.5;

export interface DrawdownResult {
  /** Worst peak-to-trough decline over the series, as a positive percentage. */
  max_drawdown_pct: number;
  /** Calendar days from the peak preceding the worst trough until that peak
   *  was regained; if never regained, days from the peak to the last point
   *  (with `recovered: false`). Null when there was no drawdown at all. */
  max_drawdown_duration_days: number | null;
  peak_date: string | null;
  trough_date: string | null;
  /** False when the series ends still below the pre-drawdown peak. */
  recovered: boolean;
}

export interface EquityMetrics {
  n_periods: number;
  first_date: string;
  last_date: string;
  span_days: number;
  starting_value: number;
  final_value: number;
  total_return_pct: number;
  /** Null until MIN_DAYS_FOR_CAGR of span — callers should fall back to
   *  displaying total_return_pct rather than annualizing a short window. */
  cagr_pct: number | null;
  volatility_ann_pct: number | null;
  sharpe: number | null;
  sortino: number | null;
  calmar: number | null;
  max_drawdown_pct: number;
  max_drawdown_duration_days: number | null;
  /** Share of periods with capital actually deployed. Null unless the caller
   *  supplies `periodsInMarket` — it cannot be inferred from an equity curve,
   *  since a flat stretch is indistinguishable from an idle one. */
  exposure_time_pct: number | null;
  periods_per_year: number;
  risk_free_rate_pct: number;
}

export interface EquityMetricsOptions {
  periodsPerYear?: number;
  riskFreeRatePct?: number;
  /** Number of periods at least partly invested, for exposure_time_pct. */
  periodsInMarket?: number;
}

export interface BenchmarkRelative {
  benchmark_total_return_pct: number;
  benchmark_cagr_pct: number | null;
  /** Jensen's alpha, annualized: (Rp − Rf) − β(Rb − Rf). Null when either
   *  leg's CAGR is unavailable (span shorter than MIN_DAYS_FOR_CAGR). */
  alpha_pct: number | null;
  beta: number | null;
  /** Simple difference of total returns — always available, unlike alpha. */
  excess_total_return_pct: number;
  /** Dates present in BOTH series. Beta is computed only over these, so a
   *  sparse benchmark (our Nifty ETF proxy misses ~17% of trading days)
   *  shrinks the sample rather than silently mis-pairing returns. */
  overlapping_periods: number;
}

function dayDiff(fromDate: string, toDate: string): number {
  return Math.round(
    (new Date(`${toDate}T00:00:00Z`).getTime() - new Date(`${fromDate}T00:00:00Z`).getTime()) / 86_400_000,
  );
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation (n−1). Returns null below two observations,
 *  where the population/sample distinction isn't the issue — there simply is
 *  no dispersion to measure. */
function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs);
  const variance = xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

/** Period-over-period simple returns. Pairs where the prior value is
 *  non-positive are skipped rather than producing ±Infinity. */
export function periodReturns(points: SeriesPoint[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1].value;
    if (prev <= 0) continue;
    out.push(points[i].value / prev - 1);
  }
  return out;
}

/**
 * Peak-to-trough drawdown, tracking the dates so the duration is reportable.
 *
 * Non-positive peaks are skipped (a percentage decline from zero or negative
 * equity is meaningless), matching the semantics of the inline loop this
 * replaced in lib/paper.ts.
 */
export function computeDrawdown(points: SeriesPoint[]): DrawdownResult {
  let peakValue = -Infinity;
  let peakDate: string | null = null;
  let maxDd = 0;
  let ddPeakDate: string | null = null;
  let ddTroughDate: string | null = null;

  for (const p of points) {
    if (p.value > peakValue) {
      peakValue = p.value;
      peakDate = p.date;
    }
    if (peakValue <= 0) continue;
    const dd = ((peakValue - p.value) / peakValue) * 100;
    if (dd > maxDd) {
      maxDd = dd;
      ddPeakDate = peakDate;
      ddTroughDate = p.date;
    }
  }

  if (maxDd === 0 || ddPeakDate === null || ddTroughDate === null) {
    return {
      max_drawdown_pct: 0,
      max_drawdown_duration_days: null,
      peak_date: null,
      trough_date: null,
      recovered: true,
    };
  }

  // Duration runs peak -> recovery (not peak -> trough), which is the figure
  // that actually describes how long the strategy spent underwater.
  const peakIdx = points.findIndex((p) => p.date === ddPeakDate);
  const peakLevel = points[peakIdx].value;
  let recoveryDate: string | null = null;
  for (let i = peakIdx + 1; i < points.length; i++) {
    if (points[i].value >= peakLevel) {
      recoveryDate = points[i].date;
      break;
    }
  }
  const endDate = recoveryDate ?? points[points.length - 1].date;

  return {
    max_drawdown_pct: maxDd,
    max_drawdown_duration_days: dayDiff(ddPeakDate, endDate),
    peak_date: ddPeakDate,
    trough_date: ddTroughDate,
    recovered: recoveryDate !== null,
  };
}

/**
 * Full metric set for one equity curve. Returns null for a curve too short to
 * say anything about (fewer than two points), rather than emitting zeros that
 * would render as a real result.
 */
export function computeEquityMetrics(
  points: SeriesPoint[],
  opts: EquityMetricsOptions = {},
): EquityMetrics | null {
  if (points.length < 2) return null;

  const ppy = opts.periodsPerYear ?? DEFAULT_PERIODS_PER_YEAR;
  const rfPct = opts.riskFreeRatePct ?? DEFAULT_RISK_FREE_RATE_PCT;

  const first = points[0];
  const last = points[points.length - 1];
  const spanDays = dayDiff(first.date, last.date);
  const totalReturnPct = first.value > 0 ? (last.value / first.value - 1) * 100 : 0;

  const growth = first.value > 0 ? last.value / first.value : 0;
  const cagrPct =
    spanDays >= MIN_DAYS_FOR_CAGR && growth > 0
      ? (Math.pow(growth, 365.25 / spanDays) - 1) * 100
      : null;

  const rets = periodReturns(points);
  const sd = stdev(rets);
  const volAnnPct = sd === null ? null : sd * Math.sqrt(ppy) * 100;

  // Per-period risk-free rate, geometrically de-annualized so it composes back
  // to rfPct over `ppy` periods.
  const rfPerPeriod = Math.pow(1 + rfPct / 100, 1 / ppy) - 1;
  const excess = rets.map((r) => r - rfPerPeriod);
  const excessSd = stdev(excess);
  const sharpe =
    excessSd !== null && excessSd > 0 ? (mean(excess) / excessSd) * Math.sqrt(ppy) : null;

  // Downside deviation: only shortfalls below the risk-free leg are penalized,
  // so upside volatility doesn't count against the strategy.
  const downside = excess.map((e) => Math.min(0, e));
  const downsideDev =
    excess.length > 0 ? Math.sqrt(mean(downside.map((d) => d * d))) : 0;
  const sortino =
    excess.length > 0 && downsideDev > 0 ? (mean(excess) / downsideDev) * Math.sqrt(ppy) : null;

  const dd = computeDrawdown(points);
  const calmar = cagrPct !== null && dd.max_drawdown_pct > 0 ? cagrPct / dd.max_drawdown_pct : null;

  return {
    n_periods: rets.length,
    first_date: first.date,
    last_date: last.date,
    span_days: spanDays,
    starting_value: first.value,
    final_value: last.value,
    total_return_pct: totalReturnPct,
    cagr_pct: cagrPct,
    volatility_ann_pct: volAnnPct,
    sharpe,
    sortino,
    calmar,
    max_drawdown_pct: dd.max_drawdown_pct,
    max_drawdown_duration_days: dd.max_drawdown_duration_days,
    exposure_time_pct:
      opts.periodsInMarket !== undefined && points.length > 1
        ? (opts.periodsInMarket / (points.length - 1)) * 100
        : null,
    periods_per_year: ppy,
    risk_free_rate_pct: rfPct,
  };
}

/**
 * Benchmark-relative figures. Beta and alpha are computed over the DATE
 * INTERSECTION of the two curves — our benchmark proxy (an ETF) has gaps
 * relative to the equity universe, and pairing returns positionally instead of
 * by date would silently compare different days.
 */
export function computeBenchmarkRelative(
  strategy: SeriesPoint[],
  benchmark: SeriesPoint[],
  opts: EquityMetricsOptions = {},
): BenchmarkRelative | null {
  if (strategy.length < 2 || benchmark.length < 2) return null;

  const ppy = opts.periodsPerYear ?? DEFAULT_PERIODS_PER_YEAR;
  const rfPct = opts.riskFreeRatePct ?? DEFAULT_RISK_FREE_RATE_PCT;

  const benchByDate = new Map(benchmark.map((p) => [p.date, p.value]));
  const paired: { date: string; s: number; b: number }[] = [];
  for (const p of strategy) {
    const b = benchByDate.get(p.date);
    if (b !== undefined) paired.push({ date: p.date, s: p.value, b });
  }

  const bFirst = benchmark[0];
  const bLast = benchmark[benchmark.length - 1];
  const bSpan = dayDiff(bFirst.date, bLast.date);
  const bGrowth = bFirst.value > 0 ? bLast.value / bFirst.value : 0;
  const bTotalPct = bFirst.value > 0 ? (bGrowth - 1) * 100 : 0;
  const bCagrPct =
    bSpan >= MIN_DAYS_FOR_CAGR && bGrowth > 0 ? (Math.pow(bGrowth, 365.25 / bSpan) - 1) * 100 : null;

  const sFirst = strategy[0];
  const sLast = strategy[strategy.length - 1];
  const sSpan = dayDiff(sFirst.date, sLast.date);
  const sGrowth = sFirst.value > 0 ? sLast.value / sFirst.value : 0;
  const sTotalPct = sFirst.value > 0 ? (sGrowth - 1) * 100 : 0;
  const sCagrPct =
    sSpan >= MIN_DAYS_FOR_CAGR && sGrowth > 0 ? (Math.pow(sGrowth, 365.25 / sSpan) - 1) * 100 : null;

  let beta: number | null = null;
  if (paired.length >= 3) {
    const sRets: number[] = [];
    const bRets: number[] = [];
    for (let i = 1; i < paired.length; i++) {
      const ps = paired[i - 1].s;
      const pb = paired[i - 1].b;
      if (ps <= 0 || pb <= 0) continue;
      sRets.push(paired[i].s / ps - 1);
      bRets.push(paired[i].b / pb - 1);
    }
    if (sRets.length >= 2) {
      const ms = mean(sRets);
      const mb = mean(bRets);
      let cov = 0;
      let varB = 0;
      for (let i = 0; i < sRets.length; i++) {
        cov += (sRets[i] - ms) * (bRets[i] - mb);
        varB += (bRets[i] - mb) ** 2;
      }
      if (varB > 0) beta = cov / varB;
    }
  }

  const alphaPct =
    beta !== null && sCagrPct !== null && bCagrPct !== null
      ? sCagrPct - rfPct - beta * (bCagrPct - rfPct)
      : null;

  void ppy; // annualization is already baked into the CAGR legs above
  return {
    benchmark_total_return_pct: bTotalPct,
    benchmark_cagr_pct: bCagrPct,
    alpha_pct: alphaPct,
    beta,
    excess_total_return_pct: sTotalPct - bTotalPct,
    overlapping_periods: Math.max(0, paired.length - 1),
  };
}
