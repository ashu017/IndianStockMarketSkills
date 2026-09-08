"use client";

import { useCallback, useEffect, useState } from "react";

interface AccountSummary {
  starting_cash_paise: number;
  current_cash_paise: number;
  equity_paise: number;
  total_return_pct: number;
  realized_pnl_paise: number;
  unrealized_pnl_paise: number;
  open_count: number;
  closed_count: number;
  win_rate_pct: number | null;
  avg_r_multiple: number | null;
  best_trade_paise: number | null;
  worst_trade_paise: number | null;
  max_drawdown_pct: number | null;
}

interface OpenTrade {
  id: number;
  symbol: string;
  entry_date: string;
  entry_rs: number;
  qty: number;
  /** Shares still held after any scale-out — what the unrealized figures mark on. */
  qty_open: number;
  scaled_out: boolean;
  partial_exit_date: string | null;
  partial_exit_rs: number | null;
  partial_pnl_rs: number;
  capital_committed_rs: number;
  initial_stop_rs: number;
  current_stop_rs: number;
  target_rs: number;
  latest_close_rs: number | null;
  unrealized_pnl_rs: number | null;
  unrealized_pct: number | null;
  bars_held: number;
  moved_to_breakeven: boolean;
}

interface ClosedTrade {
  id: number;
  symbol: string;
  entry_date: string;
  exit_date: string;
  entry_rs: number;
  exit_rs: number;
  qty: number;
  realized_pnl_rs: number;
  r_multiple: number | null;
  exit_reason: string;
  status: string;
  bars_held: number;
}

interface EquityPoint {
  date: string;
  cash_rs: number;
  equity_rs: number;
  realized_pnl_rs: number;
  unrealized_pnl_rs: number;
  open_count: number;
  winners: number;
  losers: number;
}

interface Envelope {
  status: string;
  account: AccountSummary;
  open_trades: OpenTrade[];
  closed_trades: ClosedTrade[];
  equity_curve: EquityPoint[];
}

const inr = (v: number, digits = 0): string =>
  `₹${v.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const inrSigned = (v: number, digits = 0): string => (v >= 0 ? "+" : "−") + inr(Math.abs(v), digits);
const pct = (v: number | null, digits = 2): string =>
  v === null ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(digits)}%`;
const gainClass = (v: number | null): string =>
  v === null ? "text-muted-foreground" : v > 0 ? "text-emerald-600" : v < 0 ? "text-red-600" : "text-foreground";

function StatTile({ label, value, sub, valueClass }: { label: string; value: React.ReactNode; sub?: React.ReactNode; valueClass?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold mt-1 ${valueClass ?? "text-foreground"}`}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

/**
 * Simple inline SVG line chart. Uses no chart library — the equity curve is
 * a single-series line, so recharts here would be overkill.
 */
function EquityCurveChart({ points }: { points: EquityPoint[] }) {
  if (points.length < 2) {
    return (
      <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
        Equity curve appears after 2+ daily snapshots.
      </div>
    );
  }
  const values = points.map((p) => p.equity_rs);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const W = 800, H = 200, PAD = 20;
  const step = (W - 2 * PAD) / (points.length - 1);
  const path = points
    .map((p, i) => {
      const x = PAD + i * step;
      const y = H - PAD - ((p.equity_rs - min) / range) * (H - 2 * PAD);
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium">Equity curve</h3>
        <div className="text-xs text-muted-foreground">
          {points[0].date} → {points[points.length - 1].date}
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-40">
        <path d={path} fill="none" stroke="currentColor" strokeWidth="2" className="text-primary" />
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="currentColor" strokeOpacity="0.15" />
        <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} stroke="currentColor" strokeOpacity="0.15" />
        <text x={PAD} y={PAD - 4} className="text-[10px] fill-muted-foreground">{inr(max)}</text>
        <text x={PAD} y={H - PAD + 12} className="text-[10px] fill-muted-foreground">{inr(min)}</text>
      </svg>
    </div>
  );
}

export default function PaperClient() {
  const [data, setData] = useState<Envelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/paper");
      const j = (await res.json()) as Envelope;
      if (!res.ok || j.status !== "ok") setError(`HTTP ${res.status}`);
      else { setData(j); setError(null); }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const closeTrade = useCallback(async (id: number, symbol: string) => {
    if (!confirm(`Close ${symbol} at latest LTP?`)) return;
    setClosing(id);
    try {
      await fetch("/api/paper/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trade_id: id, reason: `manual close from UI (${symbol})` }),
      });
      await load();
    } finally {
      setClosing(null);
    }
  }, [load]);

  if (loading && !data) {
    return <div className="p-8 text-sm text-muted-foreground">Loading paper trading state…</div>;
  }
  if (error) {
    return <div className="p-8 text-sm text-red-600">Error: {error}</div>;
  }
  if (!data) return null;
  const a = data.account;

  return (
    <div className="max-w-[1200px] mx-auto px-4 py-6 space-y-6">
      {/* Header — 8 stat tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile
          label="Equity"
          value={inr(a.equity_paise / 100, 0)}
          sub={
            <span className={gainClass(a.total_return_pct)}>
              {pct(a.total_return_pct)} vs start
            </span>
          }
        />
        <StatTile
          label="Free cash"
          value={inr(a.current_cash_paise / 100, 0)}
          sub={`from ${inr(a.starting_cash_paise / 100)} start`}
        />
        <StatTile
          label="Unrealized P&L"
          value={inrSigned(a.unrealized_pnl_paise / 100, 0)}
          valueClass={gainClass(a.unrealized_pnl_paise)}
          sub={`across ${a.open_count} open`}
        />
        <StatTile
          label="Realized P&L"
          value={inrSigned(a.realized_pnl_paise / 100, 0)}
          valueClass={gainClass(a.realized_pnl_paise)}
          sub={`${a.closed_count} closed`}
        />
        <StatTile
          label="Win rate"
          value={a.win_rate_pct === null ? "—" : `${a.win_rate_pct.toFixed(0)}%`}
          sub={`${a.closed_count} closed trades`}
        />
        <StatTile
          label="Avg R multiple"
          value={a.avg_r_multiple === null ? "—" : `${a.avg_r_multiple.toFixed(2)}R`}
          sub="per closed trade"
        />
        <StatTile
          label="Best / worst"
          value={
            a.best_trade_paise === null && a.worst_trade_paise === null
              ? "—"
              : `${inrSigned((a.best_trade_paise ?? 0) / 100, 0)} / ${inrSigned((a.worst_trade_paise ?? 0) / 100, 0)}`
          }
          sub="single trade"
        />
        <StatTile
          label="Max drawdown"
          value={a.max_drawdown_pct === null ? "—" : pct(-a.max_drawdown_pct)}
          valueClass={a.max_drawdown_pct ? "text-red-600" : ""}
          sub="peak-to-trough on equity"
        />
      </div>

      {/* Equity curve */}
      <EquityCurveChart points={data.equity_curve} />

      {/* Open positions */}
      <section>
        <h2 className="text-sm font-medium mb-2">Open positions ({data.open_trades.length})</h2>
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
                <th className="px-3 py-2 text-right"></th>
              </tr>
            </thead>
            <tbody>
              {data.open_trades.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-3 py-6 text-center text-muted-foreground">
                    No open positions. Signals from the scanner will open trades here.
                  </td>
                </tr>
              )}
              {data.open_trades.map((t) => (
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
                          t.partial_exit_rs !== null
                            ? `${t.qty - t.qty_open} of ${t.qty} shares booked at ${inr(t.partial_exit_rs, 2)} on ${t.partial_exit_date}, ${inrSigned(t.partial_pnl_rs)} realized`
                            : "Part of this position has been booked"
                        }
                      >
                        ½ booked
                      </span>
                    )}
                  </td>
                  {/* Shares still held — the booked half is already back in cash
                      and out of the unrealized column. */}
                  <td className="px-3 py-2 text-right tabular-nums">
                    {t.qty_open}
                    {t.scaled_out && <span className="ml-1 text-xs text-muted-foreground">of {t.qty}</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{inr(t.entry_rs, 2)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{t.latest_close_rs !== null ? inr(t.latest_close_rs, 2) : "—"}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${gainClass(t.unrealized_pnl_rs)}`}>
                    {t.unrealized_pnl_rs !== null ? inrSigned(t.unrealized_pnl_rs) : "—"}
                    <span className="ml-1 text-xs">({pct(t.unrealized_pct)})</span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-red-600">{inr(t.current_stop_rs, 2)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-emerald-600">{inr(t.target_rs, 2)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{t.bars_held}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{inr(t.capital_committed_rs, 0)}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => closeTrade(t.id, t.symbol)}
                      disabled={closing === t.id}
                      className="text-xs px-2 py-1 rounded border border-border hover:bg-accent disabled:opacity-50"
                    >
                      {closing === t.id ? "closing…" : "close"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Closed trades */}
      <section>
        <h2 className="text-sm font-medium mb-2">Closed trades ({data.closed_trades.length})</h2>
        <div className="rounded-lg border border-border bg-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-3 py-2 text-left">Symbol</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-right">Entry → Exit</th>
                <th className="px-3 py-2 text-right">Qty</th>
                <th className="px-3 py-2 text-right">Realized P&L</th>
                <th className="px-3 py-2 text-right">R multiple</th>
                <th className="px-3 py-2 text-right">Days</th>
                <th className="px-3 py-2 text-left">Reason</th>
              </tr>
            </thead>
            <tbody>
              {data.closed_trades.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">
                    No closed trades yet.
                  </td>
                </tr>
              )}
              {data.closed_trades.map((t) => (
                <tr key={t.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                  <td className="px-3 py-2 font-medium">
                    <a href={`/stock/${encodeURIComponent(t.symbol)}`} className="hover:underline">{t.symbol}</a>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <span className={`px-1.5 py-0.5 rounded border ${
                      t.status === "target_hit" ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : t.status === "stopped" ? "border-red-200 bg-red-50 text-red-700"
                      : t.status === "rotated_out" ? "border-blue-200 bg-blue-50 text-blue-700"
                      : "border-amber-200 bg-amber-50 text-amber-700"
                    }`}>{t.status}</span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-xs">
                    {t.entry_date} @ {inr(t.entry_rs, 2)}<br />
                    {t.exit_date} @ {inr(t.exit_rs, 2)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{t.qty}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${gainClass(t.realized_pnl_rs)}`}>
                    {inrSigned(t.realized_pnl_rs)}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${gainClass(t.r_multiple)}`}>
                    {t.r_multiple === null ? "—" : `${t.r_multiple >= 0 ? "+" : ""}${t.r_multiple.toFixed(2)}R`}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{t.bars_held}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground max-w-md truncate" title={t.exit_reason}>
                    {t.exit_reason}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="text-center text-xs text-muted-foreground/60">
        Paper trading — simulated positions from scanner-emitted signals. Not real orders.
      </p>
    </div>
  );
}

