import type { StrategyDetail } from "@/lib/strategies";
import type { StrategyEquityHistory } from "@/lib/strategy-equity";
import StrategyOverview from "./StrategyOverview";
import BacktestPanel from "./BacktestPanel";
import OvernightBacktestPanel from "./OvernightBacktestPanel";
import BulkDealHoldsPanel from "./BulkDealHoldsPanel";
import LiveStrategyDetail from "./LiveStrategyDetail";

/**
 * Picks the right view for a strategy. Backtest-only strategies get their
 * interactive panel; a live paper-traded one gets LiveStrategyDetail, which is a
 * client component because it re-marks its positions against current prices.
 *
 * This dispatcher stays server-rendered so the backtest-only branches — the
 * majority of the registry — ship no extra client JS for a live view they never
 * show.
 */
export default function StrategyDetailClient({
  detail,
  equity,
}: {
  detail: StrategyDetail;
  equity: StrategyEquityHistory | null;
}) {
  const { definition, summary } = detail;

  if (definition.interactiveBacktestKind === "overnight_close_to_open") {
    return (
      <div className="max-w-[1200px] mx-auto px-4 py-6 space-y-6">
        <div>
          <h1 className="text-lg font-semibold text-foreground">{definition.name}</h1>
          <StrategyOverview description={definition.description} rules={definition.rules} />
        </div>
        <OvernightBacktestPanel />
      </div>
    );
  }

  if (definition.interactiveBacktestKind === "momentum_technical_only") {
    // Same panel the live strategy uses — it's the same engine, just with the
    // fundamental gate off (the route decides that from the strategy id).
    return (
      <div className="max-w-[1200px] mx-auto px-4 py-6 space-y-6">
        <div>
          <h1 className="text-lg font-semibold text-foreground">{definition.name}</h1>
          <StrategyOverview description={definition.description} rules={definition.rules} />
        </div>
        <BacktestPanel strategyId={definition.id} />
      </div>
    );
  }

  if (definition.interactiveBacktestKind === "bulk_deal_institutional_holds") {
    return (
      <div className="max-w-[1200px] mx-auto px-4 py-6 space-y-6">
        <div>
          <h1 className="text-lg font-semibold text-foreground">{definition.name}</h1>
          <StrategyOverview description={definition.description} rules={definition.rules} />
        </div>
        <BulkDealHoldsPanel />
      </div>
    );
  }

  if (!definition.live || !summary) {
    return (
      <div className="max-w-[1200px] mx-auto px-4 py-6 space-y-4">
        <div>
          <h1 className="text-lg font-semibold text-foreground">{definition.name}</h1>
          <StrategyOverview description={definition.description} rules={definition.rules} />
        </div>
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800">
          This strategy has no live paper-trading positions yet — it currently only exists as a
          backtest{definition.source ? ` (see ${definition.source})` : ""}. Once it&apos;s wired up to
          run as real paper trades, its active positions and performance will appear here.
        </div>
      </div>
    );
  }

  return <LiveStrategyDetail detail={{ ...detail, summary }} equity={equity} />;
}
