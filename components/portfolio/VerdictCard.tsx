"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";

/**
 * VerdictCard — renders StockVerdict returned by /api/verdict/[symbol].
 * Big overall banner + two collapsible check tables + optional trade box.
 * A refresh button re-hits the API with ?refresh=1.
 * A copy button copies a Telegram-ready summary to the clipboard when PASS.
 */

type Overall = "PASS" | "BREAKOUT_PENDING" | "TREND_FAIL" | "QUALITY_FAIL" | "DATA_MISSING";

interface CheckResult {
  filter: string;
  value: number | null;
  displayValue: string;
  threshold: string;
  ok: boolean;
  note?: string;
}
interface Trade {
  entry_paise: number;
  stop_paise: number;
  target_paise: number;
  atr14_paise: number;
  risk_pct: number;
  reward_pct: number;
  risk_reward: number;
}
interface StockVerdict {
  symbol: string;
  exchange: string;
  isin: string | null;
  sector: string | null;
  overall: Overall;
  overallReason: string;
  quality: CheckResult[];
  technical: CheckResult[];
  trade: Trade | null;
  latestBarDate: string | null;
  fundamentalsAsOfDate: string | null;
  warnings: string[];
}

interface Candidate {
  symbol: string;
  company: string;
  sector: string;
}
interface Envelope {
  status: string;
  refreshed?: boolean;
  cache_age_hours?: number | null;
  verdict?: StockVerdict;
  message?: string;
  input?: string;
  candidates?: Candidate[];
}

const OVERALL_STYLE: Record<Overall, { bg: string; text: string; label: string }> = {
  PASS: { bg: "bg-green-100 dark:bg-green-950", text: "text-green-900 dark:text-green-100", label: "BUY signal active" },
  BREAKOUT_PENDING: { bg: "bg-blue-100 dark:bg-blue-950", text: "text-blue-900 dark:text-blue-100", label: "Breakout pending" },
  TREND_FAIL: { bg: "bg-amber-100 dark:bg-amber-950", text: "text-amber-900 dark:text-amber-100", label: "Trend fail" },
  QUALITY_FAIL: { bg: "bg-red-100 dark:bg-red-950", text: "text-red-900 dark:text-red-100", label: "Quality fail" },
  DATA_MISSING: { bg: "bg-slate-100 dark:bg-slate-800", text: "text-slate-900 dark:text-slate-100", label: "Data missing" },
};

function paiseToRs(p: number): string {
  return `₹${(p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function CheckRow({ c }: { c: CheckResult }) {
  return (
    <tr className="border-t border-border">
      <td className="py-2 pr-3 text-sm">
        <span className={c.ok ? "text-green-600" : "text-red-600"}>{c.ok ? "✓" : "✗"}</span>
        <span className="ml-2">{c.filter}</span>
      </td>
      <td className="py-2 pr-3 text-sm text-right tabular-nums">{c.displayValue}</td>
      <td className="py-2 text-xs text-muted-foreground">
        {c.note ?? c.threshold}
      </td>
    </tr>
  );
}

function CheckSection({ title, checks, defaultOpen = true }: { title: string; checks: CheckResult[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const passing = checks.filter((c) => c.ok).length;
  const total = checks.length;
  return (
    <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
             className="border border-border rounded-lg p-4 bg-card">
      <summary className="cursor-pointer flex items-center justify-between font-medium">
        <span>{title}</span>
        <span className="text-sm text-muted-foreground">
          {passing} / {total} pass
        </span>
      </summary>
      <table className="w-full mt-3">
        <tbody>
          {checks.map((c, i) => <CheckRow key={i} c={c} />)}
        </tbody>
      </table>
    </details>
  );
}

function TradeBox({ trade, symbol }: { trade: Trade; symbol: string }) {
  const [copied, setCopied] = useState(false);
  const copyTelegram = useCallback(() => {
    const msg =
      `📈 BUY signal — ${symbol}\n` +
      `  Entry ≤ ${paiseToRs(trade.entry_paise)}\n` +
      `  Target ${paiseToRs(trade.target_paise)} (+${trade.reward_pct.toFixed(1)}%)\n` +
      `  Stop ${paiseToRs(trade.stop_paise)} (−${trade.risk_pct.toFixed(1)}%)\n` +
      `  R:R ${trade.risk_reward}:1  (ATR14 ${paiseToRs(trade.atr14_paise)})\n` +
      `Educational only — not SEBI-registered investment advice.`;
    navigator.clipboard.writeText(msg).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [trade, symbol]);

  return (
    <div className="rounded-lg border border-green-500 bg-green-50 dark:bg-green-950 p-4">
      <div className="grid grid-cols-3 gap-4 text-sm">
        <div>
          <div className="text-xs text-muted-foreground">Entry</div>
          <div className="text-lg font-semibold tabular-nums">{paiseToRs(trade.entry_paise)}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Target</div>
          <div className="text-lg font-semibold text-green-700 dark:text-green-400 tabular-nums">
            {paiseToRs(trade.target_paise)}
            <span className="ml-2 text-xs font-normal">+{trade.reward_pct.toFixed(1)}%</span>
          </div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Stop</div>
          <div className="text-lg font-semibold text-red-700 dark:text-red-400 tabular-nums">
            {paiseToRs(trade.stop_paise)}
            <span className="ml-2 text-xs font-normal">−{trade.risk_pct.toFixed(1)}%</span>
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
        <span>R:R {trade.risk_reward}:1  ·  ATR14 {paiseToRs(trade.atr14_paise)}</span>
        <button
          onClick={copyTelegram}
          className="px-3 py-1 text-xs rounded border border-border hover:bg-accent"
        >
          {copied ? "Copied ✓" : "Copy for Telegram"}
        </button>
      </div>
    </div>
  );
}

export default function VerdictCard({ symbol }: { symbol: string }) {
  const router = useRouter();
  const [envelope, setEnvelope] = useState<Envelope | null>(null);
  const [ambiguous, setAmbiguous] = useState<{ input: string; candidates: Candidate[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (forceRefresh: boolean) => {
    setLoading(true);
    setError(null);
    setAmbiguous(null);
    try {
      const url = `/api/verdict/${encodeURIComponent(symbol)}${forceRefresh ? "?refresh=1" : ""}`;
      const res = await fetch(url);
      const json = (await res.json()) as Envelope;
      if (res.status === 300 && json.status === "ambiguous") {
        setAmbiguous({ input: json.input ?? symbol, candidates: json.candidates ?? [] });
      } else if (!res.ok || json.status !== "ok") {
        setError(json.message ?? `HTTP ${res.status}`);
        setEnvelope(null);
      } else {
        setEnvelope(json);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [symbol]);

  useEffect(() => { load(false); }, [load]);

  if (loading && !envelope && !ambiguous) {
    return <div className="text-sm text-muted-foreground py-6">Analyzing {symbol}…</div>;
  }
  if (ambiguous) {
    return (
      <div className="rounded-lg border border-blue-500 bg-blue-50 dark:bg-blue-950 p-4">
        <div className="font-medium text-blue-900 dark:text-blue-100">
          Multiple stocks match &quot;{ambiguous.input}&quot;
        </div>
        <div className="text-sm text-blue-800 dark:text-blue-200 mt-1">
          Pick one:
        </div>
        <div className="mt-3 grid gap-2">
          {ambiguous.candidates.map((c) => (
            <button
              key={c.symbol}
              onClick={() => router.push(`/stock/${encodeURIComponent(c.symbol)}`)}
              className="text-left rounded border border-border bg-card px-3 py-2 hover:bg-accent"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{c.symbol}</span>
                <span className="text-xs text-muted-foreground">{c.sector}</span>
              </div>
              {c.company && <div className="text-xs text-muted-foreground">{c.company}</div>}
            </button>
          ))}
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-lg border border-red-500 bg-red-50 dark:bg-red-950 p-4 text-sm">
        <div className="font-medium text-red-900 dark:text-red-100">Verdict failed for {symbol}</div>
        <div className="text-red-800 dark:text-red-200 mt-1">{error}</div>
        <button
          onClick={() => load(true)}
          className="mt-3 px-3 py-1 text-xs rounded border border-border hover:bg-accent"
        >
          Retry with fresh data
        </button>
      </div>
    );
  }
  if (!envelope?.verdict) return null;
  const v = envelope.verdict;
  const style = OVERALL_STYLE[v.overall];

  return (
    <div className="space-y-4">
      {/* Big banner */}
      <div className={`rounded-lg p-4 ${style.bg} ${style.text}`}>
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-wider opacity-70">Verdict</div>
            <div className="text-2xl font-bold">{style.label}</div>
            <div className="mt-1 text-sm opacity-90">{v.overallReason}</div>
          </div>
          <button
            onClick={() => load(true)}
            disabled={loading}
            className="px-3 py-2 text-sm rounded border border-current opacity-80 hover:opacity-100 disabled:opacity-50"
          >
            {loading ? "Refreshing…" : "Refresh data"}
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs opacity-80">
          {v.sector && <span>Sector: {v.sector}</span>}
          {v.fundamentalsAsOfDate && <span>Fundamentals as of: {v.fundamentalsAsOfDate}</span>}
          {v.latestBarDate && <span>Latest bar: {v.latestBarDate}</span>}
          {envelope.cache_age_hours !== undefined && envelope.cache_age_hours !== null && (
            <span>Data age: {envelope.cache_age_hours.toFixed(1)}h</span>
          )}
          {envelope.refreshed && <span>Refreshed just now</span>}
        </div>
        {v.warnings.length > 0 && (
          <div className="mt-2 text-xs opacity-80">
            {v.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
          </div>
        )}
      </div>

      {/* Trade box when PASS */}
      {v.overall === "PASS" && v.trade && <TradeBox trade={v.trade} symbol={v.symbol} />}

      {/* Check tables */}
      {v.quality.length > 0 && <CheckSection title="Fundamental quality (6 filters)" checks={v.quality} />}
      {v.technical.length > 0 && <CheckSection title="Technical layer (5 filters)" checks={v.technical} />}
    </div>
  );
}

