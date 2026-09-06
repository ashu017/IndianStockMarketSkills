"use client";

import { useEffect, useRef, useState } from "react";
import { fmtINR, fmtPct } from "./utils";
import BacktestEquityChart, { type EquityPoint } from "./BacktestEquityChart";
import RiskMetricsGrid, { type BenchmarkView, type EquityMetricsView } from "./RiskMetricsGrid";

interface Suggestion {
  symbol: string;
  company: string;
  sector: string;
}

interface OvernightResult {
  status: string;
  message?: string;
  symbol: string;
  exchange: string;
  n_trades: number;
  n_excluded_corporate_action: number;
  win_rate_pct: number | null;
  avg_return_pct: number | null;
  median_return_pct: number | null;
  best_trade_pct: number | null;
  worst_trade_pct: number | null;
  profit_factor: number | null;
  starting_value_rupees: number;
  final_value_rupees: number;
  total_return_pct: number;
  first_date: string | null;
  last_date: string | null;
  equity_curve: EquityPoint[];
  metrics: EquityMetricsView | null;
  benchmark: BenchmarkView | null;
  benchmark_curve: EquityPoint[];
  cost_bps_roundtrip: number;
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

/** Self-contained symbol autocomplete — same /api/symbol-search endpoint as
 * the home page's SymbolSearch, but calls back instead of navigating. */
function SymbolPicker({ onPick, disabled }: { onPick: (symbol: string) => void; disabled: boolean }) {
  const [q, setQ] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [focusIdx, setFocusIdx] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!q || q.length < 1) { setSuggestions([]); return; }
    const controller = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/symbol-search?q=${encodeURIComponent(q)}`, { signal: controller.signal });
        const json = (await res.json()) as { results: Suggestion[] };
        setSuggestions(json.results ?? []);
        setFocusIdx(-1);
      } catch {
        /* aborted / network */
      }
    }, 120);
    return () => { clearTimeout(t); controller.abort(); };
  }, [q]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, []);

  const submit = (sym: string) => {
    const s = sym.trim().toUpperCase();
    if (!s) return;
    setOpen(false);
    setQ(s);
    onPick(s);
  };

  return (
    <div ref={boxRef} className="relative max-w-sm">
      <input
        type="text"
        value={q}
        disabled={disabled}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit(focusIdx >= 0 && suggestions[focusIdx] ? suggestions[focusIdx].symbol : q);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setFocusIdx((i) => Math.min(i + 1, suggestions.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setFocusIdx((i) => Math.max(i - 1, -1));
          }
        }}
        placeholder="Type a symbol (e.g. TCS) or company name"
        className="w-full px-3 py-2 rounded-lg border border-border bg-card text-sm focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
      />
      {open && suggestions.length > 0 && (
        <div className="absolute z-10 mt-1 w-full rounded-lg border border-border bg-popover shadow-md max-h-72 overflow-auto">
          {suggestions.map((s, i) => (
            <button
              key={`${s.symbol}-${i}`}
              onClick={() => submit(s.symbol)}
              onMouseEnter={() => setFocusIdx(i)}
              className={`w-full text-left px-3 py-2 text-sm border-b last:border-0 border-border/50 ${i === focusIdx ? "bg-accent" : "hover:bg-accent/50"}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{s.symbol}</span>
                <span className="text-xs text-muted-foreground">{s.sector}</span>
              </div>
              {s.company && <div className="text-xs text-muted-foreground truncate">{s.company}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function OvernightBacktestPanel() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OvernightResult | null>(null);
  const [symbol, setSymbol] = useState<string | null>(null);

  async function run(sym: string) {
    setSymbol(sym);
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`/api/backtest/overnight/${encodeURIComponent(sym)}`, { method: "POST" });
      const body = (await res.json().catch(() => null)) as OvernightResult | null;
      if (!res.ok || !body || body.status !== "ok") {
        setError(body?.message ?? `Failed (HTTP ${res.status})`);
        return;
      }
      setResult(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <SymbolPicker onPick={run} disabled={loading} />
        {loading && <span className="text-xs text-muted-foreground">Running backtest…</span>}
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      {!result && !error && !loading && (
        <p className="text-xs text-muted-foreground">
          Pick a symbol to backtest: buy at every day&apos;s close, sell at the next day&apos;s open,
          unconditionally, for the full cached price history.
        </p>
      )}

      {result && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <MiniStat label="Symbol" value={`${result.symbol} (${result.exchange})`} />
            <MiniStat label="Trades" value={result.n_trades} />
            <MiniStat
              label="Win rate"
              value={result.win_rate_pct === null ? "—" : `${result.win_rate_pct.toFixed(1)}%`}
            />
            <MiniStat
              label="Total return"
              value={<span className={gainClass(result.total_return_pct)}>{fmtPct(result.total_return_pct)}</span>}
            />
            <MiniStat
              label="Avg return / trade"
              value={
                <span className={gainClass(result.avg_return_pct)}>
                  {result.avg_return_pct === null ? "—" : fmtPct(result.avg_return_pct, 3)}
                </span>
              }
            />
            <MiniStat
              label="Median return / trade"
              value={
                <span className={gainClass(result.median_return_pct)}>
                  {result.median_return_pct === null ? "—" : fmtPct(result.median_return_pct, 3)}
                </span>
              }
            />
            <MiniStat
              label="Best / worst trade"
              value={
                result.best_trade_pct === null
                  ? "—"
                  : `${fmtPct(result.best_trade_pct)} / ${fmtPct(result.worst_trade_pct ?? 0)}`
              }
            />
            <MiniStat
              label="Profit factor"
              value={result.profit_factor === null ? "—" : result.profit_factor === Infinity ? "∞" : result.profit_factor.toFixed(2)}
            />
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              If ₹{result.starting_value_rupees.toLocaleString("en-IN")} was invested on {result.first_date}
            </div>
            <div className={`text-2xl font-semibold mt-1 num ${gainClass(result.total_return_pct)}`}>
              {fmtINR(result.final_value_rupees, 0)}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">as of {result.last_date}</div>
          </div>

          {result.equity_curve.length >= 2 ? (
            <BacktestEquityChart
              strategy={result.equity_curve}
              benchmark={result.benchmark_curve}
              benchmarkLabel={result.benchmark?.label}
              startingValueRupees={result.starting_value_rupees}
              title={`Equity curve — ₹${result.starting_value_rupees.toLocaleString("en-IN")} compounded overnight`}
              height={240}
            />
          ) : (
            <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
              Not enough history to draw an equity curve.
            </div>
          )}

          {result.metrics && (
            <div>
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">
                Risk-adjusted, over the equity curve
              </p>
              <RiskMetricsGrid metrics={result.metrics} benchmark={result.benchmark} />
            </div>
          )}

          <div className="text-xs text-muted-foreground">
            {result.n_excluded_corporate_action > 0 && (
              <span>{result.n_excluded_corporate_action} day(s) excluded as probable corporate-action artifacts · </span>
            )}
            cost {result.cost_bps_roundtrip}bps round-trip
          </div>

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
    </div>
  );
}

