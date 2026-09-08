"use client";

import { RefreshCw } from "lucide-react";
import type { StrategyDetail } from "@/lib/strategies";
import type { StrategyEquityHistory } from "@/lib/strategy-equity";
import { projectEquity } from "@/lib/equity-projection";
import { accountAgeCagrPct } from "@/lib/metrics";
import { fmtINR, fmtINRSigned, fmtPct } from "./utils";
import StrategyEquityChart from "./StrategyEquityChart";
import StrategyOverview from "./StrategyOverview";
import BacktestPanel from "./BacktestPanel";
import { useLiveQuotes } from "./useLiveQuotes";

/**
 * The live paper-trading view of a strategy: headline stats, equity curve, the
 * open positions and the closed trade log.
 *
 * This is a client component for one reason: the prices. loadStrategyDetail()
 * marks positions from ohlc_intraday/ohlc_daily, which the scan cron writes four
 * times a weekday — so a page opened mid-morning was labelling a two-hour-old
 * number "LTP". On mount it asks /api/quotes for the symbols on this page and
 * re-marks with what came back.
 *
 * The stat tile and the table are computed from the SAME marks, in this one
 * place, so they cannot disagree. That is why the tile moved in here rather than
 * staying server-rendered from summary.unrealized_pnl_paise: two sources for one
 * number is how a dashboard starts lying.
 */

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

/** NSE timestamps are what a reader here thinks in, so render the fetch time in
 *  IST regardless of the browser's zone. */
function istTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function humanReason(reason: string | null, status: string): string {
  return (reason ?? status).replace(/_/g, " ");
}

/**
 * Corrects the equity curve's last point to the prices the rest of the page is
 * showing, and redraws the projection from it.
 *
 * WHY: the server builds the curve from ohlc_daily closes, and today's bar does
 * not exist until the evening bhavcopy lands — so the line ended on yesterday's
 * close while the Unrealized P&L tile directly above it moved with the market.
 * This applies the same identity strategy-equity.ts uses for every other day
 * (starting capital + banked P&L + open positions marked), with today's mark
 * being the live one, so the endpoint continues the curve rather than measuring
 * something different.
 *
 * @param pnlPaise Banked P&L plus unrealized at current marks, strategy-scoped.
 * @param asOf Fetch time of the live prices, or null when none were available —
 *   only affects how the caveat is worded, never the number.
 */
function markEquityAtLivePrices(
  equity: StrategyEquityHistory | null,
  pnlPaise: number,
  asOf: string | null,
): StrategyEquityHistory | null {
  if (!equity || equity.history.length === 0) return equity;

  const valueRupees = equity.starting_value_rupees + pnlPaise / 100;
  // loadStrategyEquityHistory always extends its calendar to today, so the last
  // point IS today: this corrects that point rather than appending a new one.
  const history = [
    ...equity.history.slice(0, -1),
    { ...equity.history[equity.history.length - 1], value_rupees: valueRupees },
  ];

  return {
    ...equity,
    history,
    // Redraw the dashed line too — one still hanging off the stale value would
    // visibly fail to meet the solid line it is meant to continue.
    projection: projectEquity(history),
    caveats: [
      ...equity.caveats,
      asOf
        ? `Today's point is marked at live prices (as of ${istTime(asOf)} IST); every earlier point uses that day's official close.`
        : "Today's point is marked at the most recent price available; every earlier point uses that day's official close.",
    ],
  };
}

/** StrategyDetail with the summary known to be present — the caller only renders
 *  this view for a live strategy that has a paper account, so narrowing it here
 *  beats a null check on every tile. */
export type LiveStrategyDetailData = Omit<StrategyDetail, "summary"> & {
  summary: NonNullable<StrategyDetail["summary"]>;
};

export default function LiveStrategyDetail({
  detail,
  equity,
}: {
  detail: LiveStrategyDetailData;
  equity: StrategyEquityHistory | null;
}) {
  const {
    definition,
    summary,
    active_positions,
    closed_positions,
    // Only a fallback now: both figures are recomputed below at live marks, so
    // the tile agrees with the chart endpoint and the P&L tiles beside it.
    cagr_pct,
  } = detail;

  // Every symbol shown on the page — open positions and the closed log both.
  // A live price on a closed trade changes no P&L (that was realized at the exit
  // price) but it is the only way to answer "did we get out too early?", so it
  // gets its own informational column rather than being folded into a total.
  const symbols = [
    ...active_positions.map((t) => t.symbol),
    ...closed_positions.map((t) => t.symbol),
  ];
  const { quotes, state, asOf, missing, error, refresh } = useLiveQuotes(symbols);

  /** Live price if we have one, otherwise whatever the database was marking at. */
  function markPaise(symbol: string, fallback: number | null): number | null {
    return quotes[symbol]?.ltp_paise ?? fallback;
  }

  // Re-mark the open positions off the live prices. Marked on shares STILL HELD,
  // not the original size: a part-booked position's sold half is already realized
  // P&L, and counting it here would report it twice.
  const marked = active_positions.map((t) => {
    const ltp = markPaise(t.symbol, t.latest_close_paise);
    const held = sharesHeld(t);
    return {
      trade: t,
      ltp,
      held,
      isLive: quotes[t.symbol] !== undefined,
      unrealized: ltp !== null ? (ltp - t.entry_paise) * held : null,
      unrealizedPct: ltp !== null ? ((ltp - t.entry_paise) / t.entry_paise) * 100 : null,
    };
  });
  const unrealizedTotal = marked.reduce((s, m) => s + (m.unrealized ?? 0), 0);

  // ONE expression for "what this strategy is worth right now", which every
  // derived figure below hangs off: the headline return tile, the chart's last
  // point, and the P&L tiles. Same identity the server uses per day in
  // lib/strategies.ts and lib/strategy-equity.ts — starting capital + banked P&L
  // + open positions marked — with today's mark being the live one.
  const livePnlPaise = summary.realized_pnl_paise + unrealizedTotal;
  const liveValuePaise = summary.starting_cash_paise + livePnlPaise;

  const liveTotalReturnPct =
    summary.starting_cash_paise > 0 ? (livePnlPaise / summary.starting_cash_paise) * 100 : null;
  // Null until the account is 90 days old (accountAgeCagrPct's floor), which is
  // why the tile falls back to total return. Date.now() differs by milliseconds
  // between the server render and hydration; at two decimals that is invisible,
  // and total return — what actually shows for a young account — has no time term
  // at all.
  const liveCagrPct = detail.account_created_at
    ? accountAgeCagrPct(summary.starting_cash_paise, liveValuePaise, detail.account_created_at)
    : cagr_pct;

  // The chart's last point. Not wrapped in useMemo: a handful of array operations
  // over at most a few hundred points, and React Compiler memoizes it
  // automatically — a manual memo here only defeated the compiler
  // (react-hooks/preserve-manual-memoization).
  const liveEquity = markEquityAtLivePrices(equity, livePnlPaise, state === "ok" && asOf ? asOf : null);

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
          label={liveCagrPct === null ? "Total return" : "CAGR"}
          value={fmtPct(liveCagrPct ?? liveTotalReturnPct ?? 0)}
          valueClass={gainClass(liveCagrPct ?? liveTotalReturnPct)}
          sub={liveCagrPct === null ? "needs 90+ days for CAGR" : "annualized"}
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
          value={fmtINRSigned(unrealizedTotal / 100)}
          valueClass={gainClass(unrealizedTotal)}
          sub={state === "ok" && asOf ? "at live prices" : "across active positions"}
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

      {/* Freshness line. Sits between the tiles and everything it governs — the
          chart's last point and both tables are marked at these prices. A page
          that silently mixes live and end-of-day marks is worse than one that is
          openly stale. */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {state === "loading" && <span>Fetching live prices from NSE…</span>}
        {state === "ok" && asOf && (
          <span>
            Live prices as of {istTime(asOf)} IST
            {missing.length > 0 &&
              ` · no quote for ${missing.join(", ")} — showing their last close`}
          </span>
        )}
        {state === "ok" && !asOf && <span>No live prices available — showing last close.</span>}
        {state === "error" && (
          <span className="text-amber-700">
            Live quote feed unreachable ({error}) — showing last close.
          </span>
        )}
        <button
          type="button"
          onClick={refresh}
          disabled={state === "loading"}
          className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 hover:bg-muted/40 disabled:opacity-50"
        >
          <RefreshCw className={`w-3 h-3 ${state === "loading" ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {liveEquity && (
        <StrategyEquityChart
          history={liveEquity.history}
          projection={liveEquity.projection}
          startingValueRupees={liveEquity.starting_value_rupees}
          caveats={liveEquity.caveats}
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
              {marked.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">
                    No active positions for this strategy right now.
                  </td>
                </tr>
              )}
              {marked.map((m) => {
                const t = m.trade;
                return (
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
                              ? `${t.qty - m.held} of ${t.qty} shares booked at ${fmtINR(t.partial_exit_paise / 100)} on ${t.partial_exit_date}, ${fmtINRSigned(t.partial_pnl_paise / 100)} realized`
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
                      {m.held}
                      {t.scaled_out && (
                        <span className="ml-1 text-xs text-muted-foreground">of {t.qty}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtINR(t.entry_paise / 100)}</td>
                    <td
                      className="px-3 py-2 text-right tabular-nums"
                      title={m.isLive ? "Live price from NSE" : "Last close — no live quote for this symbol"}
                    >
                      {m.ltp !== null ? fmtINR(m.ltp / 100) : "—"}
                      {!m.isLive && m.ltp !== null && (
                        <span className="ml-1 text-[10px] text-muted-foreground">eod</span>
                      )}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${gainClass(m.unrealized)}`}>
                      {m.unrealized !== null ? fmtINRSigned(m.unrealized / 100) : "—"}
                      {m.unrealizedPct !== null && (
                        <span className="ml-1 text-xs">({fmtPct(m.unrealizedPct)})</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-red-600">{fmtINR(t.current_stop_paise / 100)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-emerald-600">{fmtINR(t.target_paise / 100)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{t.bars_held}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtINR(t.capital_committed_paise / 100)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="text-sm font-medium mb-2">
          Closed trades ({closed_positions.length}
          {summary.closed_count > closed_positions.length ? ` of ${summary.closed_count}` : ""})
        </h2>
        <div className="rounded-lg border border-border bg-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-3 py-2 text-left">Symbol</th>
                <th className="px-3 py-2 text-right">Qty</th>
                <th className="px-3 py-2 text-right">Entry</th>
                <th className="px-3 py-2 text-right">Exit</th>
                <th className="px-3 py-2 text-left">Reason</th>
                <th className="px-3 py-2 text-right">Realized P&L</th>
                <th className="px-3 py-2 text-right">R</th>
                <th className="px-3 py-2 text-right">Days</th>
                <th
                  className="px-3 py-2 text-right"
                  title="Price now, for hindsight only — the P&L was realized at the exit price and does not move."
                >
                  Now
                </th>
              </tr>
            </thead>
            <tbody>
              {closed_positions.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">
                    This strategy hasn&apos;t closed a trade yet.
                  </td>
                </tr>
              )}
              {closed_positions.map((t) => {
                const now = markPaise(t.symbol, null);
                // Move since the exit. Not P&L — the trade is over. It answers
                // the only question a closed row can still raise: was the exit
                // early or late?
                const sinceExitPct =
                  now !== null && t.exit_paise !== null && t.exit_paise > 0
                    ? ((now - t.exit_paise) / t.exit_paise) * 100
                    : null;
                return (
                  <tr key={t.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                    <td className="px-3 py-2 font-medium">
                      <a href={`/stock/${encodeURIComponent(t.symbol)}`} className="hover:underline">{t.symbol}</a>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{t.qty}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {fmtINR(t.entry_paise / 100)}
                      <span className="block text-[10px] text-muted-foreground">{t.entry_date}</span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {t.exit_paise !== null ? fmtINR(t.exit_paise / 100) : "—"}
                      <span className="block text-[10px] text-muted-foreground">{t.exit_date ?? "—"}</span>
                    </td>
                    <td className="px-3 py-2 text-left text-xs text-muted-foreground">
                      {humanReason(t.exit_reason, t.status)}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${gainClass(t.realized_pnl_paise)}`}>
                      {t.realized_pnl_paise !== null ? fmtINRSigned(t.realized_pnl_paise / 100) : "—"}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${gainClass(t.r_multiple)}`}>
                      {t.r_multiple !== null ? `${t.r_multiple.toFixed(2)}R` : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{t.bars_held}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {now !== null ? fmtINR(now / 100) : "—"}
                      {sinceExitPct !== null && (
                        <span className={`block text-[10px] ${gainClass(sinceExitPct)}`}>
                          {fmtPct(sinceExitPct)} since exit
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
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
