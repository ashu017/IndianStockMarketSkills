export const dynamic = "force-dynamic";

import {
  getHolding,
  getHoldings,
  getFundamentals,
  getPeers,
  getAnalysis,
} from "@/lib/db";
import { toHolding, totalCurrentRupees } from "@/lib/mappers";
import { buildScorecard } from "@/components/deepdive/scorecard-data";
import type { Exchange, Peer, FundamentalItem } from "@/lib/types";
import TopNav from "@/components/portfolio/TopNav";
import DeepDiveClient from "@/components/portfolio/DeepDiveClient";

const USER = process.env.PORTFOLIO_USER_ID ?? "local";

function seedFor(symbol: string): number {
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) | 0;
  return Math.abs(h) || 1;
}

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ symbol: string }>;
  searchParams: Promise<{ exchange?: string }>;
}) {
  const { symbol } = await params;
  const { exchange: exchangeParam } = await searchParams;
  const exchange = (exchangeParam ?? "NSE") as Exchange;
  const decoded = decodeURIComponent(symbol);

  const [row, allRows] = await Promise.all([
    getHolding(USER, decoded, exchange),
    getHoldings(USER),
  ]);

  if (!row) {
    return (
      <>
        <TopNav currentPage="deepdive" stockSymbol={decoded} />
        <div className="max-w-[1200px] mx-auto px-4 py-16 text-center text-muted-foreground">
          Stock not found: {decoded}
        </div>
      </>
    );
  }

  const totalRupees = totalCurrentRupees(allRows);
  const holding = toHolding(row, totalRupees);

  let fundamentals: FundamentalItem[] = [];
  let peers: Peer[] = [];
  let analysis: string | null = null;
  let verdict: string | null = null;
  let confidence: string | null = null;

  if (row.isin) {
    const [{ core, extra }, peerRows, analysisRow] = await Promise.all([
      getFundamentals(row.isin),
      getPeers(row.isin),
      getAnalysis(row.isin),
    ]);
    if (core) {
      const metrics = {
        pe: core.pe,
        pb: core.pb,
        roe: core.roe,
        roce: core.roce,
        debt_equity: core.debt_equity,
        sales_growth_3y: core.sales_growth_3y,
        profit_growth_3y: core.profit_growth_3y,
        div_yield: core.div_yield,
        promoter_holding: core.promoter_holding,
      };
      fundamentals = buildScorecard(row.sector ?? "", metrics, extra);
    }
    peers = peerRows.map((p) => ({
      symbol: p.peer_symbol,
      company: p.peer_company ?? p.peer_symbol,
      pe: p.pe,
      roe: p.roe ?? 0,
      roce: p.roce,
      salesGrowth: p.sales_growth ?? 0,
    }));
    analysis = analysisRow?.narrative ?? null;
    verdict = analysisRow?.verdict ?? null;
    confidence = analysisRow?.confidence ?? null;
  }

  return (
    <>
      <TopNav currentPage="deepdive" stockSymbol={holding.symbol} />
      <DeepDiveClient
        holding={holding}
        fundamentals={fundamentals}
        analysis={analysis}
        verdict={verdict}
        confidence={confidence}
        peers={peers}
        portfolioCurrentValue={totalRupees}
        seed={seedFor(holding.symbol)}
      />
    </>
  );
}
