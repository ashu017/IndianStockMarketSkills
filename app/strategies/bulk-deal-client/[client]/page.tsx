export const dynamic = "force-dynamic";

import Link from "next/link";
import { getDb } from "@/lib/db/connection";
import { getClientTrades } from "@/lib/bulk-deal-fifo";
import TopNav from "@/components/portfolio/TopNav";
import { fmtINR, fmtPct } from "@/components/portfolio/utils";

function gainClass(v: number): string {
  return v > 0 ? "text-emerald-600" : v < 0 ? "text-red-600" : "text-foreground";
}

function StatTile({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold mt-1 text-foreground">{value}</div>
    </div>
  );
}

export default async function BulkDealClientPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client } = await params;
  const decoded = decodeURIComponent(client);
  const detail = getClientTrades(getDb(), decoded);

  return (
    <>
      <TopNav currentPage="strategies" />
      <div className="max-w-[1200px] mx-auto px-4 py-6 space-y-6">
        <div>
          <Link
            href="/strategies/bulk_deal_institutional_holds"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            ← Back to Institutional Bulk-Deal Holds
          </Link>
          <div className="flex items-center gap-2 mt-2">
            <h1 className="text-lg font-semibold text-foreground">{detail.client_name}</h1>
            {detail.is_hft && (
              <span className="shrink-0 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">
                HFT-like (median hold ≤{detail.hft_holding_days_threshold}d)
              </span>
            )}
          </div>
        </div>

        {detail.summary ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatTile label="Realized trades" value={detail.summary.n} />
            <StatTile
              label="Qty-weighted return"
              value={<span className={gainClass(detail.summary.qty_weighted_return_pct)}>{fmtPct(detail.summary.qty_weighted_return_pct)}</span>}
            />
            <StatTile label="Win rate" value={`${detail.summary.win_rate_pct.toFixed(1)}%`} />
            <StatTile
              label="Median return / trade"
              value={<span className={gainClass(detail.summary.median_return_pct)}>{fmtPct(detail.summary.median_return_pct)}</span>}
            />
            <StatTile label="Median holding period" value={`${detail.summary.median_holding_days.toFixed(0)} days`} />
            <StatTile label="Total qty traded" value={detail.summary.total_qty.toLocaleString("en-IN")} />
            <StatTile label="Open (unrealized) lots" value={detail.open_lots.length} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No realized (matched buy→sell) trades for this client — only open positions, if any.
          </p>
        )}

        <section>
          <h2 className="text-sm font-medium mb-2">Realized trades ({detail.realized_trades.length})</h2>
          <div className="rounded-lg border border-border bg-card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-3 py-2 text-left">Symbol</th>
                  <th className="px-3 py-2 text-right">Buy date</th>
                  <th className="px-3 py-2 text-right">Buy price</th>
                  <th className="px-3 py-2 text-right">Sell date</th>
                  <th className="px-3 py-2 text-right">Sell price</th>
                  <th className="px-3 py-2 text-right">Qty</th>
                  <th className="px-3 py-2 text-right">Return</th>
                  <th className="px-3 py-2 text-right">Held (days)</th>
                </tr>
              </thead>
              <tbody>
                {detail.realized_trades.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">
                      No realized trades.
                    </td>
                  </tr>
                )}
                {detail.realized_trades.map((t, i) => (
                  <tr key={i} className="border-b border-border last:border-0 hover:bg-muted/20">
                    <td className="px-3 py-2 font-medium">
                      <a href={`/stock/${encodeURIComponent(t.symbol)}`} className="hover:underline">{t.symbol}</a>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{t.buy_date}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtINR(t.buy_price)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{t.sell_date}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtINR(t.sell_price)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{t.qty.toLocaleString("en-IN")}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${gainClass(t.return_pct)}`}>{fmtPct(t.return_pct)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{t.holding_days.toFixed(0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {detail.open_lots.length > 0 && (
          <section>
            <h2 className="text-sm font-medium mb-2">Open (unrealized) lots — never disclosed-sold ({detail.open_lots.length})</h2>
            <div className="rounded-lg border border-border bg-card overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="px-3 py-2 text-left">Symbol</th>
                    <th className="px-3 py-2 text-right">Buy date</th>
                    <th className="px-3 py-2 text-right">Buy price</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.open_lots.map((lot, i) => (
                    <tr key={i} className="border-b border-border last:border-0 hover:bg-muted/20">
                      <td className="px-3 py-2 font-medium">
                        <a href={`/stock/${encodeURIComponent(lot.symbol)}`} className="hover:underline">{lot.symbol}</a>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{lot.buy_date}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtINR(lot.buy_price)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{lot.qty.toLocaleString("en-IN")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <p className="text-xs text-muted-foreground/60">
          Realized trades are FIFO-matched from disclosed NSE bulk/block deals only — not a
          complete trading record for this client. No corporate-action adjustment.
        </p>
      </div>
    </>
  );
}
