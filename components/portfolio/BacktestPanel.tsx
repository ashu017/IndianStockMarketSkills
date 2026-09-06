"use client";

import { useState } from "react";
import { FlaskConical } from "lucide-react";
import { fmtPct } from "./utils";
import BacktestEquityChart, { type EquityPoint } from "./BacktestEquityChart";
import RiskMetricsGrid, { type BenchmarkView, type EquityMetricsView } from "./RiskMetricsGrid";

/** Mirrors lib/backtest.ts's MomentumParams — the exit rule under test. */
interface MomentumParams {
  stopAtrMult: number;
  targetRMultiple: number;
  breakevenRMultiple: number | null;
  trailRMultiple: number | null;
  trailLookback: number;
  timeExitBars: number;
  scaleOuts: { r: number; fraction: number }[];
  breakevenAfterPartial: boolean;
  maxAtrAboveSma50: number | null;
}

interface BacktestSummary {
  universe_requested: number;
  universe_quality_pass: number;
  /** False for the no-fundamentals strategy — no quality filter was applied. */
  quality_gate_applied: boolean;
  universe_with_enough_history: number;
  n_trades: number;
  n_symbols_traded: number;
  win_rate_pct: number | null;
  avg_return_pct: number | null;
  median_return_pct: number | null;
  profit_factor: number | null;
  avg_bars_held: number | null;
  median_bars_held: number | null;
  /** Null when the variant has no scale-out ladder. */
  n_partial_exits: number | null;
  avg_partial_bars_held: number | null;
  /** Expectancy per trade in R units — the scale-free edge measure. A win rate
   *  can be raised just by shrinking the target, so the two are read together. */
  expectancy_r: number | null;
  avg_win_pct: number | null;
  avg_loss_pct: number | null;
  params: MomentumParams;
  exit_reasons: Record<string, number>;
  usable_window_start: string | null;
  last_bar_date: string | null;
  cost_bps_roundtrip: number;
  /** "point_in_time" once universe_snapshot covers the backtest window;
   *  "static_today" means today's index membership was applied backward, which
   *  is survivorship bias — surfaced in the header so the two can't be confused. */
  universe_mode: "static_today" | "point_in_time";
  equity_slots: number;
  starting_capital_rupees: number;
  max_concurrent_positions: number | null;
  metrics: EquityMetricsView | null;
  benchmark: BenchmarkView | null;
  caveats: string[];
}

interface BacktestTrade {
  symbol: string;
  entry_date: string;
  entry_paise: number;
  exit_date: string;
  exit_paise: number;
  exit_reason: string;
  bars_held: number;
  return_pct: number;
  /** Days to the scale-out leg, when one fired. */
  partial_bars_held?: number;
}

interface Envelope {
  status: string;
  message?: string;
  /** Echoed back by the route so a cached result can't be shown under the wrong
   *  label. */
  variant?: MomentumVariant;
  summary?: BacktestSummary;
  trades?: BacktestTrade[];
  /** Kept outside `summary` server-side so the summary stays small enough to log. */
  equity_curve?: EquityPoint[];
  benchmark_curve?: EquityPoint[];
  generated_at?: string;
}

type MomentumVariant = "live" | "v1";

const VARIANTS: { key: MomentumVariant; label: string; hint: string }[] = [
  {
    key: "live",
    label: "Live rule (shipped)",
    hint: "What the paper account trades today: stop 1.75×ATR, target 5R, book half at 1.5R then move the stop to entry, no trailing stop, 25-bar cap.",
  },
  {
    key: "v1",
    label: "Old rule (pre-2026-08-31)",
    hint: "The rule the live one replaced: stop 2×ATR, target 3R, breakeven at 1R, trail the 20-day low from 2R, 60-bar cap. Kept as the baseline — positions opened before the switch are still managed on it.",
  },
];

function describeParams(p: MomentumParams): string {
  const parts = [
    `stop ${p.stopAtrMult}×ATR`,
    `target ${p.targetRMultiple}R`,
    p.scaleOuts.length > 0
      ? `book ${p.scaleOuts.map((s) => `${Math.round(s.fraction * 100)}% at ${s.r}R`).join(" + ")}${p.breakevenAfterPartial ? ", then stop to entry" : ""}`
      : "single all-out exit",
    p.breakevenRMultiple !== null ? `breakeven at ${p.breakevenRMultiple}R` : "no auto-breakeven",
    p.trailRMultiple !== null ? `trail ${p.trailLookback}-day low from ${p.trailRMultiple}R` : "no trailing stop",
    `${p.timeExitBars}-bar time exit`,
  ];
  return parts.join(" · ");
}

function gainClass(v: number | null | undefined): string {
  if (v === null || v === undefined) return "text-muted-foreground";
  return v > 0 ? "text-emerald-600" : v < 0 ? "text-red-600" : "text-foreground";
}

function MiniStat({
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

export default function BacktestPanel({ strategyId }: { strategyId: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Keyed by variant so switching back to an already-run rule set is instant —
  // each run walks ~470 symbols' full history and takes the better part of a
  // minute, so re-running just to look again would be painful.
  const [results, setResults] = useState<Partial<Record<MomentumVariant, Envelope>>>({});
  const [variant, setVariant] = useState<MomentumVariant>("live");
  const [showTrades, setShowTrades] = useState(false);

  async function run(v: MomentumVariant) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/backtest/${encodeURIComponent(strategyId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant: v }),
      });
      const body = (await res.json().catch(() => null)) as Envelope | null;
      if (!res.ok || !body || body.status !== "ok") {
        setError(body?.message ?? `Failed (HTTP ${res.status})`);
        return;
      }
      setResults((prev) => ({ ...prev, [v]: body }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const result = results[variant] ?? null;
  const s = result?.summary;
  const live = results.live?.summary;
  const v1 = results.v1?.summary;
  const canCompare = live && v1;

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <FlaskConical className="w-4 h-4 text-violet-600" />
          <h2 className="text-sm font-medium">Backtest</h2>
        </div>
        <button
          onClick={() => run(variant)}
          disabled={loading}
          className="px-3 py-1.5 text-xs rounded-md border border-border text-foreground/80 hover:text-foreground hover:bg-muted/50 disabled:opacity-50"
        >
          {loading
            ? "Running backtest… (up to a minute)"
            : result
              ? "Re-run backtest"
              : "Run backtest"}
        </button>
      </div>

      <div className="mt-3 flex items-center gap-1 p-0.5 rounded-md border border-border bg-muted/40 w-fit">
        {VARIANTS.map((v) => (
          <button
            key={v.key}
            onClick={() => {
              setVariant(v.key);
              setError(null);
            }}
            title={v.hint}
            className={`px-2.5 py-1 text-xs rounded ${
              variant === v.key
                ? "bg-card border border-border font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {v.label}
            {results[v.key] && <span className="ml-1 text-emerald-600">✓</span>}
          </button>
        ))}
      </div>

      {error && (
        <p className="mt-3 text-xs text-red-600">{error}</p>
      )}

      {!result && !error && !loading && (
        <p className="mt-3 text-xs text-muted-foreground">
          Runs the strategy&apos;s technical rules (trend, breakout, volume, momentum ranking) across
          the full cached price history, applying whichever universe filter this strategy defines —
          see the caveats after running. Run both rule sets to compare them side by side; the{" "}
          <em>live</em> one is what the paper account trades today, the other is the rule it replaced.
        </p>
      )}

      {s && (
        <div className="mt-4 space-y-4">
          <div className="flex items-center gap-2 flex-wrap text-[11px]">
            <span
              className={`px-2 py-0.5 rounded-full border ${
                s.universe_mode === "point_in_time"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-amber-200 bg-amber-50 text-amber-800"
              }`}
              title={
                s.universe_mode === "point_in_time"
                  ? "Entries were gated on index membership as it stood on each trade date."
                  : "Today's index membership was applied backward across history — delisted and demoted names are missing, which flatters results."
              }
            >
              {s.universe_mode === "point_in_time" ? "Point-in-time universe" : "Static universe (survivorship bias)"}
            </span>
            <span
              className={`px-2 py-0.5 rounded-full border ${
                variant === "live"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-border bg-muted text-foreground/70"
              }`}
              title={VARIANTS.find((v) => v.key === variant)?.hint}
            >
              {variant === "live" ? "Live rule — trading" : "Old rule — baseline only"}
            </span>
            <span
              className={`px-2 py-0.5 rounded-full border ${
                s.quality_gate_applied
                  ? "border-border bg-muted text-foreground/70"
                  : "border-amber-200 bg-amber-50 text-amber-800"
              }`}
              title={
                s.quality_gate_applied
                  ? "Only symbols passing today's 6-check fundamental quality gate were eligible."
                  : "No fundamental filter — every NIFTY 500 name with enough price history was eligible, whatever its balance sheet."
              }
            >
              {s.quality_gate_applied ? "Quality gate on" : "No fundamental filter"}
            </span>
            <span className="text-muted-foreground">
              ₹{s.starting_capital_rupees.toLocaleString("en-IN")} start, sized at 1/{s.equity_slots} per position
              {s.max_concurrent_positions !== null && ` · peak ${s.max_concurrent_positions} open`}
            </span>
          </div>

          <p className="text-[11px] text-muted-foreground">
            Exit rule: {describeParams(s.params)}
          </p>

          {canCompare && (
            <div>
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">
                Live vs old rule — same universe, same window
              </p>
              <div className="rounded-lg border border-border overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-muted/60">
                    <tr className="border-b border-border text-muted-foreground uppercase tracking-wider">
                      <th className="px-2 py-1.5 text-left">Metric</th>
                      <th className="px-2 py-1.5 text-right">Old rule</th>
                      <th className="px-2 py-1.5 text-right">Live rule</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(
                      [
                        ["Win rate", (x: BacktestSummary) => x.win_rate_pct, (v: number) => `${v.toFixed(1)}%`],
                        ["Expectancy / trade", (x: BacktestSummary) => x.expectancy_r, (v: number) => `${v.toFixed(2)}R`],
                        ["Median days held", (x: BacktestSummary) => x.median_bars_held, (v: number) => v.toFixed(0)],
                        ["Profit factor", (x: BacktestSummary) => x.profit_factor, (v: number) => (v === Infinity ? "∞" : v.toFixed(2))],
                        ["CAGR", (x: BacktestSummary) => x.metrics?.cagr_pct ?? null, (v: number) => `${v.toFixed(1)}%`],
                        ["Sharpe", (x: BacktestSummary) => x.metrics?.sharpe ?? null, (v: number) => v.toFixed(2)],
                        ["Max drawdown", (x: BacktestSummary) => x.metrics?.max_drawdown_pct ?? null, (v: number) => `${v.toFixed(1)}%`],
                        ["Closed trades", (x: BacktestSummary) => x.n_trades, (v: number) => v.toFixed(0)],
                      ] as [string, (x: BacktestSummary) => number | null, (v: number) => string][]
                    ).map(([label, pick, fmt]) => {
                      // The live rule is the emphasised column — it's what the
                      // account trades; the old rule is context for the switch.
                      const o = pick(v1);
                      const l = pick(live);
                      return (
                        <tr key={label} className="border-b border-border/60 last:border-0">
                          <td className="px-2 py-1.5 text-muted-foreground">{label}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{o === null ? "—" : fmt(o)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums font-medium">{l === null ? "—" : fmt(l)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {result.equity_curve && result.equity_curve.length >= 2 && (
            <BacktestEquityChart
              strategy={result.equity_curve}
              benchmark={result.benchmark_curve}
              benchmarkLabel={s.benchmark?.label}
              startingValueRupees={s.starting_capital_rupees}
            />
          )}

          {s.metrics && (
            <div>
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">
                Portfolio level
              </p>
              <RiskMetricsGrid metrics={s.metrics} benchmark={s.benchmark} />
            </div>
          )}

          <div>
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">Trade level</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <MiniStat
                label="Closed trades"
                value={s.n_trades}
                hint="Trades with a real exit. The trade log below also lists positions still open at the last bar (exit reason data_end) but is capped at 500 rows, so its count can be either higher or lower than this."
              />
              <MiniStat label="Symbols traded" value={s.n_symbols_traded} />
              <MiniStat
                label="Win rate"
                value={s.win_rate_pct === null ? "—" : `${s.win_rate_pct.toFixed(1)}%`}
                hint="Share of closed trades with a positive net return. Read it alongside expectancy — a win rate alone can always be raised by taking profits earlier, which is not the same as a better strategy."
              />
              <MiniStat
                label="Expectancy / trade"
                value={
                  <span className={gainClass(s.expectancy_r)}>
                    {s.expectancy_r === null ? "—" : `${s.expectancy_r.toFixed(2)}R`}
                  </span>
                }
                hint="Average net return per trade expressed in units of the trade's own initial risk (entry-to-stop). Scale-free, so it's the number that says whether the edge is real."
              />
              <MiniStat
                label="Avg return / trade"
                value={
                  <span className={gainClass(s.avg_return_pct)}>
                    {s.avg_return_pct === null ? "—" : fmtPct(s.avg_return_pct)}
                  </span>
                }
              />
              <MiniStat
                label="Median return / trade"
                value={
                  <span className={gainClass(s.median_return_pct)}>
                    {s.median_return_pct === null ? "—" : fmtPct(s.median_return_pct)}
                  </span>
                }
              />
              <MiniStat
                label="Profit factor"
                value={s.profit_factor === null ? "—" : s.profit_factor === Infinity ? "∞" : s.profit_factor.toFixed(2)}
              />
              <MiniStat
                label="Avg win / avg loss"
                value={
                  s.avg_win_pct === null && s.avg_loss_pct === null
                    ? "—"
                    : `${s.avg_win_pct === null ? "—" : fmtPct(s.avg_win_pct)} / ${s.avg_loss_pct === null ? "—" : fmtPct(s.avg_loss_pct)}`
                }
                hint="Average net return of winning trades versus losing trades."
              />
              <MiniStat label="Avg days held" value={s.avg_bars_held === null ? "—" : s.avg_bars_held.toFixed(1)} />
              <MiniStat
                label="Median days held"
                value={s.median_bars_held === null ? "—" : s.median_bars_held.toFixed(0)}
                hint="Less distorted by the few trades that run to a far target than the average is — the better read on how long capital is actually tied up."
              />
              {s.n_partial_exits !== null && (
                <MiniStat
                  label="First profit booked"
                  value={
                    s.avg_partial_bars_held === null
                      ? "—"
                      : `${s.avg_partial_bars_held.toFixed(1)} days`
                  }
                  hint={`${s.n_partial_exits} of ${s.n_trades} trades reached their scale-out rung; this is the average number of days to that first booked profit.`}
                />
              )}
              <MiniStat
                label={s.quality_gate_applied ? "Qualifying universe" : "Eligible universe"}
                value={`${s.universe_with_enough_history} / ${s.universe_requested}`}
                hint={
                  s.quality_gate_applied
                    ? `${s.universe_quality_pass} of ${s.universe_requested} index members passed today's quality gate; ${s.universe_with_enough_history} of those also had 200+ days of cached history.`
                    : `No quality gate — ${s.universe_with_enough_history} of ${s.universe_requested} index members had the 200+ days of cached history the trend checks need.`
                }
              />
            </div>
          </div>

          <div className="text-xs text-muted-foreground">
            Exit reasons:{" "}
            {Object.entries(s.exit_reasons)
              .map(([reason, n]) => `${reason} (${n})`)
              .join(", ") || "—"}
            {s.usable_window_start && (
              <span> · signals eligible from {s.usable_window_start} to {s.last_bar_date}</span>
            )}
            {" "}· cost {s.cost_bps_roundtrip}bps round-trip
          </div>

          <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
            <p className="text-xs font-medium text-amber-900 mb-1">Caveats</p>
            <ul className="space-y-1">
              {s.caveats.map((c, i) => (
                <li key={i} className="text-xs text-amber-800 flex gap-1.5">
                  <span className="shrink-0">·</span>
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          </div>

          {result.trades && result.trades.length > 0 && (
            <div>
              <button
                onClick={() => setShowTrades((v) => !v)}
                className="text-xs text-primary hover:underline"
              >
                {showTrades ? "Hide" : "Show"} trade log ({result.trades.length}
                {result.trades.length === 500 ? "+, capped at 500" : ""})
              </button>
              {showTrades && (
                <div className="mt-2 rounded-lg border border-border overflow-x-auto max-h-80 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-muted/60">
                      <tr className="border-b border-border text-muted-foreground uppercase tracking-wider">
                        <th className="px-2 py-1.5 text-left">Symbol</th>
                        <th className="px-2 py-1.5 text-left">Entry</th>
                        <th className="px-2 py-1.5 text-left">Exit</th>
                        <th className="px-2 py-1.5 text-right">Return</th>
                        <th className="px-2 py-1.5 text-right">Days</th>
                        {s.n_partial_exits !== null && (
                          <th className="px-2 py-1.5 text-right" title="Days to the scale-out leg — blank if the trade never reached its rung.">
                            ½ at
                          </th>
                        )}
                        <th className="px-2 py-1.5 text-left">Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.trades.map((t, i) => (
                        <tr key={i} className="border-b border-border/60 last:border-0">
                          <td className="px-2 py-1.5 font-medium">{t.symbol}</td>
                          <td className="px-2 py-1.5 tabular-nums">{t.entry_date}</td>
                          <td className="px-2 py-1.5 tabular-nums">{t.exit_date}</td>
                          <td className={`px-2 py-1.5 text-right tabular-nums ${gainClass(t.return_pct)}`}>
                            {fmtPct(t.return_pct)}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{t.bars_held}</td>
                          {s.n_partial_exits !== null && (
                            <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                              {t.partial_bars_held ?? "—"}
                            </td>
                          )}
                          <td className="px-2 py-1.5 text-muted-foreground">{t.exit_reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

