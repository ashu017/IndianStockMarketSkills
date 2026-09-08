export const dynamic = "force-dynamic";

import {
  getHolding,
  getHoldings,
  getFundamentals,
  getPeers,
  getAnalysis,
  getUniverseStock,
} from "@/lib/db";
import { toHolding, totalCurrentRupees } from "@/lib/mappers";
import { buildScorecard } from "@/components/deepdive/scorecard-data";
import type { Exchange, Peer, FundamentalItem } from "@/lib/types";
import TopNav from "@/components/portfolio/TopNav";
import DeepDiveClient from "@/components/portfolio/DeepDiveClient";
import StockDetail from "@/components/portfolio/StockDetail";

const USER = process.env.PORTFOLIO_USER_ID ?? "local";

async function loadFundamentalsAndPeers(isin: string, sector: string | null) {
  const [{ core, extra }, peerRows, analysisRow] = await Promise.all([
    getFundamentals(isin),
    getPeers(isin),
    getAnalysis(isin),
  ]);
  let fundamentals: FundamentalItem[] = [];
  if (core) {
    fundamentals = buildScorecard(sector ?? "", {
      pe: core.pe,
      pb: core.pb,
      roe: core.roe,
      roce: core.roce,
      debt_equity: core.debt_equity,
      sales_growth_3y: core.sales_growth_3y,
      profit_growth_3y: core.profit_growth_3y,
      div_yield: core.div_yield,
      promoter_holding: core.promoter_holding,
    }, extra);
  }
  const peers: Peer[] = peerRows.map((p) => ({
    symbol: p.peer_symbol,
    company: p.peer_company ?? p.peer_symbol,
    pe: p.pe,
    roe: p.roe ?? 0,
    roce: p.roce,
    salesGrowth: p.sales_growth ?? 0,
  }));
  return {
    fundamentals,
    peers,
    analysis: analysisRow?.narrative ?? null,
    llmVerdict: analysisRow?.verdict ?? null,
    confidence: analysisRow?.confidence ?? null,
  };
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

  const [holdingRow, allRows] = await Promise.all([
    getHolding(USER, decoded, exchange),
    getHoldings(USER),
  ]);

  // Holdings path: existing rich UI (adds "Your Position" block). Fundamentals + peers
  // + analysis are pulled from the holding's ISIN via the same helpers.
  if (holdingRow) {
    const totalRupees = totalCurrentRupees(allRows);
    const holding = toHolding(holdingRow, totalRupees);
    const { fundamentals, peers, analysis, llmVerdict, confidence } = holdingRow.isin
      ? await loadFundamentalsAndPeers(holdingRow.isin, holdingRow.sector ?? null)
      : { fundamentals: [], peers: [], analysis: null, llmVerdict: null, confidence: null };
    return (
      <>
        <TopNav currentPage="deepdive" stockSymbol={holding.symbol} />
        <DeepDiveClient
          holding={holding}
          fundamentals={fundamentals}
          analysis={analysis}
          verdict={llmVerdict}
          confidence={confidence}
          peers={peers}
          portfolioCurrentValue={totalRupees}
          seed={0}
        />
      </>
    );
  }

  // Non-holding path: still show charts + fundamentals + peers + analysis + verdict.
  // Look up the stock in index_universe to get ISIN + sector + company.
  const uni = await getUniverseStock(decoded);
  if (!uni) {
    // Genuinely unknown symbol — VerdictCard will still try a Kite lookup on-demand.
    return (
      <>
        <TopNav currentPage="deepdive" stockSymbol={decoded} />
        <StockDetail
          symbol={decoded}
          exchange="NSE"
          company=""
          sector={null}
          ltp={null}
          dayChangePct={null}
          dayPnl={null}
          avgPrice={null}
          fundamentals={[]}
          analysis={null}
          llmVerdict={null}
          confidence={null}
          peers={[]}
          isGain={true}
        />
      </>
    );
  }

  const { fundamentals, peers, analysis, llmVerdict, confidence } = await loadFundamentalsAndPeers(uni.isin, uni.sector);

  return (
    <>
      <TopNav currentPage="deepdive" stockSymbol={uni.symbol} />
      <StockDetail
        symbol={uni.symbol}
        exchange={uni.exchange as Exchange}
        company={uni.company}
        sector={uni.sector || null}
        ltp={null}
        dayChangePct={null}
        dayPnl={null}
        avgPrice={null}
        fundamentals={fundamentals}
        analysis={analysis}
        llmVerdict={llmVerdict}
        confidence={confidence}
        peers={peers}
        isGain={true}
      />
    </>
  );
}

