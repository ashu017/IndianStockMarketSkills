/**
 * Run the live strategy's backtest and print the full summary.
 *
 * Runs the same recipe twice at two portfolio concentrations — the backtest's
 * default 20 notional slots and the live account's own concurrency cap — because
 * they answer different questions. Trade-level statistics (win rate, expectancy,
 * profit factor) are IDENTICAL across the two: buildEquityCurve never drops a
 * trade, it only reweights. What moves is drawdown, volatility and Sharpe, which
 * is exactly the part the live account experiences differently from the page's
 * headline figures.
 *
 * Usage (needs Node 20+ for better-sqlite3's prebuilt binary, and the
 * react-server condition so lib/backtest.ts's `server-only` import resolves to
 * its empty stub — same as scripts/backtest-momentum-sweep.ts):
 *
 *   PATH="$HOME/.local/node22/bin:$PATH" npx tsx --conditions react-server \
 *     scripts/backtest-live-strategy.ts [--no-gate] [--v1]
 *
 *   (default)   the live gated strategy, quality gate ON
 *   --no-gate   the technical-only variant
 *   --v1        the frozen pre-2026-08-31 exit rule, for the before/after
 */
import {
  runTechnicalBacktest,
  MOMENTUM_VARIANTS,
  type BacktestSummary,
} from "@/lib/backtest";
import { DEFAULT_SIZING } from "@/lib/paper";
import { DEFAULT_EQUITY_SLOTS } from "@/lib/equity-curve";

const args = process.argv.slice(2);
const qualityGate = !args.includes("--no-gate");
const variant = args.includes("--v1") ? "v1" : "live";

const n = (v: number | null | undefined, d = 2, suffix = ""): string =>
  v === null || v === undefined ? "—" : v.toFixed(d) + suffix;

function tradeLevel(s: BacktestSummary): void {
  console.log(`  universe:        ${s.universe_with_enough_history} symbols with enough history` +
    (s.quality_gate_applied ? ` (${s.universe_quality_pass}/${s.universe_requested} passed the quality gate)` : ` (no quality gate, ${s.universe_requested} requested)`));
  console.log(`  window:          ${s.usable_window_start ?? "—"} → ${s.last_bar_date ?? "—"}`);
  console.log(`  trades:          ${s.n_trades} across ${s.n_symbols_traded} symbols`);
  console.log(`  win rate:        ${n(s.win_rate_pct, 2, "%")}`);
  console.log(`  expectancy:      ${n(s.expectancy_r, 3, "R")} per trade`);
  console.log(`  avg / median:    ${n(s.avg_return_pct, 2, "%")} / ${n(s.median_return_pct, 2, "%")} per trade`);
  console.log(`  avg win / loss:  ${n(s.avg_win_pct, 2, "%")} / ${n(s.avg_loss_pct, 2, "%")}`);
  console.log(`  profit factor:   ${n(s.profit_factor, 2)}`);
  console.log(`  hold:            avg ${n(s.avg_bars_held, 1)} / median ${n(s.median_bars_held, 1)} bars`);
  console.log(`  partial exits:   ${s.n_partial_exits ?? "—"}` +
    (s.avg_partial_bars_held !== null && s.avg_partial_bars_held !== undefined
      ? ` (first leg booked at avg ${n(s.avg_partial_bars_held, 1)} bars)` : ""));
  const reasons = Object.entries(s.exit_reasons).sort((a, b) => b[1] - a[1]);
  console.log(`  exit reasons:    ${reasons.map(([k, v]) => `${k} ${v} (${(100 * v / s.n_trades).toFixed(0)}%)`).join(", ")}`);
  console.log(`  costs:           ${s.cost_bps_roundtrip} bps round-trip`);
}

function portfolioLevel(s: BacktestSummary, label: string): void {
  const m = s.metrics;
  console.log(`  ${label.padEnd(22)} slots ${String(s.equity_slots).padStart(2)} | peak concurrent ${s.max_concurrent_positions ?? "—"}`);
  if (!m) {
    console.log("    (no metrics — curve unavailable)");
    return;
  }
  console.log(`    CAGR           ${n(m.cagr_pct, 2, "%")}`);
  console.log(`    max drawdown   ${n(m.max_drawdown_pct, 2, "%")}`);
  console.log(`    total return   ${n(m.total_return_pct, 2, "%")}`);
  console.log(`    volatility     ${n(m.volatility_ann_pct, 2, "%")} annualized`);
  console.log(`    Sharpe         ${n(m.sharpe, 3)}`);
  console.log(`    Sortino        ${n(m.sortino, 3)}`);
  console.log(`    Calmar         ${n(m.calmar, 3)}`);
  console.log(`    exposure       ${n(m.exposure_time_pct, 1, "%")} of days in market`);
  const rel = s.benchmark?.relative;
  if (s.benchmark && rel) {
    console.log(
      `    vs ${s.benchmark.label}: ${n(m.total_return_pct, 2, "%")} vs ${n(rel.benchmark_total_return_pct, 2, "%")} ` +
        `(excess ${n(rel.excess_total_return_pct, 2, "%")}, beta ${n(rel.beta, 2)}, alpha ${n(rel.alpha_pct, 2, "%")})`,
    );
  }
}

async function main(): Promise<void> {
  const base = { ...MOMENTUM_VARIANTS[variant], qualityGate };
  console.log(`\n=== ${variant} exit rule | quality gate ${qualityGate ? "ON" : "OFF"} ===\n`);

  const wide = await runTechnicalBacktest("local", { ...base, slots: DEFAULT_EQUITY_SLOTS });
  console.log("TRADE-LEVEL (independent of slot count)");
  tradeLevel(wide.summary);

  const live = await runTechnicalBacktest("local", {
    ...base,
    slots: DEFAULT_SIZING.maxConcurrentTrades,
  });

  // Guard the claim this script makes in its own header. If reweighting ever
  // starts changing which trades exist, the comparison below is meaningless.
  if (live.summary.n_trades !== wide.summary.n_trades) {
    throw new Error(
      `slot count changed the trade population (${wide.summary.n_trades} vs ${live.summary.n_trades}) — the two runs are not comparable`,
    );
  }

  console.log("\nPORTFOLIO-LEVEL (same trades, different concentration)");
  portfolioLevel(wide.summary, "page default");
  portfolioLevel(live.summary, "live concurrency");

  console.log("\nCAVEATS");
  for (const c of wide.summary.caveats) console.log(`  - ${c}`);
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
