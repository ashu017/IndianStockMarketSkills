export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import TopNav from "@/components/portfolio/TopNav";
import StrategyDetailClient from "@/components/portfolio/StrategyDetailClient";
import { loadStrategyDetail } from "@/lib/strategies";
import { loadStrategyEquityHistory } from "@/lib/strategy-equity";

export default async function StrategyDetailPage({
  params,
}: {
  params: Promise<{ strategy: string }>;
}) {
  const { strategy } = await params;
  const decoded = decodeURIComponent(strategy);
  const [detail, equity] = await Promise.all([
    loadStrategyDetail(decoded),
    loadStrategyEquityHistory(decoded),
  ]);
  if (!detail) notFound();

  return (
    <>
      <TopNav currentPage="strategies" />
      <StrategyDetailClient detail={detail} equity={equity} />
    </>
  );
}

