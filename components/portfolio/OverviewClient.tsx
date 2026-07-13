"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Sparkles,
  AlertTriangle,
} from "lucide-react";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";
import type { Holding, PortfolioSummary } from "@/lib/types";
import {
  fmtINR,
  fmtINRSigned,
  fmtPct,
  fmtNum,
  gainTextClass,
  gainBadgeClass,
} from "./utils";

interface Props {
  holdings: Holding[];
  summary: PortfolioSummary;
  insights: string | null;
}

function KpiCard({
  label,
  value,
  sub,
  highlight,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-xl p-5 border ${highlight ? "bg-primary text-primary-foreground border-primary/20" : "bg-card border-border"}`}
    >
      <p
        className={`text-xs uppercase tracking-widest mb-2 ${highlight ? "text-primary-foreground/70" : "text-muted-foreground"}`}
      >
        {label}
      </p>
      <p
        className={`text-xl font-semibold num ${highlight ? "text-primary-foreground" : "text-foreground"}`}
      >
        {value}
      </p>
      {sub && (
        <p
          className={`text-xs mt-1 num ${highlight ? "text-primary-foreground/80" : "text-muted-foreground"}`}
        >
          {sub}
        </p>
      )}
    </div>
  );
}

const DONUT_COLORS_BY_IDX = [
  "#6366F1", "#3B82F6", "#0EA5E9", "#10B981", "#84CC16",
  "#F59E0B", "#F97316", "#EF4444", "#EC4899", "#8B5CF6",
  "#06B6D4", "#14B8A6", "#64748B", "#A855F7", "#D946EF",
];

function AllocationDonut({
  holdings,
  onSelect,
}: {
  holdings: Holding[];
  onSelect: (s: Holding) => void;
}) {
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const data = holdings.map((h, i) => ({
    name: h.symbol,
    value: h.current,
    pnlPct: h.pnlPct,
    holding: h,
    fill: DONUT_COLORS_BY_IDX[i % DONUT_COLORS_BY_IDX.length],
  }));

  const CustomTooltip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    return (
      <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-lg text-sm">
        <p className="font-semibold text-foreground">{d.name}</p>
        <p className="text-muted-foreground num">{fmtINR(d.value)}</p>
        <p className={`num font-medium ${gainTextClass(d.pnlPct)}`}>{fmtPct(d.pnlPct)}</p>
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col">
      <ResponsiveContainer width="100%" height={260}>
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius={72}
            outerRadius={110}
            paddingAngle={2}
            dataKey="value"
            onMouseEnter={(_, i) => setActiveIdx(i)}
            onMouseLeave={() => setActiveIdx(null)}
            onClick={(d: any) => onSelect(d.payload.holding)}
            style={{ cursor: "pointer" }}
          >
            {data.map((entry, i) => (
              <Cell
                key={entry.name}
                fill={entry.fill}
                opacity={activeIdx === null || activeIdx === i ? 1 : 0.45}
                stroke={activeIdx === i ? "#fff" : "transparent"}
                strokeWidth={activeIdx === i ? 2 : 0}
              />
            ))}
          </Pie>
          <Tooltip content={<CustomTooltip />} />
        </PieChart>
      </ResponsiveContainer>

      <div
        className="grid grid-cols-2 gap-x-4 gap-y-1.5 mt-2 overflow-y-auto max-h-52 pr-1"
        style={{ scrollbarWidth: "none" }}
      >
        {data.map((d) => (
          <button
            key={d.name}
            onClick={() => onSelect(d.holding)}
            className="flex items-center gap-2 text-left hover:bg-muted/60 rounded-md px-1.5 py-1 transition-colors group"
          >
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: d.fill }} />
            <span className="text-xs text-foreground/80 group-hover:text-foreground truncate">{d.name}</span>
            <span className={`text-xs num ml-auto shrink-0 ${gainTextClass(d.pnlPct)}`}>{fmtPct(d.pnlPct)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

type SortKey = keyof Holding;

function HoldingsTable({
  holdings,
  onSelect,
}: {
  holdings: Holding[];
  onSelect: (h: Holding) => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("current");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const sorted = [...holdings].sort((a, b) => {
    const av = a[sortKey] as number;
    const bv = b[sortKey] as number;
    return sortDir === "desc" ? bv - av : av - bv;
  });

  function handleSort(k: SortKey) {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setSortDir("desc");
    }
  }

  const Th = ({ label, k, right }: { label: string; k: SortKey; right?: boolean }) => (
    <th
      onClick={() => handleSort(k)}
      className={`px-3 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider cursor-pointer select-none hover:text-foreground transition-colors ${right ? "text-right" : "text-left"}`}
    >
      {label}
      {sortKey === k ? (sortDir === "desc" ? " ↓" : " ↑") : ""}
    </th>
  );

  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card" style={{ scrollbarWidth: "thin" }}>
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-border bg-muted/40">
            <th className="px-3 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider text-left sticky left-0 bg-muted/40 z-10">Symbol</th>
            <th className="px-3 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider text-left">Exch</th>
            <Th label="Qty" k="qty" right />
            <Th label="Avg" k="avgPrice" right />
            <Th label="LTP" k="ltp" right />
            <Th label="Invested" k="invested" right />
            <Th label="Current" k="current" right />
            <Th label="Day %" k="dayChangePct" right />
            <Th label="P&L" k="pnl" right />
            <Th label="P&L %" k="pnlPct" right />
            <Th label="Wt %" k="weight" right />
          </tr>
        </thead>
        <tbody>
          {sorted.map((h, i) => (
            <tr
              key={`${h.symbol}-${h.exchange}`}
              className={`border-b border-border last:border-0 hover:bg-muted/30 transition-colors ${i % 2 === 0 ? "" : "bg-muted/10"}`}
            >
              <td className="px-3 py-3 sticky left-0 z-10 bg-card">
                <button
                  onClick={() => onSelect(h)}
                  className="font-semibold text-primary hover:text-primary/80 hover:underline underline-offset-2 transition-colors num tracking-wide"
                >
                  {h.symbol}
                </button>
              </td>
              <td className="px-3 py-3">
                <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium">{h.exchange}</span>
              </td>
              <td className="px-3 py-3 text-right num text-foreground">{h.qty}</td>
              <td className="px-3 py-3 text-right num text-foreground">{fmtINR(h.avgPrice, 2)}</td>
              <td className="px-3 py-3 text-right num text-foreground font-medium">{fmtINR(h.ltp, 2)}</td>
              <td className="px-3 py-3 text-right num text-foreground">{fmtINR(h.invested)}</td>
              <td className="px-3 py-3 text-right num text-foreground">{fmtINR(h.current)}</td>
              <td className={`px-3 py-3 text-right num font-medium ${gainTextClass(h.dayChangePct)}`}>{fmtPct(h.dayChangePct)}</td>
              <td className={`px-3 py-3 text-right num font-medium ${gainTextClass(h.pnl)}`}>{fmtINRSigned(h.pnl)}</td>
              <td className="px-3 py-3 text-right">
                <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs num font-medium ${gainBadgeClass(h.pnlPct)}`}>
                  {fmtPct(h.pnlPct)}
                </span>
              </td>
              <td className="px-3 py-3 text-right num text-muted-foreground">{fmtNum(h.weight, 1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="px-4 py-2 border-t border-border bg-muted/20 text-xs text-muted-foreground">
        Showing {holdings.length} of {holdings.length} holdings · Click column headers to sort · Click symbol for deep dive
      </div>
    </div>
  );
}

function WinnersLosers({
  holdings,
  onSelect,
}: {
  holdings: Holding[];
  onSelect: (h: Holding) => void;
}) {
  const sorted = [...holdings].sort((a, b) => b.pnlPct - a.pnlPct);
  const winners = sorted.slice(0, 5);
  const losers = sorted.slice(-5).reverse();

  const Row = ({ h, rank }: { h: Holding; rank: number }) => (
    <div className="flex items-center gap-3 py-2 border-b border-border last:border-0 hover:bg-muted/30 rounded-lg px-2 -mx-2 transition-colors">
      <span className="text-xs text-muted-foreground num w-4 shrink-0">{rank}</span>
      <button
        onClick={() => onSelect(h)}
        className="font-semibold text-primary hover:underline underline-offset-2 text-sm num w-24 text-left shrink-0"
      >
        {h.symbol}
      </button>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-muted-foreground truncate">{h.company}</p>
      </div>
      <div className="text-right shrink-0">
        <p className={`text-sm num font-semibold ${gainTextClass(h.pnlPct)}`}>{fmtPct(h.pnlPct)}</p>
        <p className={`text-xs num ${gainTextClass(h.pnl)}`}>{fmtINRSigned(h.pnl)}</p>
      </div>
    </div>
  );

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div className="bg-card rounded-xl border border-border p-5">
        <div className="flex items-center gap-2 mb-4">
          <TrendingUp className="w-4 h-4 text-emerald-600" />
          <h3 className="font-semibold text-foreground">Top Winners</h3>
          <span className="ml-auto text-xs text-muted-foreground num">by P&amp;L %</span>
        </div>
        {winners.map((h, i) => (
          <Row key={`${h.symbol}-${h.exchange}`} h={h} rank={i + 1} />
        ))}
      </div>
      <div className="bg-card rounded-xl border border-border p-5">
        <div className="flex items-center gap-2 mb-4">
          <TrendingDown className="w-4 h-4 text-red-600" />
          <h3 className="font-semibold text-foreground">Top Losers</h3>
          <span className="ml-auto text-xs text-muted-foreground num">by P&amp;L %</span>
        </div>
        {losers.map((h, i) => (
          <Row key={`${h.symbol}-${h.exchange}`} h={h} rank={i + 1} />
        ))}
      </div>
    </div>
  );
}

export default function OverviewClient({ holdings, summary, insights }: Props) {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);

  const topHoldings = [...holdings].sort((a, b) => b.current - a.current).slice(0, 5);
  const top5Weight = topHoldings.reduce((s, h) => s + h.weight, 0);

  function goTo(h: Holding) {
    router.push(`/stock/${encodeURIComponent(h.symbol)}?exchange=${h.exchange}`);
  }

  // MCP flow: new data is pulled by the `/portfolio` command (agent → MCP →
  // ingest). The in-app button just re-reads the latest snapshot from SQLite.
  function handleRefresh() {
    setRefreshing(true);
    router.refresh();
    // router.refresh() re-renders the server component; clear the spinner shortly after.
    setTimeout(() => setRefreshing(false), 800);
  }

  return (
    <div className="bg-background">
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="flex items-start justify-between mb-8">
          <div>
            <h1 className="text-3xl font-semibold text-foreground tracking-tight">Portfolio</h1>
            <p className="text-muted-foreground mt-0.5 text-sm">
              {summary.holdingsCount} holdings · updated {summary.asOf}
            </p>
          </div>
          <button
            onClick={handleRefresh}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-card border border-border text-sm text-muted-foreground hover:text-foreground hover:border-primary/30 hover:bg-muted/50 transition-all"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
          <KpiCard label="Current Value" value={fmtINR(summary.currentValue)} sub="as of today" highlight />
          <KpiCard label="Invested" value={fmtINR(summary.invested)} />
          <KpiCard
            label="Total P&L"
            value={<span className={gainTextClass(summary.totalPnl)}>{fmtINRSigned(summary.totalPnl)}</span>}
            sub={<span className={gainTextClass(summary.totalPnlPct)}>{fmtPct(summary.totalPnlPct)}</span>}
          />
          <KpiCard
            label="Day P&L"
            value={<span className={gainTextClass(summary.dayPnl)}>{fmtINRSigned(summary.dayPnl)}</span>}
            sub={<span className={gainTextClass(summary.dayPnlPct)}>{fmtPct(summary.dayPnlPct)}</span>}
          />
          <KpiCard
            label="Holdings"
            value={summary.holdingsCount}
            sub={<><span className="text-emerald-600">{summary.winners}W</span> · <span className="text-red-600">{summary.losers}L</span></>}
          />
        </div>

        {/* AI Insights */}
        <div className="bg-card border border-border rounded-xl p-5 mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles className="w-4 h-4 text-primary" />
            <h2 className="font-semibold text-foreground text-sm">AI Insights</h2>
            <span className="ml-auto text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
              {summary.asOf}
            </span>
          </div>
          <div className="space-y-3 text-sm text-foreground/80 leading-relaxed">
            {insights ? (
              insights
                .split("\n\n")
                .filter(Boolean)
                .map((para, i) => <p key={i}>{para.replace(/\*\*/g, "")}</p>)
            ) : (
              <p className="text-muted-foreground">No insights generated yet. Click Refresh to regenerate.</p>
            )}
          </div>
        </div>

        {/* Holdings table + Allocation chart */}
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-4 mb-6">
          <div>
            <h2 className="font-semibold text-foreground mb-3">Holdings</h2>
            <HoldingsTable holdings={holdings} onSelect={goTo} />
          </div>
          <div className="bg-card border border-border rounded-xl p-5">
            <h2 className="font-semibold text-foreground mb-1">Allocation</h2>
            <p className="text-xs text-muted-foreground mb-4">By current value · colour = P&amp;L %</p>
            <AllocationDonut holdings={holdings} onSelect={goTo} />
          </div>
        </div>

        {/* Winners / Losers */}
        <div className="mb-6">
          <h2 className="font-semibold text-foreground mb-3">Performance Extremes</h2>
          <WinnersLosers holdings={holdings} onSelect={goTo} />
        </div>

        {/* Concentration callout */}
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-amber-900">Concentration risk</p>
            <p className="text-xs text-amber-800 mt-0.5">
              Your top 5 holdings ({topHoldings.map((h) => h.symbol).join(", ")}) account for{" "}
              <span className="font-semibold num">{fmtNum(top5Weight, 1)}%</span> of portfolio value. A
              well-diversified portfolio typically targets no single holding above 10% and top-5 below 40%.
            </p>
          </div>
        </div>

        {/* Footer */}
        <p className="text-center text-xs text-muted-foreground/60 pb-4">
          Last fetched {summary.asOf} · Prices may be delayed by up to 15 min · For informational use only
        </p>
      </div>
    </div>
  );
}
