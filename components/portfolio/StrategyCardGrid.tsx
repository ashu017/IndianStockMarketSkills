import Link from "next/link";
import type { StrategyCardStats } from "@/lib/strategies";
import { fmtPct } from "./utils";

function gainClass(v: number | null | undefined): string {
  if (v === null || v === undefined) return "text-muted-foreground";
  return v > 0 ? "text-emerald-600" : v < 0 ? "text-red-600" : "text-foreground";
}

function StrategyCard({ card }: { card: StrategyCardStats }) {
  const clickable = card.live || card.interactiveBacktestKind !== undefined;
  const body = (
    <div className="rounded-xl border border-border bg-card p-5 h-full hover:border-primary/40 hover:shadow-sm transition-all">
      <div className="flex items-start justify-between gap-3 mb-3">
        <h3 className="text-sm font-semibold text-foreground leading-snug">{card.name}</h3>
        {card.live ? (
          <span className="shrink-0 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
            Live
          </span>
        ) : card.interactiveBacktestKind ? (
          <span className="shrink-0 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-sky-50 text-sky-700 border border-sky-200">
            On-demand
          </span>
        ) : (
          <span className="shrink-0 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">
            Backtested only
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground mb-4 line-clamp-3">{card.description}</p>

      {card.live ? (
        <div className="grid grid-cols-3 gap-2">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Active</p>
            <p className="text-sm font-medium num text-foreground">{card.open_count}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {card.cagr_pct === null ? "Return" : "CAGR"}
            </p>
            <p className={`text-sm font-medium num ${gainClass(card.cagr_pct ?? card.total_return_pct)}`}>
              {fmtPct(card.cagr_pct ?? card.total_return_pct)}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Win rate</p>
            <p className="text-sm font-medium num text-foreground">
              {card.win_rate_pct === null ? "—" : `${card.win_rate_pct.toFixed(0)}%`}
            </p>
          </div>
        </div>
      ) : card.interactiveBacktestKind === "overnight_close_to_open" ? (
        <p className="text-xs text-primary/80 italic">Pick a stock and run it on demand →</p>
      ) : card.interactiveBacktestKind ? (
        <p className="text-xs text-primary/80 italic">Open for an on-demand analysis →</p>
      ) : (
        <p className="text-xs text-muted-foreground/70 italic">
          No live positions — results come from historical backtests, not real-time paper trading.
        </p>
      )}
    </div>
  );

  if (!clickable) {
    // Non-live, non-interactive strategies have no detail page data yet — render inert.
    return <div className="opacity-90">{body}</div>;
  }
  return (
    <Link href={`/strategies/${card.id}`} className="block">
      {body}
    </Link>
  );
}

export default function StrategyCardGrid({ cards }: { cards: StrategyCardStats[] }) {
  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-foreground">Strategies</h1>
        <p className="text-sm text-muted-foreground">
          Click a strategy to see its active positions and performance.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {cards.map((card) => (
          <StrategyCard key={card.id} card={card} />
        ))}
      </div>
    </div>
  );
}

