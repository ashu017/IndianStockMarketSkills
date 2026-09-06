import {
  ShieldCheck,
  TrendingUp,
  Target,
  ListOrdered,
  Crosshair,
  Repeat,
  FlaskConical,
} from "lucide-react";
import type { StrategyDetail, StrategyRuleGroup } from "@/lib/strategies";
import type { StrategyEquityHistory } from "@/lib/strategy-equity";
import { fmtINR, fmtINRSigned, fmtPct } from "./utils";
import StrategyEquityChart from "./StrategyEquityChart";
import BacktestPanel from "./BacktestPanel";
import OvernightBacktestPanel from "./OvernightBacktestPanel";
import BulkDealHoldsPanel from "./BulkDealHoldsPanel";

/** Shares still held, tolerating rows written before qty_open existed (NULL there
 *  means "never scaled out"). Mirrors lib/paper.ts's openQty(); kept local rather
 *  than imported so this component doesn't pull in the server-only paper module. */
function sharesHeld(t: { qty: number; qty_open: number | null }): number {
  return t.qty_open ?? t.qty;
}

function gainClass(v: number | null | undefined): string {
  if (v === null || v === undefined) return "text-muted-foreground";
  return v > 0 ? "text-emerald-600" : v < 0 ? "text-red-600" : "text-foreground";
}

function StatTile({ label, value, sub, valueClass }: { label: string; value: React.ReactNode; sub?: React.ReactNode; valueClass?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold mt-1 ${valueClass ?? "text-foreground"}`}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

// One icon + accent per pipeline stage, matched to the rule group's ordinal
// position (StrategyRuleGroup.title always starts "N. ..." per lib/strategies.ts).
// Colors ride the same indigo/primary system as TopNav's logo tile and
// StockDetail's highlighted rows (bg-primary/10, text-primary, border-primary/20),
// not a new palette.
const STAGE_STYLE = [
  { icon: ShieldCheck, iconClass: "text-primary" },
  { icon: TrendingUp, iconClass: "text-sky-600" },
  { icon: Crosshair, iconClass: "text-emerald-600" },
  { icon: ListOrdered, iconClass: "text-amber-600" },
  { icon: Target, iconClass: "text-violet-600" },
  { icon: Repeat, iconClass: "text-rose-600" },
  // Stage 7 is the measured justification for the current exit rule plus the
  // grandfathering note — same flask as the backtest panel below it, since it's
  // where you'd go to re-run the comparison yourself.
  { icon: FlaskConical, iconClass: "text-violet-600" },
];

/** Detailed rule breakdown — the numbered pipeline stages from lib/strategies.ts's registry. */
function StrategyOverview({ description, rules }: { description: string; rules?: StrategyRuleGroup[] }) {
  if (!rules || rules.length === 0) {
    return <p className="text-sm text-muted-foreground mt-1">{description}</p>;
  }
  return (
    <div className="mt-3 rounded-xl border border-primary/20 bg-gradient-to-br from-primary/[0.06] via-secondary/40 to-transparent p-5 sm:p-6">
      <p className="text-sm text-muted-foreground mb-5 max-w-3xl">{description}</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {rules.map((group, idx) => {
          const style = STAGE_STYLE[idx % STAGE_STYLE.length];
          const Icon = style.icon;
          return (
            <div
              key={group.title}
              className="rounded-lg border border-border bg-card/80 backdrop-blur-sm p-4 hover:border-primary/30 hover:shadow-sm transition-all"
            >
              <div className="flex items-center gap-2 mb-2.5">
                <span className={`shrink-0 w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center ${style.iconClass}`}>
                  <Icon className="w-4 h-4" />
                </span>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">
                  {group.title}
                </h3>
              </div>
              <ul className="space-y-1.5">
                {group.items.map((item, i) => (
                  <li key={i} className="text-xs text-muted-foreground flex gap-2 leading-relaxed">
                    <span className="text-primary/50 shrink-0">•</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function StrategyDetailClient({
  detail,
  equity,
}: {
  detail: StrategyDetail;
  equity: StrategyEquityHistory | null;
}) {
  const { definition, summary, active_positions, cagr_pct, strategy_total_return_pct } = detail;

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

  return (
    <div className="max-w-[1200px] mx-auto px-4 py-6 space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-foreground">{definition.name}</h1>
        <StrategyOverview description={definition.description} rules={definition.rules} />
      </div>

      {/* NOTE: cash/equity figures below are whole-account, not strategy-scoped —
          see the shared-cash-pool note in lib/paper.ts's summarize(). CAGR and
          P&L figures ARE scoped to this strategy's own trades. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile
          label={cagr_pct === null ? "Total return" : "CAGR"}
          value={fmtPct(cagr_pct ?? strategy_total_return_pct ?? 0)}
          valueClass={gainClass(cagr_pct ?? strategy_total_return_pct)}
          sub={cagr_pct === null ? "needs 90+ days for CAGR" : "annualized"}
        />
        <StatTile
          label="Active positions"
          value={summary.open_count}
        />
        <StatTile
          label="Realized P&L"
          value={fmtINRSigned(summary.realized_pnl_paise / 100)}
          valueClass={gainClass(summary.realized_pnl_paise)}
          sub={`${summary.closed_count} closed`}
        />
        <StatTile
          label="Unrealized P&L"
          value={fmtINRSigned(summary.unrealized_pnl_paise / 100)}
          valueClass={gainClass(summary.unrealized_pnl_paise)}
          sub="across active positions"
        />
        <StatTile
          label="Win rate"
          value={summary.win_rate_pct === null ? "—" : `${summary.win_rate_pct.toFixed(0)}%`}
          sub={`${summary.closed_count} closed trades`}
        />
        <StatTile
          label="Avg R multiple"
          value={summary.avg_r_multiple === null ? "—" : `${summary.avg_r_multiple.toFixed(2)}R`}
          sub="per closed trade"
        />
        <StatTile
          label="Best / worst trade"
          value={
            summary.best_trade_paise === null && summary.worst_trade_paise === null
              ? "—"
              : `${fmtINRSigned((summary.best_trade_paise ?? 0) / 100)} / ${fmtINRSigned((summary.worst_trade_paise ?? 0) / 100)}`
          }
        />
        <StatTile
          label="Max drawdown"
          value={summary.max_drawdown_pct === null ? "—" : fmtPct(-summary.max_drawdown_pct)}
          valueClass={summary.max_drawdown_pct ? "text-red-600" : ""}
          sub="whole account, peak-to-trough"
        />
      </div>

      {equity && (
        <StrategyEquityChart
          history={equity.history}
          projection={equity.projection}
          startingValueRupees={equity.starting_value_rupees}
          caveats={equity.caveats}
        />
      )}

      <section>
        <h2 className="text-sm font-medium mb-2">Active positions ({active_positions.length})</h2>
        <div className="rounded-lg border border-border bg-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-3 py-2 text-left">Symbol</th>
                <th className="px-3 py-2 text-right">Qty</th>
                <th className="px-3 py-2 text-right">Entry</th>
                <th className="px-3 py-2 text-right">LTP</th>
                <th className="px-3 py-2 text-right">Unreal P&L</th>
                <th className="px-3 py-2 text-right">Stop</th>
                <th className="px-3 py-2 text-right">Target</th>
                <th className="px-3 py-2 text-right">Days</th>
                <th className="px-3 py-2 text-right">Capital</th>
              </tr>
            </thead>
            <tbody>
              {active_positions.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">
                    No active positions for this strategy right now.
                  </td>
                </tr>
              )}
              {active_positions.map((t) => (
                <tr key={t.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                  <td className="px-3 py-2 font-medium">
                    <a href={`/stock/${encodeURIComponent(t.symbol)}`} className="hover:underline">{t.symbol}</a>
                    {t.moved_to_breakeven && (
                      <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                        BE
                      </span>
                    )}
                    {t.scaled_out && (
                      <span
                        className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-violet-50 text-violet-700 border border-violet-200"
                        title={
                          t.partial_exit_paise !== null
                            ? `${t.qty - sharesHeld(t)} of ${t.qty} shares booked at ${fmtINR(t.partial_exit_paise / 100)} on ${t.partial_exit_date}, ${fmtINRSigned(t.partial_pnl_paise / 100)} realized`
                            : "Part of this position has been booked"
                        }
                      >
                        ½ booked
                      </span>
                    )}
                  </td>
                  {/* Shares still held. The sold half is already in cash and out
                      of the unrealized figure, so showing the original size here
                      would not reconcile with the P&L column. */}
                  <td className="px-3 py-2 text-right tabular-nums">
                    {sharesHeld(t)}
                    {t.scaled_out && (
                      <span className="ml-1 text-xs text-muted-foreground">of {t.qty}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtINR(t.entry_paise / 100)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {t.latest_close_paise !== null ? fmtINR(t.latest_close_paise / 100) : "—"}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${gainClass(t.unrealized_pnl_paise)}`}>
                    {t.unrealized_pnl_paise !== null ? fmtINRSigned(t.unrealized_pnl_paise / 100) : "—"}
                    {t.unrealized_pct !== null && (
                      <span className="ml-1 text-xs">({fmtPct(t.unrealized_pct)})</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-red-600">{fmtINR(t.current_stop_paise / 100)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-emerald-600">{fmtINR(t.target_paise / 100)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{t.bars_held}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtINR(t.capital_committed_paise / 100)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <BacktestPanel strategyId={definition.id} />

      <p className="text-center text-xs text-muted-foreground/60">
        Paper trading — simulated positions, not real orders. CAGR is annualized off this
        strategy&apos;s own realized+unrealized P&L against the account&apos;s starting capital.
      </p>
    </div>
  );
}

