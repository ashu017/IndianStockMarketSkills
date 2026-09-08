"use client";

import { fmtPct } from "./utils";

/**
 * Risk-adjusted metrics for a backtest equity curve, shared by BacktestPanel
 * and OvernightBacktestPanel.
 *
 * Shapes mirror lib/metrics.ts's EquityMetrics and lib/benchmark.ts's
 * BenchmarkComparison, declared client-side per this app's existing convention
 * (see BacktestPanel's own BacktestSummary) so a client component never imports
 * a `server-only` module.
 */
export interface EquityMetricsView {
  total_return_pct: number;
  cagr_pct: number | null;
  volatility_ann_pct: number | null;
  sharpe: number | null;
  sortino: number | null;
  calmar: number | null;
  max_drawdown_pct: number;
  max_drawdown_duration_days: number | null;
  exposure_time_pct: number | null;
  periods_per_year: number;
  risk_free_rate_pct: number;
  span_days: number;
}

export interface BenchmarkRelativeView {
  benchmark_total_return_pct: number;
  benchmark_cagr_pct: number | null;
  alpha_pct: number | null;
  beta: number | null;
  excess_total_return_pct: number;
  overlapping_periods: number;
}

export interface BenchmarkView {
  symbol: string;
  label: string;
  n_bars: number;
  coverage_pct: number;
  n_split_adjustments: number;
  n_outlier_bars_dropped: number;
  relative: BenchmarkRelativeView | null;
}

function gainClass(v: number | null | undefined): string {
  if (v === null || v === undefined) return "text-muted-foreground";
  return v > 0 ? "text-emerald-600" : v < 0 ? "text-red-600" : "text-foreground";
}

function Tile({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3" title={hint}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold mt-0.5 text-foreground num">{value}</div>
    </div>
  );
}

const num = (v: number | null | undefined, digits = 2): string =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(digits);

export default function RiskMetricsGrid({
  metrics,
  benchmark,
}: {
  metrics: EquityMetricsView | null;
  benchmark?: BenchmarkView | null;
}) {
  if (!metrics) return null;
  const rel = benchmark?.relative ?? null;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Tile
          label="Total return"
          value={<span className={gainClass(metrics.total_return_pct)}>{fmtPct(metrics.total_return_pct)}</span>}
          hint={`Over ${metrics.span_days} calendar days`}
        />
        <Tile
          label="CAGR"
          value={
            metrics.cagr_pct === null ? (
              "—"
            ) : (
              <span className={gainClass(metrics.cagr_pct)}>{fmtPct(metrics.cagr_pct)}</span>
            )
          }
          hint="Annualized; suppressed below 90 days of history"
        />
        <Tile
          label="Volatility (ann.)"
          value={metrics.volatility_ann_pct === null ? "—" : `${num(metrics.volatility_ann_pct)}%`}
          hint={`Annualized at ${metrics.periods_per_year} periods/year`}
        />
        <Tile
          label="Max drawdown"
          value={<span className="text-red-600">-{num(metrics.max_drawdown_pct)}%</span>}
          hint={
            metrics.max_drawdown_duration_days === null
              ? undefined
              : `${metrics.max_drawdown_duration_days} days from peak to recovery`
          }
        />
        <Tile
          label="Sharpe"
          value={<span className={gainClass(metrics.sharpe)}>{num(metrics.sharpe, 2)}</span>}
          hint={`Excess of a ${metrics.risk_free_rate_pct}% risk-free rate, per unit of total volatility`}
        />
        <Tile
          label="Sortino"
          value={<span className={gainClass(metrics.sortino)}>{num(metrics.sortino, 2)}</span>}
          hint="Same excess return, but only downside deviation is penalized"
        />
        <Tile
          label="Calmar"
          value={<span className={gainClass(metrics.calmar)}>{num(metrics.calmar, 2)}</span>}
          hint="CAGR divided by max drawdown"
        />
        <Tile
          label="Time in market"
          value={metrics.exposure_time_pct === null ? "—" : `${num(metrics.exposure_time_pct, 0)}%`}
          hint="Share of periods with at least one position held; idle cash earns 0%"
        />
      </div>

      {rel && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Tile
            label="Benchmark return"
            value={
              <span className={gainClass(rel.benchmark_total_return_pct)}>
                {fmtPct(rel.benchmark_total_return_pct)}
              </span>
            }
            hint={benchmark?.label}
          />
          <Tile
            label="vs benchmark"
            value={
              <span className={gainClass(rel.excess_total_return_pct)}>
                {fmtPct(rel.excess_total_return_pct)}
              </span>
            }
            hint="Total return minus the benchmark's total return over the same window"
          />
          <Tile
            label="Alpha (ann.)"
            value={
              rel.alpha_pct === null ? "—" : <span className={gainClass(rel.alpha_pct)}>{fmtPct(rel.alpha_pct)}</span>
            }
            hint="Jensen's alpha: return beyond what this beta would predict"
          />
          <Tile
            label="Beta"
            value={num(rel.beta, 2)}
            hint={`Sensitivity to the benchmark, over ${rel.overlapping_periods} shared trading days`}
          />
        </div>
      )}
    </div>
  );
}
