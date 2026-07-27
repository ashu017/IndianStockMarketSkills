"use client";

import { type ReactNode } from "react";
import type { Holding, FundamentalItem, Peer } from "@/lib/types";
import { fmtINR, fmtINRSigned, fmtPct, fmtNum, gainTextClass } from "./utils";
import StockDetail from "./StockDetail";

/**
 * Holdings-mode deep dive: composes StockDetail with a "Your Position" header
 * block that shows qty, avg cost, invested, P&L, portfolio weight. For any
 * non-holding stock the page renders StockDetail directly with no header slot.
 */

interface Props {
  holding: Holding;
  fundamentals: FundamentalItem[];
  analysis: string | null;
  verdict?: string | null;
  confidence?: string | null;
  peers: Peer[];
  portfolioCurrentValue: number;
  seed: number;
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
  verdict,
  confidence,
  peers,
  portfolioCurrentValue,
}: Props) {
  const isGain = holding.pnl >= 0;

  const positionBlock = (
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
  );

  return (
    <StockDetail
      symbol={holding.symbol}
      exchange={holding.exchange}
      company={holding.company}
      sector={holding.sector || null}
      ltp={holding.ltp}
      dayChangePct={holding.dayChangePct}
      dayPnl={holding.dayPnl}
      avgPrice={holding.avgPrice}
      fundamentals={fundamentals}
      analysis={analysis}
      llmVerdict={verdict ?? null}
      confidence={confidence ?? null}
      peers={peers}
      isGain={isGain}
      header={positionBlock}
    />
  );
}
