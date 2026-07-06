"use client";

import { useMemo, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import type { Holding, FundamentalItem, Peer } from "@/lib/types";
import { fmtINR, fmtINRSigned, fmtPct, fmtNum, gainTextClass } from "./utils";

interface Props {
  holding: Holding;
  fundamentals: FundamentalItem[];
  analysis: string | null;
  peers: Peer[];
  portfolioCurrentValue: number;
  seed: number;
}

// Deterministic pseudo-random (seeded) so server and client renders match — no Math.random().
function seededHistory(ltp: number, avgPrice: number, seed: number, days = 180) {
  const data: { date: string; price: number; avg: number }[] = [];
  const start = new Date("2026-01-06");
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
  let price = avgPrice * (0.92 + rand() * 0.06);
  const drift = (ltp - price) / days;
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    price += drift + (rand() - 0.48) * price * 0.012;
    price = Math.max(price, avgPrice * 0.5);
    data.push({
      date: d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
      price: Math.round(price * 100) / 100,
      avg: avgPrice,
    });
  }
  return data;
}

function GradePill({ grade }: { grade: "Good" | "Fair" | "Weak" }) {
  const cls = {
    Good: "bg-emerald-50 text-emerald-700 border border-emerald-200",
    Fair: "bg-amber-50 text-amber-700 border border-amber-200",
    Weak: "bg-red-50 text-red-700 border border-red-200",
  }[grade];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${cls}`}>
      {grade}
    </span>
  );
}

function StatCard({
  label,
  value,
  sub,
  valueClass,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  valueClass?: string;
}) {
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1.5">{label}</p>
      <p className={`text-base font-semibold num ${valueClass ?? "text-foreground"}`}>{value}</p>
      {sub && <p className="text-xs num mt-0.5 text-muted-foreground">{sub}</p>}
    </div>
  );
}

export default function DeepDiveClient({
  holding,
  fundamentals,
  analysis,
  peers,
  portfolioCurrentValue,
  seed,
}: Props) {
  const priceHistory = useMemo(
    () => seededHistory(holding.ltp, holding.avgPrice, seed),
    [holding.ltp, holding.avgPrice, seed],
  );

  const daySign = holding.dayChangePct >= 0 ? "+" : "−";
  const isGain = holding.pnl >= 0;
  const chartColor = isGain ? "#16A34A" : "#DC2626";
  const hasDetail = fundamentals.length > 0 || peers.length > 0 || !!analysis;

  return (
    <div className="bg-background">
      <div className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Link
          href="/"
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary transition-colors mb-6 group"
        >
          <ArrowLeft className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" />
          Portfolio
        </Link>

        {/* Stock header */}
        <div className="flex flex-wrap items-start gap-4 justify-between mb-8">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h1 className="text-3xl font-semibold text-foreground tracking-tight num">{holding.symbol}</h1>
              <span className="text-xs font-semibold px-2 py-1 rounded-md bg-primary/10 text-primary border border-primary/20">
                {holding.exchange}
              </span>
            </div>
            <p className="text-muted-foreground text-sm">{holding.company}</p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-semibold text-foreground num">{fmtINR(holding.ltp, 2)}</p>
            <p className={`text-sm num font-medium mt-0.5 ${gainTextClass(holding.dayChangePct)}`}>
              {daySign}
              {Math.abs(holding.dayChangePct).toFixed(2)}%&ensp;
              <span className={gainTextClass(holding.dayPnl)}>{fmtINRSigned(holding.dayPnl)}</span>
              <span className="text-muted-foreground font-normal"> today</span>
            </p>
          </div>
        </div>

        <div className="border-t border-border mb-8" />

        {/* Price chart */}
        <section className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-foreground">Price History</h2>
            <span className="text-xs text-muted-foreground">Jan – Jul 2026 · simulated</span>
          </div>
          <div className="bg-card border border-border rounded-xl px-2 py-5">
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={priceHistory} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id={`grad-${holding.symbol}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={chartColor} stopOpacity={0.18} />
                    <stop offset="95%" stopColor={chartColor} stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(15,23,42,0.06)" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: "#64748B" }}
                  tickLine={false}
                  axisLine={false}
                  interval={Math.floor(priceHistory.length / 6)}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "#64748B" }}
                  tickLine={false}
                  axisLine={false}
                  width={70}
                  tickFormatter={(v) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(v)}`}
                  domain={["auto", "auto"]}
                />
                <Tooltip
                  content={({ active, payload }: any) => {
                    if (!active || !payload?.length) return null;
                    const p = payload[0].payload;
                    return (
                      <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-lg text-sm">
                        <p className="text-muted-foreground text-xs mb-1">{p.date}</p>
                        <p className="font-semibold text-foreground num">{fmtINR(p.price, 2)}</p>
                        <p className="text-xs text-muted-foreground num">Avg cost {fmtINR(p.avg, 2)}</p>
                      </div>
                    );
                  }}
                />
                <Area type="monotone" dataKey="avg" stroke="#94A3B8" strokeWidth={1} strokeDasharray="4 3" fill="none" dot={false} activeDot={false} />
                <Area
                  type="monotone"
                  dataKey="price"
                  stroke={chartColor}
                  strokeWidth={2}
                  fill={`url(#grad-${holding.symbol})`}
                  dot={false}
                  activeDot={{ r: 4, fill: chartColor, stroke: "#fff", strokeWidth: 2 }}
                />
              </AreaChart>
            </ResponsiveContainer>
            <div className="flex items-center gap-6 justify-end px-4 pt-2">
              <div className="flex items-center gap-1.5">
                <span className="w-5 border-t-2 border-dashed border-slate-400" />
                <span className="text-xs text-muted-foreground">Avg cost {fmtINR(holding.avgPrice, 2)}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-5 border-t-2" style={{ borderColor: chartColor }} />
                <span className="text-xs text-muted-foreground">LTP {fmtINR(holding.ltp, 2)}</span>
              </div>
            </div>
          </div>
        </section>

        {/* Your Position */}
        <section className="mb-8">
          <h2 className="font-semibold text-foreground mb-4">Your Position</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Qty" value={holding.qty} />
            <StatCard label="Avg Cost" value={fmtINR(holding.avgPrice, 2)} />
            <StatCard label="LTP" value={fmtINR(holding.ltp, 2)} />
            <StatCard label="Invested" value={fmtINR(holding.invested)} />
            <StatCard label="Current Value" value={fmtINR(holding.current)} />
            <StatCard label="P&L (₹)" value={fmtINRSigned(holding.pnl)} sub={fmtPct(holding.pnlPct)} valueClass={gainTextClass(holding.pnl)} />
            <StatCard label="Day P&L" value={fmtINRSigned(holding.dayPnl)} sub={fmtPct(holding.dayChangePct)} valueClass={gainTextClass(holding.dayPnl)} />
            <StatCard
              label="Portfolio Weight"
              value={<>{fmtNum(holding.weight, 1)}%</>}
              sub={`of ₹${(portfolioCurrentValue / 100000).toFixed(1)}L total`}
            />
          </div>
        </section>

        {/* Fundamentals + Analysis */}
        {hasDetail ? (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.1fr] gap-6 mb-8">
              <section>
                <h2 className="font-semibold text-foreground mb-4">Fundamentals</h2>
                <div className="bg-card border border-border rounded-xl overflow-hidden">
                  {fundamentals.length > 0 ? (
                    <div className="grid grid-cols-1 divide-y divide-border">
                      {fundamentals.map((item) => (
                        <div key={item.label} className="flex items-center justify-between px-4 py-3 hover:bg-muted/20 transition-colors">
                          <span className="text-sm text-muted-foreground">{item.label}</span>
                          <div className="flex items-center gap-3">
                            <span className="text-sm font-semibold text-foreground num">{item.value}</span>
                            <GradePill grade={item.grade} />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="px-4 py-6 text-sm text-muted-foreground">No fundamentals yet.</p>
                  )}
                </div>
              </section>

              <section>
                <h2 className="font-semibold text-foreground mb-4">Analysis</h2>
                <div className="bg-card border border-border rounded-xl p-5 h-full">
                  <p className="text-sm text-foreground/80 leading-relaxed">
                    {analysis ?? "No analysis generated yet."}
                  </p>
                  <p className="text-xs text-muted-foreground mt-4 pt-4 border-t border-border">
                    Analysis is AI-generated for informational purposes. Verify with primary sources before making investment decisions.
                  </p>
                </div>
              </section>
            </div>

            {peers.length > 0 && (
              <section className="mb-8">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="font-semibold text-foreground">Peer Comparison</h2>
                  <span className="text-xs text-muted-foreground">Trailing twelve months</span>
                </div>
                <div className="bg-card border border-border rounded-xl overflow-hidden overflow-x-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="border-b border-border bg-muted/40">
                        <th className="px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider text-left">Company</th>
                        <th className="px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">P/E</th>
                        <th className="px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">ROE</th>
                        <th className="px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">ROCE</th>
                        <th className="px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">Sales Growth (3Y)</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-b border-border bg-primary/5">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span className="w-1.5 h-4 rounded-full bg-primary shrink-0" />
                            <div>
                              <p className="font-semibold text-foreground num">{holding.symbol}</p>
                              <p className="text-xs text-muted-foreground">{holding.company}</p>
                            </div>
                          </div>
                        </td>
                        {(() => {
                          const pe = fundamentals.find((x) => x.label === "P/E Ratio")?.value ?? "—";
                          const roe = fundamentals.find((x) => x.label === "ROE")?.value ?? "—";
                          const roce =
                            fundamentals.find((x) => x.label === "ROCE")?.value ??
                            fundamentals.find((x) => x.label.includes("NIM"))?.value ?? "—";
                          const sg =
                            fundamentals.find((x) => x.label.includes("Sales Growth") || x.label.includes("Revenue Growth"))?.value ?? "—";
                          return (
                            <>
                              <td className="px-4 py-3 text-right num font-semibold text-foreground">{pe}</td>
                              <td className="px-4 py-3 text-right num font-semibold text-foreground">{roe}</td>
                              <td className="px-4 py-3 text-right num font-semibold text-foreground">{roce}</td>
                              <td className="px-4 py-3 text-right num font-semibold text-foreground">{sg}</td>
                            </>
                          );
                        })()}
                      </tr>
                      {peers.map((peer) => (
                        <tr key={peer.symbol} className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <span className="w-1.5 h-4 rounded-full bg-border shrink-0" />
                              <div>
                                <p className="font-medium text-foreground num">{peer.symbol}</p>
                                <p className="text-xs text-muted-foreground">{peer.company}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right num text-foreground">
                            {peer.pe !== null ? `${fmtNum(peer.pe, 1)}×` : "—"}
                          </td>
                          <td className="px-4 py-3 text-right num text-foreground">
                            <span className={peer.roe < 0 ? "text-red-600" : "text-foreground"}>{fmtNum(peer.roe, 1)}%</span>
                          </td>
                          <td className="px-4 py-3 text-right num text-foreground">
                            {peer.roce !== null ? `${fmtNum(peer.roce, 1)}%` : "—"}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <span className={`num ${gainTextClass(peer.salesGrowth)}`}>{fmtPct(peer.salesGrowth, 1)}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </>
        ) : (
          <div className="bg-card border border-border rounded-xl p-6 mb-8 text-sm text-muted-foreground">
            No fundamentals, analysis, or peer data yet for {holding.symbol}. These populate once the Screener
            ingestion runs.
          </div>
        )}

        <p className="text-center text-xs text-muted-foreground/60 pb-4">
          Prices may be delayed by up to 15 min · For informational use only
        </p>
      </div>
    </div>
  );
}
