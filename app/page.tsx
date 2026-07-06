export const dynamic = "force-dynamic";

import { readFileSync } from "node:fs";
import { getHoldings, getPortfolioSummary } from "@/lib/db";
import { toHoldings } from "@/lib/mappers";
import { paiseToRupees } from "@/lib/money";
import type { PortfolioSummary } from "@/lib/types";
import TopNav from "@/components/portfolio/TopNav";
import OverviewClient from "@/components/portfolio/OverviewClient";

const USER = process.env.PORTFOLIO_USER_ID ?? "local";

function loadInsights(): string | null {
  try {
    return readFileSync("./data/insights.md", "utf8");
  } catch {
    return null;
  }
}

export default async function Page() {
  const [summaryRow, rows] = await Promise.all([
    getPortfolioSummary(USER),
    getHoldings(USER),
  ]);

  if (!summaryRow || rows.length === 0) {
    return (
      <>
        <TopNav currentPage="overview" />
        <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
          <h1 className="text-2xl font-semibold text-foreground">Portfolio</h1>
          <p className="mt-3 text-muted-foreground">
            No holdings yet. Run <code>/portfolio</code> or click Refresh to fetch your Zerodha holdings.
          </p>
        </div>
      </>
    );
  }

  const holdings = toHoldings(rows);
  const invested = paiseToRupees(summaryRow.invested);
  const currentValue = paiseToRupees(summaryRow.current_value);
  const totalPnl = paiseToRupees(summaryRow.total_pnl);
  const dayPnl = paiseToRupees(summaryRow.day_pnl);
  const prevValue = currentValue - dayPnl;

  const summary: PortfolioSummary = {
    currentValue,
    invested,
    totalPnl,
    totalPnlPct: invested ? (totalPnl / invested) * 100 : 0,
    dayPnl,
    dayPnlPct: prevValue ? (dayPnl / prevValue) * 100 : 0,
    holdingsCount: summaryRow.holdings_count,
    winners: summaryRow.winners,
    losers: summaryRow.losers,
    asOf: summaryRow.snapshot_date,
  };

  return (
    <>
      <TopNav currentPage="overview" sessionLabel={`As of ${summaryRow.snapshot_date}`} />
      <OverviewClient holdings={holdings} summary={summary} insights={loadInsights()} />
    </>
  );
}
