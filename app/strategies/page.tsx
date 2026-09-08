export const dynamic = "force-dynamic";

import TopNav from "@/components/portfolio/TopNav";
import StrategyCardGrid from "@/components/portfolio/StrategyCardGrid";
import { listStrategyCards } from "@/lib/strategies";

export default async function StrategiesPage() {
  const cards = await listStrategyCards();
  return (
    <>
      <TopNav currentPage="strategies" />
      <StrategyCardGrid cards={cards} />
    </>
  );
}
