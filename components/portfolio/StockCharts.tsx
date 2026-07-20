"use client";

import { useEffect, useState } from "react";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import { fmtINR, fmtNum } from "./utils";

type MetricKey = "price" | "sales" | "eps";
type Range = "1Y" | "3Y" | "5Y" | "ALL";

const METRICS: { key: MetricKey; label: string }[] = [
  { key: "price", label: "Price" },
  { key: "sales", label: "Quarterly Sales" },
  { key: "eps", label: "EPS" },
];
const RANGES: Range[] = ["1Y", "3Y", "5Y", "ALL"];

interface Point {
  date: string;
  value: number;
}

export default function StockCharts({
  symbol,
  avgPrice,
  isGain,
}: {
  symbol: string;
  avgPrice: number;
  isGain: boolean;
}) {
  const [metric, setMetric] = useState<MetricKey>("price");
  const [range, setRange] = useState<Range>("1Y");
  const [points, setPoints] = useState<Point[]>([]);
  const [state, setState] = useState<"loading" | "ok" | "empty" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    fetch(`/api/chart/${encodeURIComponent(symbol)}?metric=${metric}&range=${range}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        const pts: Point[] = j.points ?? [];
        setPoints(pts);
        setState(j.status === "ok" && pts.length > 0 ? "ok" : j.status === "error" ? "error" : "empty");
      })
      .catch(() => !cancelled && setState("error"));
    return () => {
      cancelled = true;
    };
  }, [symbol, metric, range]);

  const color = isGain ? "#16A34A" : "#DC2626";
  const isPrice = metric === "price";
  const fmtVal = (v: number) =>
    isPrice ? fmtINR(v, 0) : metric === "eps" ? `₹${fmtNum(v, 1)}` : `₹${fmtNum(v, 0)} Cr`;

  return (
    <section className="mb-8">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <h2 className="font-semibold text-foreground">Charts</h2>
        <div className="flex flex-wrap items-center gap-2">
          {/* Metric toggle */}
          <div className="flex rounded-lg border border-border overflow-hidden">
            {METRICS.map((m) => (
              <button
                key={m.key}
                onClick={() => setMetric(m.key)}
                className={`px-2.5 py-1 text-xs transition-colors ${
                  metric === m.key
                    ? "bg-primary text-primary-foreground"
                    : "bg-card text-muted-foreground hover:text-foreground"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
          {/* Range toggle */}
          <div className="flex rounded-lg border border-border overflow-hidden">
            {RANGES.map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`px-2.5 py-1 text-xs num transition-colors ${
                  range === r
                    ? "bg-primary text-primary-foreground"
                    : "bg-card text-muted-foreground hover:text-foreground"
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl px-2 py-5">
        {state === "loading" && (
          <div className="h-[240px] animate-pulse rounded-lg bg-muted/40" />
        )}
        {state === "empty" && (
          <div className="h-[240px] flex items-center justify-center text-sm text-muted-foreground">
            No {METRICS.find((m) => m.key === metric)?.label.toLowerCase()} data available.
          </div>
        )}
        {state === "error" && (
          <div className="h-[240px] flex items-center justify-center text-sm text-muted-foreground">
            Could not load chart data.
          </div>
        )}
        {state === "ok" && (
          <ResponsiveContainer width="100%" height={240}>
            {isPrice ? (
              <AreaChart data={points} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id={`g-${symbol}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={color} stopOpacity={0.18} />
                    <stop offset="95%" stopColor={color} stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(15,23,42,0.06)" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#64748B" }} tickLine={false} axisLine={false} minTickGap={40} />
                <YAxis
                  tick={{ fontSize: 11, fill: "#64748B" }}
                  tickLine={false}
                  axisLine={false}
                  width={64}
                  tickFormatter={(v) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(v)}`}
                  domain={["auto", "auto"]}
                />
                <Tooltip
                  content={({ active, payload }: any) => {
                    if (!active || !payload?.length) return null;
                    const p = payload[0].payload as Point;
                    return (
                      <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-lg text-sm">
                        <p className="text-muted-foreground text-xs mb-1">{p.date}</p>
                        <p className="font-semibold text-foreground num">{fmtVal(p.value)}</p>
                      </div>
                    );
                  }}
                />
                <ReferenceLine
                  y={avgPrice}
                  stroke="#94A3B8"
                  strokeDasharray="4 3"
                  label={{ value: `Avg ${fmtINR(avgPrice, 0)}`, position: "insideTopRight", fontSize: 10, fill: "#64748B" }}
                />
                <Area type="monotone" dataKey="value" stroke={color} strokeWidth={2} fill={`url(#g-${symbol})`} dot={false} activeDot={{ r: 4, fill: color, stroke: "#fff", strokeWidth: 2 }} />
              </AreaChart>
            ) : (
              <BarChart data={points} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(15,23,42,0.06)" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#64748B" }} tickLine={false} axisLine={false} minTickGap={20} />
                <YAxis tick={{ fontSize: 11, fill: "#64748B" }} tickLine={false} axisLine={false} width={64} />
                <Tooltip
                  content={({ active, payload }: any) => {
                    if (!active || !payload?.length) return null;
                    const p = payload[0].payload as Point;
                    return (
                      <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-lg text-sm">
                        <p className="text-muted-foreground text-xs mb-1">{p.date}</p>
                        <p className="font-semibold text-foreground num">{fmtVal(p.value)}</p>
                      </div>
                    );
                  }}
                />
                <Bar dataKey="value" fill="#6366F1" radius={[3, 3, 0, 0]} />
              </BarChart>
            )}
          </ResponsiveContainer>
        )}
        <p className="text-center text-xs text-muted-foreground/70 pt-2">Source: Screener.in</p>
      </div>
    </section>
  );
}
