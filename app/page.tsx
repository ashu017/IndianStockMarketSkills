export const dynamic = "force-dynamic";

import { getHoldings, getPortfolioSummary } from "@/lib/db";
import { toHoldings } from "@/lib/mappers";
import Kpis from "@/components/overview/Kpis";
import HoldingsTable from "@/components/overview/HoldingsTable";
import WinnersLosers from "@/components/overview/WinnersLosers";
import Concentration from "@/components/overview/Concentration";
import AllocationChart from "@/components/overview/AllocationChartClient";
import RefreshButton from "@/components/RefreshButton";

const USER = process.env.PORTFOLIO_USER_ID ?? "local";

export default async function Page() {
  const [summary, rows] = await Promise.all([
    getPortfolioSummary(USER),
    getHoldings(USER),
  ]);

  if (!summary || rows.length === 0) {
    return (
      <main className="mx-auto max-w-6xl p-8">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Portfolio</h1>
          <RefreshButton />
        </div>
        <p className="mt-4 text-gray-500">
          No holdings yet. Click Refresh to fetch your Zerodha holdings.
        </p>
      </main>
    );
  }

  const holdings = toHoldings(rows);

  return (
    <main className="mx-auto max-w-6xl space-y-8 p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Portfolio</h1>
          <p className="text-sm text-gray-500">As of {summary.snapshot_date}</p>
        </div>
        <RefreshButton />
      </div>

      <Kpis summary={summary} />

      <div className="grid gap-8 lg:grid-cols-[1.4fr_1fr]">
        <HoldingsTable holdings={holdings} />
        <AllocationChart holdings={holdings} />
      </div>

      <WinnersLosers holdings={holdings} />

      <Concentration holdings={holdings} />
    </main>
  );
}
