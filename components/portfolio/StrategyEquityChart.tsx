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

interface EquityPoint {
  date: string;
  value_rupees: number;
}

interface Props {
  history: EquityPoint[];
  projection: EquityPoint[];
  startingValueRupees: number;
  caveats: string[];
}

const COLOR = "#4F46E5"; // primary
const PROJECTION_COLOR = "#94A3B8"; // muted-foreground

export default function StrategyEquityChart({ history, projection, startingValueRupees, caveats }: Props) {
  if (history.length < 2) {
    return (
      <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
        Portfolio value chart appears once this strategy has traded for a few days.
      </div>
    );
  }

  // Merge into one array keyed by date so recharts can render both series on
  // a shared x-axis: `actual` populated for history dates, `projected` for
  // projection dates (the two overlap at exactly one date, the last actual
  // point, so the lines visually connect).
  const merged: { date: string; actual?: number; projected?: number }[] = [
    ...history.map((p) => ({ date: p.date, actual: p.value_rupees })),
    ...projection.map((p) => ({ date: p.date, projected: p.value_rupees })),
  ];

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium">Portfolio value</h3>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className="w-2.5 h-0.5 rounded-full" style={{ backgroundColor: COLOR }} />
            Actual
          </span>
          <span className="inline-flex items-center gap-1">
            <span
              className="w-2.5 h-0.5 rounded-full border-t border-dashed"
              style={{ borderColor: PROJECTION_COLOR }}
            />
            Projected (illustrative only)
          </span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart data={merged} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="strategy-equity-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={COLOR} stopOpacity={0.18} />
              <stop offset="95%" stopColor={COLOR} stopOpacity={0.01} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(15,23,42,0.06)" vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#64748B" }} tickLine={false} axisLine={false} minTickGap={50} />
          <YAxis
            tick={{ fontSize: 11, fill: "#64748B" }}
            tickLine={false}
            axisLine={false}
            width={70}
            tickFormatter={(v) => fmtINR(v, 0)}
            domain={["auto", "auto"]}
          />
          <Tooltip
            content={({ active, payload }: any) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as { date: string; actual?: number; projected?: number };
              const isProjected = p.actual === undefined;
              return (
                <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-lg text-sm">
                  <p className="text-muted-foreground text-xs mb-1">
                    {p.date} {isProjected && <span className="italic">(projected)</span>}
                  </p>
                  <p className="font-semibold text-foreground num">
                    {fmtINR((p.actual ?? p.projected ?? 0), 0)}
                  </p>
                </div>
              );
            }}
          />
          <ReferenceLine
            y={startingValueRupees}
            stroke="#94A3B8"
            strokeDasharray="4 3"
            label={{ value: `Start ${fmtINR(startingValueRupees, 0)}`, position: "insideBottomRight", fontSize: 10, fill: "#64748B" }}
          />
          <Area
            type="monotone"
            dataKey="actual"
            stroke={COLOR}
            strokeWidth={2}
            fill="url(#strategy-equity-fill)"
            dot={false}
            activeDot={{ r: 4, fill: COLOR, stroke: "#fff", strokeWidth: 2 }}
            connectNulls={false}
          />
          <Line
            type="monotone"
            dataKey="projected"
            stroke={PROJECTION_COLOR}
            strokeWidth={2}
            strokeDasharray="5 5"
            dot={false}
            activeDot={{ r: 4, fill: PROJECTION_COLOR, stroke: "#fff", strokeWidth: 2 }}
            connectNulls
          />
        </ComposedChart>
      </ResponsiveContainer>
      {caveats.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {caveats.map((c, i) => (
            <li key={i} className="text-[11px] text-muted-foreground/80">
              {c}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

