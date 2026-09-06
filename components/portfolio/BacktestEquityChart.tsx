"use client";

import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import { fmtINR } from "./utils";

export interface EquityPoint {
  date: string;
  value_rupees: number;
}

interface Props {
  strategy: EquityPoint[];
  /** Benchmark normalized to the same starting capital. Empty = no overlay. */
  benchmark?: EquityPoint[];
  benchmarkLabel?: string;
  startingValueRupees: number;
  title?: string;
  height?: number;
}

const STRATEGY_COLOR = "#4F46E5"; // primary
const BENCHMARK_COLOR = "#94A3B8"; // muted-foreground

/**
 * Backtest equity curve with an optional benchmark overlay.
 *
 * Distinct from StrategyEquityChart (actual vs projected on a LIVE account):
 * this compares a backtested curve against a market yardstick. The two series
 * are merged by DATE rather than by position — our Nifty ETF proxy is missing
 * ~10-17% of trading days, so zipping them positionally would slide the
 * benchmark forward relative to the strategy and misdraw the comparison.
 */
export default function BacktestEquityChart({
  strategy,
  benchmark = [],
  benchmarkLabel = "Benchmark",
  startingValueRupees,
  title = "Portfolio value",
  height = 260,
}: Props) {
  if (strategy.length < 2) return null;

  const byDate = new Map<string, { date: string; strategy?: number; benchmark?: number }>();
  for (const p of strategy) byDate.set(p.date, { date: p.date, strategy: p.value_rupees });
  for (const p of benchmark) {
    const row = byDate.get(p.date);
    if (row) row.benchmark = p.value_rupees;
    else byDate.set(p.date, { date: p.date, benchmark: p.value_rupees });
  }
  const merged = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

  const final = strategy[strategy.length - 1].value_rupees;
  const finalBench = benchmark.length > 0 ? benchmark[benchmark.length - 1].value_rupees : null;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
        <h3 className="text-sm font-medium">{title}</h3>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className="w-2.5 h-0.5 rounded-full" style={{ backgroundColor: STRATEGY_COLOR }} />
            Strategy {fmtINR(final, 0)}
          </span>
          {finalBench !== null && (
            <span className="inline-flex items-center gap-1">
              <span
                className="w-2.5 border-t border-dashed"
                style={{ borderColor: BENCHMARK_COLOR }}
              />
              {benchmarkLabel} {fmtINR(finalBench, 0)}
            </span>
          )}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={merged} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="backtest-equity-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={STRATEGY_COLOR} stopOpacity={0.18} />
              <stop offset="95%" stopColor={STRATEGY_COLOR} stopOpacity={0.01} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(15,23,42,0.06)" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: "#64748B" }}
            tickLine={false}
            axisLine={false}
            minTickGap={50}
          />
          <YAxis
            tick={{ fontSize: 11, fill: "#64748B" }}
            tickLine={false}
            axisLine={false}
            width={70}
            tickFormatter={(v) => fmtINR(v, 0)}
            domain={["auto", "auto"]}
          />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as { date: string; strategy?: number; benchmark?: number };
              return (
                <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-lg text-sm">
                  <p className="text-muted-foreground text-xs mb-1">{p.date}</p>
                  {p.strategy !== undefined && (
                    <p className="font-semibold text-foreground num">Strategy {fmtINR(p.strategy, 0)}</p>
                  )}
                  {p.benchmark !== undefined && (
                    <p className="text-muted-foreground num text-xs">
                      {benchmarkLabel} {fmtINR(p.benchmark, 0)}
                    </p>
                  )}
                </div>
              );
            }}
          />
          <ReferenceLine
            y={startingValueRupees}
            stroke="#94A3B8"
            strokeDasharray="4 3"
            label={{
              value: `Start ${fmtINR(startingValueRupees, 0)}`,
              position: "insideBottomRight",
              fontSize: 10,
              fill: "#64748B",
            }}
          />
          <Area
            type="monotone"
            dataKey="strategy"
            stroke={STRATEGY_COLOR}
            strokeWidth={2}
            fill="url(#backtest-equity-fill)"
            dot={false}
            activeDot={{ r: 4, fill: STRATEGY_COLOR, stroke: "#fff", strokeWidth: 2 }}
            connectNulls
          />
          <Line
            type="monotone"
            dataKey="benchmark"
            stroke={BENCHMARK_COLOR}
            strokeWidth={1.5}
            strokeDasharray="5 4"
            dot={false}
            activeDot={{ r: 3, fill: BENCHMARK_COLOR, stroke: "#fff", strokeWidth: 2 }}
            connectNulls
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
