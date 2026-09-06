import { test, expect, describe } from "vitest";
import {
  computeDrawdown,
  computeEquityMetrics,
  computeBenchmarkRelative,
  periodReturns,
  MIN_DAYS_FOR_CAGR,
  type SeriesPoint,
} from "@/lib/metrics";

/** N consecutive calendar days from `start` (tests don't need a trading
 *  calendar — the metrics only ever diff the first and last date). */
function days(start: string, n: number): string[] {
  const t0 = new Date(`${start}T00:00:00Z`).getTime();
  return Array.from({ length: n }, (_, i) =>
    new Date(t0 + i * 86_400_000).toISOString().slice(0, 10),
  );
}

function curveFromReturns(start: string, startValue: number, rets: number[]): SeriesPoint[] {
  const ds = days(start, rets.length + 1);
  const pts: SeriesPoint[] = [{ date: ds[0], value: startValue }];
  let v = startValue;
  for (let i = 0; i < rets.length; i++) {
    v *= 1 + rets[i];
    pts.push({ date: ds[i + 1], value: v });
  }
  return pts;
}

/** Deterministic, mildly volatile return pattern with both signs. */
function sawtooth(n: number): number[] {
  const pattern = [0.012, -0.006, 0.018, -0.011, 0.004, -0.002, 0.009, -0.014];
  return Array.from({ length: n }, (_, i) => pattern[i % pattern.length]);
}

describe("periodReturns", () => {
  test("computes consecutive simple returns", () => {
    const pts: SeriesPoint[] = [
      { date: "2024-01-01", value: 100 },
      { date: "2024-01-02", value: 110 },
      { date: "2024-01-03", value: 99 },
    ];
    const r = periodReturns(pts);
    expect(r).toHaveLength(2);
    expect(r[0]).toBeCloseTo(0.1, 10);
    expect(r[1]).toBeCloseTo(-0.1, 10);
  });

  test("skips pairs whose prior value is non-positive instead of returning Infinity", () => {
    const pts: SeriesPoint[] = [
      { date: "2024-01-01", value: 0 },
      { date: "2024-01-02", value: 50 },
      { date: "2024-01-03", value: 75 },
    ];
    const r = periodReturns(pts);
    expect(r).toHaveLength(1);
    expect(r[0]).toBeCloseTo(0.5, 10);
    expect(r.every(Number.isFinite)).toBe(true);
  });
});

describe("computeDrawdown", () => {
  test("worst peak-to-trough, with duration measured peak to recovery", () => {
    const dd = computeDrawdown([
      { date: "2024-01-01", value: 100 },
      { date: "2024-01-02", value: 120 },
      { date: "2024-01-03", value: 90 },
      { date: "2024-01-10", value: 130 },
    ]);
    expect(dd.max_drawdown_pct).toBeCloseTo(25, 10); // 120 -> 90
    expect(dd.peak_date).toBe("2024-01-02");
    expect(dd.trough_date).toBe("2024-01-03");
    expect(dd.recovered).toBe(true);
    expect(dd.max_drawdown_duration_days).toBe(8); // 01-02 -> 01-10
  });

  test("still-underwater series reports recovered=false and runs duration to the last point", () => {
    const dd = computeDrawdown([
      { date: "2024-01-01", value: 100 },
      { date: "2024-01-02", value: 120 },
      { date: "2024-01-05", value: 90 },
    ]);
    expect(dd.max_drawdown_pct).toBeCloseTo(25, 10);
    expect(dd.recovered).toBe(false);
    expect(dd.max_drawdown_duration_days).toBe(3); // 01-02 -> 01-05
  });

  test("monotonic curve has zero drawdown and no duration", () => {
    const dd = computeDrawdown([
      { date: "2024-01-01", value: 100 },
      { date: "2024-01-02", value: 110 },
      { date: "2024-01-03", value: 120 },
    ]);
    expect(dd.max_drawdown_pct).toBe(0);
    expect(dd.max_drawdown_duration_days).toBeNull();
    expect(dd.recovered).toBe(true);
  });

  test("non-positive peaks are skipped rather than producing a nonsense percentage", () => {
    const dd = computeDrawdown([
      { date: "2024-01-01", value: 0 },
      { date: "2024-01-02", value: 100 },
      { date: "2024-01-03", value: 50 },
    ]);
    expect(dd.max_drawdown_pct).toBeCloseTo(50, 10);
    expect(dd.peak_date).toBe("2024-01-02");
  });
});

describe("computeEquityMetrics", () => {
  test("returns null for a curve too short to describe", () => {
    expect(computeEquityMetrics([])).toBeNull();
    expect(computeEquityMetrics([{ date: "2024-01-01", value: 100 }])).toBeNull();
  });

  test("total return is exact regardless of span", () => {
    const m = computeEquityMetrics([
      { date: "2024-01-01", value: 100 },
      { date: "2024-01-15", value: 125 },
    ])!;
    expect(m.total_return_pct).toBeCloseTo(25, 10);
    expect(m.starting_value).toBe(100);
    expect(m.final_value).toBe(125);
    expect(m.span_days).toBe(14);
  });

  test(`CAGR is null below ${MIN_DAYS_FOR_CAGR} days of span`, () => {
    const short = computeEquityMetrics([
      { date: "2024-01-01", value: 100 },
      { date: "2024-03-01", value: 150 }, // 60 days — a huge but meaningless annualization
    ])!;
    expect(short.span_days).toBeLessThan(MIN_DAYS_FOR_CAGR);
    expect(short.cagr_pct).toBeNull();
    expect(short.total_return_pct).toBeCloseTo(50, 10);
  });

  test("CAGR annualizes a multi-year span correctly", () => {
    // 100 -> 200 over ~2 years should annualize to about sqrt(2)-1 = 41.4%.
    const m = computeEquityMetrics([
      { date: "2024-01-01", value: 100 },
      { date: "2025-12-31", value: 200 },
    ])!;
    expect(m.cagr_pct).not.toBeNull();
    expect(m.cagr_pct!).toBeCloseTo(41.4, 0);
  });

  test("a perfectly constant return has zero dispersion, so Sharpe is null not Infinity", () => {
    const pts = curveFromReturns("2024-01-01", 100, Array(120).fill(0.001));
    const m = computeEquityMetrics(pts, { riskFreeRatePct: 0 })!;
    expect(m.volatility_ann_pct).toBeCloseTo(0, 10);
    expect(m.sharpe).toBeNull();
    expect(m.max_drawdown_pct).toBe(0);
  });

  test("no losing period means no downside deviation, so Sortino is null", () => {
    const pts = curveFromReturns("2024-01-01", 100, Array(120).fill(0.002));
    const m = computeEquityMetrics(pts, { riskFreeRatePct: 0 })!;
    expect(m.sortino).toBeNull();
  });

  test("a rising volatile curve has positive Sharpe and Sortino, and Sortino exceeds Sharpe", () => {
    const pts = curveFromReturns("2024-01-01", 100, sawtooth(200));
    const m = computeEquityMetrics(pts, { riskFreeRatePct: 0 })!;
    expect(m.total_return_pct).toBeGreaterThan(0);
    expect(m.sharpe).not.toBeNull();
    expect(m.sharpe!).toBeGreaterThan(0);
    expect(m.sortino).not.toBeNull();
    // Sortino penalizes only shortfalls, so for a profitable series it is the
    // more generous of the two.
    expect(m.sortino!).toBeGreaterThan(m.sharpe!);
  });

  test("annualization scales with periodsPerYear, not a hardcoded 252", () => {
    const pts = curveFromReturns("2024-01-01", 100, sawtooth(200));
    const daily = computeEquityMetrics(pts, { periodsPerYear: 252, riskFreeRatePct: 0 })!;
    const weekly = computeEquityMetrics(pts, { periodsPerYear: 52, riskFreeRatePct: 0 })!;
    expect(daily.periods_per_year).toBe(252);
    expect(weekly.periods_per_year).toBe(52);
    // Both Sharpe and annualized vol carry a sqrt(ppy) factor.
    const ratio = Math.sqrt(252 / 52);
    expect(daily.sharpe! / weekly.sharpe!).toBeCloseTo(ratio, 6);
    expect(daily.volatility_ann_pct! / weekly.volatility_ann_pct!).toBeCloseTo(ratio, 6);
  });

  test("a non-zero risk-free rate lowers Sharpe", () => {
    const pts = curveFromReturns("2024-01-01", 100, sawtooth(300));
    const zeroRf = computeEquityMetrics(pts, { riskFreeRatePct: 0 })!;
    const withRf = computeEquityMetrics(pts, { riskFreeRatePct: 6.5 })!;
    expect(withRf.sharpe!).toBeLessThan(zeroRf.sharpe!);
    expect(withRf.risk_free_rate_pct).toBe(6.5);
  });

  test("Calmar is CAGR divided by max drawdown", () => {
    const pts = curveFromReturns("2024-01-01", 100, sawtooth(400));
    const m = computeEquityMetrics(pts, { riskFreeRatePct: 0 })!;
    expect(m.cagr_pct).not.toBeNull();
    expect(m.max_drawdown_pct).toBeGreaterThan(0);
    expect(m.calmar!).toBeCloseTo(m.cagr_pct! / m.max_drawdown_pct, 8);
  });

  test("exposure time is null unless supplied, and a share of periods when it is", () => {
    const pts = curveFromReturns("2024-01-01", 100, sawtooth(100));
    expect(computeEquityMetrics(pts)!.exposure_time_pct).toBeNull();
    const m = computeEquityMetrics(pts, { periodsInMarket: 25 })!;
    expect(m.n_periods).toBe(100);
    expect(m.exposure_time_pct).toBeCloseTo(25, 10);
  });
});

describe("computeBenchmarkRelative", () => {
  test("a strategy identical to its benchmark has beta 1 and ~zero alpha", () => {
    const pts = curveFromReturns("2024-01-01", 100, sawtooth(300));
    const rel = computeBenchmarkRelative(pts, pts, { riskFreeRatePct: 6.5 })!;
    expect(rel.beta).toBeCloseTo(1, 10);
    expect(rel.alpha_pct).toBeCloseTo(0, 8);
    expect(rel.excess_total_return_pct).toBeCloseTo(0, 10);
  });

  test("a strategy moving exactly twice the benchmark has beta 2", () => {
    const bRets = sawtooth(300);
    const bench = curveFromReturns("2024-01-01", 100, bRets);
    const strat = curveFromReturns("2024-01-01", 100, bRets.map((r) => r * 2));
    const rel = computeBenchmarkRelative(strat, bench, { riskFreeRatePct: 0 })!;
    expect(rel.beta).toBeCloseTo(2, 8);
  });

  test("beta pairs returns by DATE, so a sparse benchmark shrinks the sample", () => {
    const strat = curveFromReturns("2024-01-01", 100, sawtooth(9));
    // Benchmark present on only some of the strategy's dates.
    const sparse = strat.filter((_, i) => i % 3 === 0);
    const rel = computeBenchmarkRelative(strat, sparse, { riskFreeRatePct: 0 })!;
    expect(sparse.length).toBe(4);
    expect(rel.overlapping_periods).toBe(3); // 4 shared dates -> 3 return pairs
  });

  test("benchmark total return and excess return are reported even when alpha is not", () => {
    // 30-day span: too short for either CAGR leg, so alpha must be null while
    // the simple return difference is still meaningful.
    const bench = curveFromReturns("2024-01-01", 100, Array(30).fill(0.001));
    const strat = curveFromReturns("2024-01-01", 100, Array(30).fill(0.003));
    const rel = computeBenchmarkRelative(strat, bench, { riskFreeRatePct: 0 })!;
    expect(rel.benchmark_cagr_pct).toBeNull();
    expect(rel.alpha_pct).toBeNull();
    expect(rel.benchmark_total_return_pct).toBeGreaterThan(0);
    expect(rel.excess_total_return_pct).toBeGreaterThan(0);
  });

  test("returns null when either series is too short", () => {
    const pts = curveFromReturns("2024-01-01", 100, sawtooth(10));
    expect(computeBenchmarkRelative(pts, [{ date: "2024-01-01", value: 100 }])).toBeNull();
    expect(computeBenchmarkRelative([{ date: "2024-01-01", value: 100 }], pts)).toBeNull();
  });
});
