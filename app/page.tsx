export const dynamic = "force-dynamic";

import { getHoldings, getPortfolioSummary } from "@/lib/db";
import { toHoldings } from "@/lib/mappers";
import Kpis from "@/components/overview/Kpis";
import HoldingsTable from "@/components/overview/HoldingsTable";
import WinnersLosers from "@/components/overview/WinnersLosers";
import Concentration from "@/components/overview/Concentration";

const USER = process.env.PORTFOLIO_USER_ID ?? "local";

export default async function Page() {
  const [summary, rows] = await Promise.all([
    getPortfolioSummary(USER),
    getHoldings(USER),
  ]);

  if (!summary || rows.length === 0) {
    return (
      <main className="mx-auto max-w-6xl p-8">
        <h1 className="text-2xl font-bold">Portfolio</h1>
        <p className="mt-4 text-gray-500">No holdings yet. Run refresh.</p>
      </main>
    );
  }

  const holdings = toHoldings(rows);

  return (
    <main className="mx-auto max-w-6xl space-y-8 p-8">
      <div>
        <h1 className="text-2xl font-bold">Portfolio</h1>
        <p className="text-sm text-gray-500">As of {summary.snapshot_date}</p>
      </div>

      <Kpis summary={summary} />

      <Concentration holdings={holdings} />

      {/* AllocationChart is mounted via next/dynamic in Task 9 (integration wiring). */}

      <WinnersLosers holdings={holdings} />

      <HoldingsTable holdings={holdings} />
    </main>
  );
}
