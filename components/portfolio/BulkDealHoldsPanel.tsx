"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { fmtPct } from "./utils";

interface FirmStats {
  client_name: string;
  n: number;
  total_qty: number;
  qty_weighted_return_pct: number;
  win_rate_pct: number;
  median_return_pct: number;
  median_holding_days: number;
}

interface HoldingBucketStats {
  label: string;
  n: number;
  mean_return_pct: number;
  median_return_pct: number;
  win_rate_pct: number;
}

interface OpenLotWithClient {
  client_name: string;
  symbol: string;
  buy_date: string;
  buy_price: number;
  qty: number;
}

interface FifoResult {
  status: string;
  message?: string;
  hft_holding_days_threshold: number;
  data_through: string | null;
  last_fetched_at: string | null;
  total_institutional_buy_rows: number;
  realized_trade_count_all_firms: number;
  hft_firms_excluded_count: number;
  hft_realized_trades_excluded_count: number;
  non_hft_realized_trade_count: number;
  unmatched_sell_events: number;
  unmatched_sell_qty: number;
  open_lots_count: number;
  open_lots_qty: number;
  non_hft_open_lots_total: number;
  non_hft_open_lots_page: number;
  non_hft_open_lots_page_size: number;
  non_hft_open_lots: OpenLotWithClient[];
  overall: {
    mean_return_pct: number;
    median_return_pct: number;
    qty_weighted_return_pct: number;
    win_rate_pct: number;
    median_holding_days: number;
    mean_holding_days: number;
  } | null;
  holding_buckets: HoldingBucketStats[];
  top_active_firms: FirmStats[];
  best_firms: FirmStats[];
  worst_firms: FirmStats[];
  caveats: string[];
}

function gainClass(v: number | null | undefined): string {
  if (v === null || v === undefined) return "text-muted-foreground";
  return v > 0 ? "text-emerald-600" : v < 0 ? "text-red-600" : "text-foreground";
}

function MiniStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold mt-0.5 text-foreground num">{value}</div>
    </div>
  );
}

function FirmTable({ title, firms }: { title: string; firms: FirmStats[] }) {
  if (firms.length === 0) return null;
  return (
    <div className="rounded-lg border border-border bg-card overflow-x-auto">
      <div className="px-3 pt-3 text-sm font-medium">{title}</div>
      <table className="w-full text-sm mt-2">
        <thead>
          <tr className="border-b border-border bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
            <th className="px-3 py-2 text-left">Client</th>
            <th className="px-3 py-2 text-right">Trades</th>
            <th className="px-3 py-2 text-right">Qty-wtd return</th>
            <th className="px-3 py-2 text-right">Win rate</th>
            <th className="px-3 py-2 text-right">Median hold</th>
          </tr>
        </thead>
        <tbody>
          {firms.map((f) => (
            <tr key={f.client_name} className="border-b border-border last:border-0 hover:bg-muted/20">
              <td className="px-3 py-2">
                <Link
                  href={`/strategies/bulk-deal-client/${encodeURIComponent(f.client_name)}`}
                  className="hover:underline text-primary"
                >
                  {f.client_name}
                </Link>
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{f.n}</td>
              <td className={`px-3 py-2 text-right tabular-nums ${gainClass(f.qty_weighted_return_pct)}`}>
                {fmtPct(f.qty_weighted_return_pct)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{f.win_rate_pct.toFixed(1)}%</td>
              <td className="px-3 py-2 text-right tabular-nums">{f.median_holding_days.toFixed(0)}d</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OpenLotsTable({
  result,
  page,
  onPageChange,
  pageLoading,
}: {
  result: FifoResult;
  page: number;
  onPageChange: (page: number) => void;
  pageLoading: boolean;
}) {
  const totalPages = Math.max(1, Math.ceil(result.non_hft_open_lots_total / result.non_hft_open_lots_page_size));
  return (
    <div className="rounded-lg border border-border bg-card overflow-x-auto">
      <div className="flex items-center justify-between px-3 pt-3">
        <div className="text-sm font-medium">
          Open (unrealized) non-HFT positions — never disclosed-sold ({result.non_hft_open_lots_total.toLocaleString("en-IN")})
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onPageChange(page - 1)}
            disabled={pageLoading || page <= 1}
            className="px-2 py-1 rounded border border-border text-xs disabled:opacity-40 hover:bg-accent"
          >
            Prev
          </button>
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => onPageChange(page + 1)}
            disabled={pageLoading || page >= totalPages}
            className="px-2 py-1 rounded border border-border text-xs disabled:opacity-40 hover:bg-accent"
          >
            Next
          </button>
        </div>
      </div>
      <table className="w-full text-sm mt-2">
        <thead>
          <tr className="border-b border-border bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
            <th className="px-3 py-2 text-left">Client</th>
            <th className="px-3 py-2 text-left">Symbol</th>
            <th className="px-3 py-2 text-right">Buy date</th>
            <th className="px-3 py-2 text-right">Buy price</th>
            <th className="px-3 py-2 text-right">Qty</th>
          </tr>
        </thead>
        <tbody>
          {result.non_hft_open_lots.length === 0 && (
            <tr>
              <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                No open positions on this page.
              </td>
            </tr>
          )}
          {result.non_hft_open_lots.map((lot, i) => (
            <tr key={`${lot.client_name}-${lot.symbol}-${lot.buy_date}-${i}`} className="border-b border-border last:border-0 hover:bg-muted/20">
              <td className="px-3 py-2">
                <Link
                  href={`/strategies/bulk-deal-client/${encodeURIComponent(lot.client_name)}`}
                  className="hover:underline text-primary"
                >
                  {lot.client_name}
                </Link>
              </td>
              <td className="px-3 py-2">
                <a href={`/stock/${encodeURIComponent(lot.symbol)}`} className="hover:underline">{lot.symbol}</a>
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{lot.buy_date}</td>
              <td className="px-3 py-2 text-right tabular-nums">₹{lot.buy_price.toFixed(2)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{lot.qty.toLocaleString("en-IN")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A daily cron refreshes bulk_deals (scripts/cron/refresh-bulk-deals.sh).
 * Flag data older than this so a broken job is visible on the page rather than
 * silently serving stale numbers. NSE publishes each day's report the same
 * evening, but the exchange is shut at weekends and on trading holidays, so a
 * couple of quiet days is normal and shouldn't cry wolf. */
const STALE_AFTER_DAYS = 4;

function FreshnessLine({ result }: { result: FifoResult }) {
  if (!result.data_through) return null;
  const ageDays = Math.floor((Date.now() - new Date(result.data_through).getTime()) / 86_400_000);
  const stale = ageDays > STALE_AFTER_DAYS;
  return (
    <span className={`text-xs ${stale ? "text-amber-700" : "text-muted-foreground"}`}>
      Deals through <span className="tabular-nums">{result.data_through}</span>
      {stale && ` — ${ageDays} days old, the daily refresh may have stopped`}
    </span>
  );
}

const OPEN_LOTS_PAGE_SIZE = 25;

export default function BulkDealHoldsPanel() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FifoResult | null>(null);
  const [openLotsPage, setOpenLotsPage] = useState(1);

  async function run(page = openLotsPage) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/bulk-deals/institutional-holds?openLotsPage=${page}&openLotsPageSize=${OPEN_LOTS_PAGE_SIZE}`);
      const body = (await res.json().catch(() => null)) as FifoResult | null;
      if (!res.ok || !body || body.status !== "ok") {
        setError(body?.message ?? `Failed (HTTP ${res.status})`);
        return;
      }
      setResult(body);
      setOpenLotsPage(page);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    run(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button
          onClick={() => run(1)}
          disabled={loading}
          className="px-3 py-1.5 rounded-lg border border-border bg-card text-xs font-medium hover:bg-accent disabled:opacity-50"
        >
          {loading ? "Analyzing…" : "Recompute"}
        </button>
        {loading && <span className="text-xs text-muted-foreground">Reconstructing trades from bulk_deals…</span>}
        {!loading && result && <FreshnessLine result={result} />}
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      {result && result.overall && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <MiniStat label="Non-HFT realized trades" value={result.non_hft_realized_trade_count} />
            <MiniStat label="HFT firms excluded" value={result.hft_firms_excluded_count} />
            <MiniStat
              label="Median return / trade"
              value={<span className={gainClass(result.overall.median_return_pct)}>{fmtPct(result.overall.median_return_pct, 2)}</span>}
            />
            <MiniStat
              label="Qty-weighted return"
              value={<span className={gainClass(result.overall.qty_weighted_return_pct)}>{fmtPct(result.overall.qty_weighted_return_pct, 2)}</span>}
            />
            <MiniStat label="Win rate" value={`${result.overall.win_rate_pct.toFixed(1)}%`} />
            <MiniStat label="Median holding period" value={`${result.overall.median_holding_days.toFixed(0)} days`} />
            <MiniStat label="Open (unrealized) lots" value={result.open_lots_count} />
            <MiniStat label="Unmatched sells (excluded)" value={result.unmatched_sell_events} />
          </div>

          {result.holding_buckets.length > 0 && (
            <div className="rounded-lg border border-border bg-card p-4">
              <h3 className="text-sm font-medium mb-2">Return by holding period</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {result.holding_buckets.map((b) => (
                  <div key={b.label} className="rounded-md border border-border/60 p-3">
                    <div className="text-xs text-muted-foreground">{b.label} (n={b.n})</div>
                    <div className={`text-sm font-semibold ${gainClass(b.mean_return_pct)}`}>
                      mean {fmtPct(b.mean_return_pct, 2)} · median {fmtPct(b.median_return_pct, 2)} · win {b.win_rate_pct.toFixed(1)}%
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <FirmTable title="Most active non-HFT firms" firms={result.top_active_firms} />
          <FirmTable title="Best qty-weighted return (≥5 trades)" firms={result.best_firms} />
          <FirmTable title="Worst qty-weighted return (≥5 trades)" firms={result.worst_firms} />

          <OpenLotsTable result={result} page={openLotsPage} onPageChange={run} pageLoading={loading} />

          <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
            <p className="text-xs font-medium text-amber-900 mb-1">Caveats</p>
            <ul className="space-y-1">
              {result.caveats.map((c, i) => (
                <li key={i} className="text-xs text-amber-800 flex gap-1.5">
                  <span className="shrink-0">·</span>
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {result && !result.overall && (
        <p className="text-xs text-muted-foreground">No non-HFT realized trades found in the current dataset.</p>
      )}
    </div>
  );
}

