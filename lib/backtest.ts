import "server-only";
import { getDb } from "./db/connection";
import { sma, donchianLow, atr, avgVolume, isDonchianBreakout, volAdjMomentum, volAdjMomentumYZ } from "./indicators";
import { TECHNICAL_THRESHOLDS, evaluate, loadCoalescedFundamentals } from "./verdict";
import {
  buildEquityCurve,
  DEFAULT_EQUITY_SLOTS,
  DEFAULT_STARTING_RUPEES,
} from "./equity-curve";
import {
  computeEquityMetrics,
  toSeries,
  DEFAULT_RISK_FREE_RATE_PCT,
  type EquityMetrics,
  type EquityPoint,
} from "./metrics";
import { benchmarkCaveat, compareToBenchmark, type BenchmarkComparison } from "./benchmark";
import { eligibleSymbolsAsOf, loadUniverseTimeline } from "./universe-snapshot";
// Sizing knobs only, for the caveat text — no cycle: lib/paper.ts imports
// metrics + exit-rules and never reaches back here.
import { DEFAULT_SIZING } from "./paper";
import {
  EXIT_RULES,
  V1_STOP_ATR_MULT,
  V1_TARGET_R_MULTIPLE,
  type ExitRule,
} from "./exit-rules";

/**
 * On-demand technical-only backtest for the quality_trend_momentum_breakout
 * strategy and, with `qualityGate: false`, for its no-fundamentals sibling
 * trend_momentum_breakout_technical (lib/strategies.ts) — the two share every
 * price rule, so they share this engine rather than forking it.
 * Deliberately narrower than the live recipe — see CAVEATS below and
 * in the returned summary.caveats — because this app's own DB only has ~1.5
 * years of price history and essentially no POINT-IN-TIME fundamentals (a
 * handful of snapshot dates in the last month). Decisions made explicitly:
 *
 *   - FUNDAMENTALS: today's quality-gate pass/fail is used as a static
 *     pre-filter (a symbol either qualifies for the whole backtest or is
 *     excluded entirely) — NOT a point-in-time filter. A symbol that passed
 *     quality only recently is treated as if it always passed. This inflates
 *     results somewhat (survivorship-bias-adjacent) and is called out in the
 *     caveats every run. `qualityGate: false` drops this filter entirely, which
 *     is both a separate strategy and the cleanest way to see how much of the
 *     gated strategy's result was the gate.
 *   - TECHNICAL RULES reuse the exact same functions as the live scanner
 *     (lib/indicators.ts, lib/verdict.ts's TECHNICAL_THRESHOLDS) so a result
 *     here reflects the real recipe, not a re-derived approximation.
 *   - EXIT LOGIC (stop/target/breakeven/trail/time-exit) matches the RULE as
 *     documented (lib/strategies.ts rule group 6), simulated bar-by-bar
 *     forward in time — NOT a literal copy of lib/paper.ts's
 *     updateOpenPaperTrades(), whose bars_held bookkeeping only works
 *     correctly because it's re-run daily by a cron; a batch walk-forward
 *     needs to check the time-exit condition on every bar, which this does.
 *   - NOT SIMULATED: the live paper account's 5-position concurrency cap,
 *     momentum-based rotation eviction, or capital sizing — those are
 *     account-capital constraints, not properties of the technical signal
 *     itself. This backtest measures the RECIPE's raw trade-level edge, so
 *     it will show more parallel trades than the live account could hold.
 *   - The market-regime gate (median close vs its own 200-day SMA) IS
 *     simulated, computed across the same qualifying universe used here.
 *   - UNIVERSE MEMBERSHIP is point-in-time WHEN the universe_snapshot table
 *     covers the backtest window, and today's NIFTY 500 list applied backward
 *     otherwise. The mode that actually ran is reported as
 *     summary.universe_mode and in the caveats — see resolveUniverseMode().
 *
 * Beyond trade-level statistics, the engine also produces a portfolio EQUITY
 * CURVE (lib/equity-curve.ts) and risk-adjusted metrics over it
 * (lib/metrics.ts), plus a Nifty benchmark comparison (lib/benchmark.ts).
 * Win rate and average return say nothing about drawdown or volatility, and a
 * drawdown is a property of the sequence of returns rather than of the bag of
 * trades — so the curve is what makes this strategy comparable to any other.
 */

const T = TECHNICAL_THRESHOLDS;
const TREND_LOOKBACK = 200; // SMA200 — the binding warm-up requirement (dominates breakout's 21 and ATR's 15)
const MAX_SIGNALS_PER_DAY = 5; // matches scripts/scan-nifty100-signals.ts's MAX_SIGNALS default
const DEFAULT_COST_BPS_ROUNDTRIP = 20; // round-trip cost assumption, matches trading-strategy-research's convention

/**
 * Every tunable knob of the trade-construction and exit rule, in one place so
 * scripts/backtest-momentum-sweep.ts can grid-search them and so the live
 * recipe's own values (TECHNICAL_THRESHOLDS + lib/paper.ts) appear here as
 * defaults rather than as magic numbers scattered through simulateExit().
 *
 * Defaults reproduce the live recipe exactly — an unparameterized
 * runTechnicalBacktest() call is identical to the pre-parameterization engine.
 */
export interface MomentumParams extends ExitRule {
  /** Stop = entry − stopAtrMult × ATR(period), floored at the Donchian low. */
  stopAtrMult: number;
  /** Target = entry + targetRMultiple × (entry − stop). */
  targetRMultiple: number;
  /**
   * Documentation of the inherited ExitRule fields, kept here because this is
   * where the sweep script reads them:
   *
   * Scale-out ladder: sell `fraction` of the ORIGINAL position size each time
   * price reaches entry + r×R, then run whatever remains to its own exit.
   * Empty array = single all-out exit (v1's behaviour).
   *
   * WHY THIS EXISTS: with a single 3R target the recipe stops out ~75% of the
   * time, because a 3R target on a 2×ATR stop is a ~6×ATR move that Indian
   * large caps rarely deliver inside the time-exit window. Booking part of the
   * position at a level price actually reaches converts a large slice of those
   * round-trips from "stopped at breakeven, net −0.2%" into small net winners,
   * which is what a win rate is measuring — while a remaining runner keeps the
   * right-tail that the expectancy depends on.
   *
   * Must be sorted ascending by `r`, and the fractions must sum to ≤ 1;
   * runTechnicalBacktest() throws rather than silently mis-sizing a position.
   */
  /**
   * Entry filter: reject a breakout whose close sits more than this many ATRs
   * above its own 50-day SMA. An already-extended breakout has the least room
   * before mean reversion takes out a 2×ATR stop. Null disables.
   */
  maxAtrAboveSma50: number | null;
}

/**
 * The rule the paper account and the signal tracker actually trade, live since
 * 2026-08-31. Geometry comes from TECHNICAL_THRESHOLDS and management from
 * lib/exit-rules.ts's v2_scaleout, so this cannot drift from what
 * lib/paper.ts / lib/positions.ts execute.
 *
 * Measured against V1_MOMENTUM_PARAMS on the same universe and window
 * (468 vs 429 trades) — this comparison is why it was promoted:
 *
 *              win rate   median hold   maxDD    Sharpe   CAGR    PF     exp/trade
 *   v1           26.8%       14 bars     15.2%    0.32     9.5%   1.29    0.19R
 *   v2 (live)    50.4%       13 bars      9.8%    0.64    12.4%   1.44    0.23R
 *
 * WHY EACH KNOB MOVED, since a win rate is trivially gameable by shrinking the
 * target and the point was to improve the rule, not the statistic:
 *   - scaleOuts + breakevenAfterPartial do the actual work. Booking half at
 *     1.5R and then protecting the rest at entry converts the recipe's most
 *     common outcome — "ran up, gave it back, stopped for a small loss" — into
 *     a small net win, without capping the runner that expectancy lives on.
 *     This is also what pulls the FIRST profit forward to ~8.7 bars.
 *   - targetRMultiple 3 → 5 because the runner is now free: with half the
 *     position already banked, a nearer target only truncates the right tail.
 *   - breakeven@1R and trail@2R are OFF. Measured, both destroy edge here —
 *     they stop trades out at scratch on ordinary post-breakout noise, and the
 *     scale-out's own breakeven move already covers the same risk more cheaply.
 *   - stopAtrMult 2 → 1.75 and timeExitBars 60 → 25 shorten the horizon
 *     directly, which is what makes the median hold fall despite the higher
 *     target.
 *   - maxAtrAboveSma50 stays null: filtering out extended breakouts measured
 *     WORSE, not better. Extension is not a warning sign in this population.
 *
 * Robustness: the win-rate gain holds in every entry sub-period tested (full,
 * both halves, 2024, 2025, 2026) and expectancy improves in 4 of 5 — the
 * exception being a 30-trade 2025-only slice, where every variant is negative.
 *
 * The standing caveat is the fill assumption: the rung is credited at exactly
 * 1.5R with no slippage. That flatters v2 specifically, since v1 has no rung.
 */
export const LIVE_MOMENTUM_PARAMS: MomentumParams = {
  stopAtrMult: T.STOP_ATR_MULT,
  targetRMultiple: T.TARGET_R_MULTIPLE,
  ...EXIT_RULES.v2_scaleout,
  maxAtrAboveSma50: null,
};

/**
 * The rule that was live until 2026-08-31, kept as the backtest baseline and as
 * the rule still managing positions opened before that date (see
 * lib/exit-rules.ts). Its geometry is spelled out in literals rather than read
 * from TECHNICAL_THRESHOLDS — those now carry v2's 1.75/5, and a baseline that
 * silently tracks the current thresholds would make every live-vs-v1 comparison
 * meaningless.
 */
export const V1_MOMENTUM_PARAMS: MomentumParams = {
  stopAtrMult: V1_STOP_ATR_MULT,
  targetRMultiple: V1_TARGET_R_MULTIPLE,
  ...EXIT_RULES.v1_atr2_3r,
  maxAtrAboveSma50: null,
};

/** Which rule set a backtest run used. "live" is what the paper account trades
 *  today (v2, with the scale-out); "v1" is the superseded rule, kept selectable
 *  so the promotion can still be checked against its baseline. */
export type MomentumVariant = "live" | "v1";

export const MOMENTUM_VARIANTS: Record<MomentumVariant, MomentumParams> = {
  live: LIVE_MOMENTUM_PARAMS,
  v1: V1_MOMENTUM_PARAMS,
};

export function isMomentumVariant(v: unknown): v is MomentumVariant {
  return v === "live" || v === "v1";
}

/** Exported for tests (tests/backtest-exit.test.ts) — simulateExit() takes bars. */
export interface Bar {
  trade_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BacktestTrade {
  symbol: string;
  entry_date: string;
  entry_paise: number;
  exit_date: string;
  /** Exit price of the FINAL leg. When a partial exit fired, the trade's
   *  return_pct is the size-weighted blend of both legs and will not equal
   *  exit_paise / entry_paise − 1 — read return_pct, not the price ratio. */
  exit_paise: number;
  exit_reason: "stopped" | "target_hit" | "time_exit" | "data_end";
  bars_held: number;
  return_pct: number; // net of cost_bps_roundtrip, size-weighted across legs
  /** Entry-to-initial-stop distance as a % of entry — the trade's 1R. Lets
   *  return_pct be re-expressed in R units without re-deriving the stop. */
  risk_pct: number;
  /** Date the scale-out filled, when partial exits are enabled and it fired. */
  partial_exit_date?: string;
  /** Bars from entry to the scale-out — the horizon that actually books the
   *  first profit, which is shorter than bars_held whenever a partial fires. */
  partial_bars_held?: number;
}

/** Universe-membership mode actually used, so a reader can never mistake a
 *  survivorship-biased run for a point-in-time one. */
export type UniverseMode = "static_today" | "point_in_time";

/** Re-exported so API consumers and the panel can keep importing it from here. */
export type { BenchmarkComparison };

export interface BacktestSummary {
  universe_requested: number;
  /** Survivors of the fundamental quality gate, or the whole index when the
   *  gate was off — read alongside `quality_gate_applied`. */
  universe_quality_pass: number;
  /** False for the technical-only strategy: no fundamental filter was applied. */
  quality_gate_applied: boolean;
  universe_with_enough_history: number;
  universe_mode: UniverseMode;
  n_trades: number;
  n_symbols_traded: number;
  win_rate_pct: number | null;
  avg_return_pct: number | null;
  median_return_pct: number | null;
  profit_factor: number | null;
  avg_bars_held: number | null;
  median_bars_held: number | null;
  /** How many trades booked their scale-out leg, and how quickly. Null when
   *  partial exits are disabled. */
  n_partial_exits: number | null;
  avg_partial_bars_held: number | null;
  /** Expectancy per trade in R units — the scale-free "is this edge real"
   *  number that a win rate on its own cannot tell you. */
  expectancy_r: number | null;
  avg_win_pct: number | null;
  avg_loss_pct: number | null;
  /** The exact knob set this run used, so a result is never orphaned from its
   *  parameters. */
  params: MomentumParams;
  exit_reasons: Record<string, number>;
  usable_window_start: string | null; // first date any signal could fire, after warm-up
  last_bar_date: string | null;
  cost_bps_roundtrip: number;
  /** Notional position slots behind the equity curve's weighting rule. */
  equity_slots: number;
  starting_capital_rupees: number;
  /** Peak simultaneous holdings. Above equity_slots, positions were diluted to
   *  1/n rather than levered — see lib/equity-curve.ts. */
  max_concurrent_positions: number | null;
  /** Risk-adjusted metrics over the equity curve. Null when no trades fired. */
  metrics: EquityMetrics | null;
  benchmark: BenchmarkComparison | null;
  caveats: string[];
}

export interface BacktestResult {
  summary: BacktestSummary;
  trades: BacktestTrade[];
  /** Daily portfolio value in rupees. Kept out of `summary` so the summary
   *  stays small enough to log or embed; the panel charts this directly. */
  equity_curve: EquityPoint[];
  /** Benchmark normalized to the same starting capital, for overlay. */
  benchmark_curve: EquityPoint[];
  generated_at: string;
}

interface CandidateSignal {
  symbol: string;
  entry_idx: number;
  entry_date: string;
  entry_paise: number;
  stop_paise: number;
  target_paise: number;
  mom_score: number | null;
}

/** One-line summary of a rule set, for the caveats and the panel header. */
export function describeParams(p: MomentumParams): string {
  const parts = [
    `stop ${p.stopAtrMult}×ATR`,
    `target ${p.targetRMultiple}R`,
    p.scaleOuts.length > 0
      ? `scale out ${p.scaleOuts.map((s) => `${Math.round(s.fraction * 100)}% at ${s.r}R`).join(" + ")}${p.breakevenAfterPartial ? ", then stop to entry" : ""}`
      : "single all-out exit",
    p.breakevenRMultiple !== null ? `breakeven at ${p.breakevenRMultiple}R` : "no auto-breakeven",
    p.trailRMultiple !== null ? `trail ${p.trailLookback}-day low from ${p.trailRMultiple}R` : "no trailing stop",
    `${p.timeExitBars}-bar time exit`,
  ];
  if (p.maxAtrAboveSma50 !== null) parts.push(`skip breakouts >${p.maxAtrAboveSma50} ATR above SMA50`);
  return parts.join(", ");
}

/** Field-by-field rather than JSON.stringify, which would call two identical
 *  rule sets different purely because their keys were assigned in a different
 *  order. */
function sameParams(a: MomentumParams, b: MomentumParams): boolean {
  return (
    a.stopAtrMult === b.stopAtrMult &&
    a.targetRMultiple === b.targetRMultiple &&
    a.breakevenRMultiple === b.breakevenRMultiple &&
    a.trailRMultiple === b.trailRMultiple &&
    a.trailLookback === b.trailLookback &&
    a.timeExitBars === b.timeExitBars &&
    a.breakevenAfterPartial === b.breakevenAfterPartial &&
    a.maxAtrAboveSma50 === b.maxAtrAboveSma50 &&
    a.scaleOuts.length === b.scaleOuts.length &&
    a.scaleOuts.every((s, i) => s.r === b.scaleOuts[i].r && s.fraction === b.scaleOuts[i].fraction)
  );
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

export interface ExitOutcome {
  exitIdx: number;
  /** Final leg's exit price. */
  exitPaise: number;
  exitReason: BacktestTrade["exit_reason"];
  barsHeld: number;
  /** Size-weighted GROSS return fraction across all legs (before cost). */
  grossReturn: number;
  partialIdx: number | null;
  partialPaise: number | null;
}

/**
 * Simulate one trade's exit walking forward bar-by-bar from the entry bar,
 * applying the exit rule described by `p` (stop-first, then partial scale-out,
 * then target, then breakeven-move, trail, time-exit). `bars` must be the full
 * symbol series; entry executes at `entryIdx`'s own close (matches
 * lib/verdict.ts's `trade.entry_paise = lastClose` convention — i.e. same-bar
 * close, not next-bar open).
 *
 * INTRABAR ORDERING is deliberately pessimistic: a bar that touches both the
 * stop and a profit level is resolved as the stop, since daily bars carry no
 * intraday sequence. That means the partial scale-out is never credited on a
 * bar that also breaches the stop — a real fill might have been better, never
 * worse.
 *
 * Exported so tests/backtest-exit.test.ts can pin the intrabar ordering on
 * hand-built bars — the ordering is the part of this engine most likely to
 * flatter a result if it drifts, and it can't be checked from summary numbers.
 */
export function simulateExit(
  bars: Bar[],
  entryIdx: number,
  entryPaise: number,
  initialStopPaise: number,
  targetPaise: number,
  p: MomentumParams,
): ExitOutcome {
  let currentStop = initialStopPaise;
  const risk = entryPaise - initialStopPaise;
  const level = (r: number) => entryPaise + r * risk;

  // Remaining position size as a fraction of the original, plus the profit
  // already booked by filled rungs (expressed as size × that rung's return).
  let remaining = 1;
  let bookedReturn = 0;
  let partialIdx: number | null = null;
  let partialPaise: number | null = null;
  let nextRung = 0; // index into p.scaleOuts of the lowest unfilled rung

  const finish = (
    exitIdx: number,
    exitPaise: number,
    exitReason: BacktestTrade["exit_reason"],
    barsHeld: number,
  ): ExitOutcome => ({
    exitIdx,
    exitPaise,
    exitReason,
    barsHeld,
    grossReturn: bookedReturn + remaining * (exitPaise / entryPaise - 1),
    partialIdx,
    partialPaise,
  });

  for (let j = entryIdx + 1; j < bars.length; j++) {
    const b = bars[j];
    const barsHeld = j - entryIdx;
    if (b.low <= currentStop) return finish(j, currentStop, "stopped", barsHeld);

    // Scale-outs before the target check: the target sits above the top rung,
    // so a bar that clears both fills the rungs on the way through rather than
    // skipping them. Multiple rungs can fill on one bar.
    let filledARungThisBar = false;
    while (nextRung < p.scaleOuts.length && b.high >= level(p.scaleOuts[nextRung].r)) {
      const rung = p.scaleOuts[nextRung];
      const rungPrice = level(rung.r);
      bookedReturn += rung.fraction * (rungPrice / entryPaise - 1);
      remaining -= rung.fraction;
      if (partialIdx === null) {
        partialIdx = j;
        partialPaise = rungPrice;
      }
      nextRung++;
      filledARungThisBar = true;
    }
    if (filledARungThisBar && p.breakevenAfterPartial && currentStop < entryPaise) {
      currentStop = entryPaise;
      // Re-check the SAME bar against the raised stop. Without this, a bar that
      // ran up through a rung and then back below entry would bank the rung and
      // carry the remainder to the next bar for free — flattering the exact rule
      // that produces the win-rate gain. Charging the stop here is the
      // pessimistic reading of an ambiguous daily bar, which is the right way
      // round.
      if (b.low <= currentStop) return finish(j, currentStop, "stopped", barsHeld);
    }

    if (b.high >= targetPaise) return finish(j, targetPaise, "target_hit", barsHeld);

    if (p.breakevenRMultiple !== null && b.close >= level(p.breakevenRMultiple) && currentStop < entryPaise) {
      currentStop = entryPaise;
    }
    if (p.trailRMultiple !== null && b.close >= level(p.trailRMultiple)) {
      const trail = donchianLow(bars.slice(0, j + 1).map((x) => x.low), p.trailLookback);
      if (trail !== null && trail > currentStop) currentStop = trail;
    }
    if (barsHeld >= p.timeExitBars) return finish(j, b.close, "time_exit", barsHeld);
  }
  const lastIdx = bars.length - 1;
  return finish(lastIdx, bars[lastIdx].close, "data_end", lastIdx - entryIdx);
}

/** Every candidate day this symbol's technical rules fire, ignoring the daily
 * cross-universe cap and any "already in a trade" state — those are resolved
 * in the global chronological pass in runTechnicalBacktest(). */
function findCandidateSignals(symbol: string, bars: Bar[], p: MomentumParams): CandidateSignal[] {
  const useYZ = process.env.VOL_ESTIMATOR === "yang_zhang";
  const out: CandidateSignal[] = [];
  for (let i = TREND_LOOKBACK - 1; i < bars.length; i++) {
    // Bound to a 200-bar tail for the SMA/breakout checks (their result only
    // depends on the last n elements) — full history is only needed for ATR,
    // which uses cumulative Wilder smoothing from the dataset's start, matching
    // how lib/verdict.ts calls atr() on the entire cached series every time.
    const window = bars.slice(Math.max(0, i - TREND_LOOKBACK + 1), i + 1);
    const closesWindow = window.map((b) => b.close);
    const sma50 = sma(closesWindow, 50);
    const sma200 = sma(closesWindow, 200);
    if (sma50 === null || sma200 === null) continue;
    const lastClose = closesWindow[closesWindow.length - 1];
    const trendOk = lastClose > sma200 && sma50 > sma200;
    if (!trendOk) continue;

    const breakoutOk = isDonchianBreakout(closesWindow, T.DONCHIAN_LOOKBACK) === true;
    if (!breakoutOk) continue;

    // Volume: prior 20 bars excluding today — historical bars are always
    // full-day bhavcopy volume, so no intraday extrapolation is needed here
    // (unlike the live scanner's same-day check).
    const priorVolumes = bars.slice(Math.max(0, i - 20), i).map((b) => b.volume);
    const avgVol20 = avgVolume(priorVolumes, 20);
    const lastVol = bars[i].volume;
    if (avgVol20 === null || avgVol20 <= 0 || lastVol / avgVol20 < T.VOL_SURGE_MIN) continue;

    const fullHistory = bars.slice(0, i + 1);
    const atr14 = atr(fullHistory, T.ATR_PERIOD);
    const lowsWindow = window.map((b) => b.low);
    const dLow20 = donchianLow(lowsWindow, T.DONCHIAN_LOOKBACK);
    if (atr14 === null || dLow20 === null) continue;

    // Extension filter: how far the breakout close already sits above its own
    // 50-day mean, in ATRs. Scale-free, so it compares across price levels and
    // volatility regimes.
    if (p.maxAtrAboveSma50 !== null && (lastClose - sma50) / atr14 > p.maxAtrAboveSma50) continue;

    const stopFromAtr = Math.round(lastClose - p.stopAtrMult * atr14);
    const stop = Math.max(stopFromAtr, dLow20);
    if (stop >= lastClose) continue;
    const risk = lastClose - stop;
    const target = Math.round(lastClose + p.targetRMultiple * risk);

    const closesFull = fullHistory.map((b) => b.close);
    const mom =
      closesFull.length > T.MOMENTUM_LOOKBACK
        ? useYZ
          ? volAdjMomentumYZ(fullHistory, T.MOMENTUM_LOOKBACK, T.MOMENTUM_SKIP)
          : volAdjMomentum(closesFull, T.MOMENTUM_LOOKBACK, T.MOMENTUM_SKIP)
        : null;

    out.push({
      symbol,
      entry_idx: i,
      entry_date: bars[i].trade_date,
      entry_paise: lastClose,
      stop_paise: stop,
      target_paise: target,
      mom_score: mom,
    });
  }
  return out;
}

/**
 * A strategy's knobs, plus the evaluation-window controls. The window is NOT
 * part of MomentumParams on purpose: `entryFrom`/`entryTo` describe which slice
 * of history you are measuring over, not how the strategy behaves, and mixing
 * the two would let a sub-period get baked into a "tuned parameter set".
 */
export interface BacktestOptions extends Partial<MomentumParams> {
  /**
   * Apply today's fundamental quality gate as a static universe pre-filter
   * (default true — the shipped recipe). Set false for the technical-only
   * variant: same trend/breakout/volume/momentum rules over the whole NIFTY
   * 500, with nothing asked of the balance sheet.
   *
   * This is the ONE filter worth being able to switch off in isolation. The
   * gate is also the engine's weakest link — it is today's fundamentals applied
   * backward, so it is the source of most of the survivorship-flavoured bias in
   * any result here. Running without it is therefore both a different strategy
   * and a check on how much of the gated strategy's edge was the gate versus
   * the price action.
   */
  qualityGate?: boolean;
  /** Earliest date that may OPEN a trade (inclusive). */
  entryFrom?: string;
  /** Latest date that may OPEN a trade (inclusive). Trades opened on or before
   *  it still run forward to their own exit — truncating exits at the window
   *  edge would bias the result toward whatever was working at that moment. */
  entryTo?: string;
  /**
   * Notional position slots behind the equity curve's weighting rule (default
   * DEFAULT_EQUITY_SLOTS = 20). This does NOT cap concurrency — no trade is ever
   * dropped, so the trade-level statistics are identical whatever you pass; only
   * the portfolio-level ones (drawdown, Sharpe, volatility) move. Exposed so the
   * live account's concurrency (DEFAULT_SIZING.maxConcurrentTrades) can be
   * measured against the default, since a more concentrated book draws down
   * harder on exactly the same trades.
   */
  slots?: number;
}

export async function runTechnicalBacktest(
  userId = "local",
  opts: BacktestOptions = {},
): Promise<BacktestResult> {
  void userId; // reserved for a future per-user universe/account tie-in; unused today
  const { entryFrom, entryTo, qualityGate = true, slots, ...params } = opts;
  const p: MomentumParams = { ...LIVE_MOMENTUM_PARAMS, ...params };

  // Fail loudly on a malformed ladder. A silently over-sized ladder (fractions
  // summing past 1) would show up as a fictional short position on the runner
  // and quietly invent returns, which is far worse than a thrown error.
  const totalScaledOut = p.scaleOuts.reduce((a, s) => a + s.fraction, 0);
  if (totalScaledOut > 1 + 1e-9) {
    throw new Error(`scaleOuts fractions sum to ${totalScaledOut}, which exceeds the position (max 1)`);
  }
  if (p.scaleOuts.some((s, i) => i > 0 && s.r <= p.scaleOuts[i - 1].r)) {
    throw new Error("scaleOuts must be sorted strictly ascending by r");
  }
  if (p.scaleOuts.some((s) => s.fraction <= 0 || s.r <= 0)) {
    throw new Error("every scaleOuts rung needs r > 0 and fraction > 0");
  }
  if (p.scaleOuts.some((s) => s.r >= p.targetRMultiple)) {
    throw new Error(
      `every scaleOuts rung must sit below targetRMultiple (${p.targetRMultiple}) — a rung at or above the target can never fill separately`,
    );
  }

  const db = getDb();
  const caveats: string[] = [
    qualityGate
      ? "Technical rules only — today's fundamentals quality-gate pass/fail is applied as a static pre-filter, not point-in-time (this app has almost no historical fundamentals snapshots)."
      : "No fundamental filter at all: every NIFTY 500 name with enough price history is eligible, whatever its balance sheet. Nothing here is asked of quality, so the result is the price action's edge on its own — and it will happily trade companies the quality-gated strategy refuses.",
    `Does not simulate the live paper account's ${DEFAULT_SIZING.maxConcurrentTrades}-position concurrency cap, momentum-based rotation eviction, or risk-based capital sizing (${DEFAULT_SIZING.riskPctPerTrade}% of equity per trade, ${DEFAULT_SIZING.maxPositionPct}% capital cap) — this measures the technical recipe's raw trade-level edge only.`,
    `Entry executes at the signal bar's own close (not the next bar's open), matching the live recipe's convention — this is a mild look-ahead relative to a stricter backtest, inherited from lib/verdict.ts, not introduced here.`,
  ];

  // A v1 run and a live run are otherwise indistinguishable on the page, so say
  // which one produced these numbers rather than leaving the reader to compare
  // parameter dumps.
  if (!sameParams(p, LIVE_MOMENTUM_PARAMS)) {
    caveats.push(
      `Exit rule under test is NOT the current live rule. This run used: ${describeParams(p)}. New entries are opened on ${describeParams(LIVE_MOMENTUM_PARAMS)}, so this is a historical baseline — useful for comparison, not a description of what the account is doing now.`,
    );
  } else {
    caveats.push(
      `Exit rule under test is the current live rule (${describeParams(LIVE_MOMENTUM_PARAMS)}). Positions opened before 2026-08-31 are still managed on the superseded v1 rule, so the paper account's own closed-trade stats blend both rules for a while yet — pick the "v1 rule" variant to see that baseline.`,
    );
  }
  if (p.scaleOuts.length > 0) {
    caveats.push(
      "Partial exits assume the scale-out leg fills exactly at its rung price with no extra slippage beyond the round-trip cost, and that a half position is tradeable in the sized quantity — plausible for NIFTY 500 large caps, optimistic for the thinner names.",
    );
  }

  const universeRows = db
    .prepare(
      `SELECT symbol, exchange, isin, sector, instrument_token
       FROM index_universe WHERE index_name = 'NIFTY 500'`,
    )
    .all() as { symbol: string; exchange: string; isin: string; sector: string | null; instrument_token: number }[];

  // Static quality-gate pre-filter, reusing lib/verdict.ts's exact threshold
  // logic (evaluate()'s quality array) rather than re-deriving it. With the gate
  // off, every index member passes through — including names with no
  // fundamentals row at all, which the gated path drops silently.
  const qualityPass: typeof universeRows = [];
  for (const row of universeRows) {
    if (!qualityGate) {
      qualityPass.push(row);
      continue;
    }
    const fundamentals = loadCoalescedFundamentals(db, row.isin);
    if (!fundamentals) continue;
    const v = evaluate({
      symbol: row.symbol,
      exchange: row.exchange,
      isin: row.isin,
      sector: row.sector,
      fundamentals,
      ohlc: [],
    });
    if (v.quality.length > 0 && v.quality.every((c) => c.ok)) qualityPass.push(row);
  }

  // Load full OHLC per qualifying symbol; keep only those with enough history
  // to ever produce a signal (TREND_LOOKBACK bars).
  const barsBySymbol = new Map<string, Bar[]>();
  for (const row of qualityPass) {
    const bars = db
      .prepare(
        `SELECT trade_date, open, high, low, close, volume FROM ohlc_daily
         WHERE instrument_token = ? ORDER BY trade_date ASC`,
      )
      .all(row.instrument_token) as Bar[];
    if (bars.length >= TREND_LOOKBACK) barsBySymbol.set(row.symbol, bars);
  }

  if (barsBySymbol.size === 0) {
    return {
      summary: {
        universe_requested: universeRows.length,
        universe_quality_pass: qualityPass.length,
        quality_gate_applied: qualityGate,
        universe_with_enough_history: 0,
        universe_mode: "static_today",
        n_trades: 0,
        n_symbols_traded: 0,
        win_rate_pct: null,
        avg_return_pct: null,
        median_return_pct: null,
        profit_factor: null,
        avg_bars_held: null,
        median_bars_held: null,
        n_partial_exits: null,
        avg_partial_bars_held: null,
        expectancy_r: null,
        avg_win_pct: null,
        avg_loss_pct: null,
        params: p,
        exit_reasons: {},
        usable_window_start: null,
        last_bar_date: null,
        cost_bps_roundtrip: DEFAULT_COST_BPS_ROUNDTRIP,
        equity_slots: DEFAULT_EQUITY_SLOTS,
        starting_capital_rupees: DEFAULT_STARTING_RUPEES,
        max_concurrent_positions: null,
        metrics: null,
        benchmark: null,
        caveats: [
          ...caveats,
          qualityGate
            ? "No symbol had enough price history or passed today's quality gate — nothing to backtest."
            : "No symbol had enough price history — nothing to backtest.",
        ],
      },
      trades: [],
      equity_curve: [],
      benchmark_curve: [],
      generated_at: new Date().toISOString(),
    };
  }

  // The portfolio's time axis: every date any loaded symbol traded, plus each
  // date's cross-section of closes (used by the regime gate below).
  const closesByDate = new Map<string, { symbol: string; close: number }[]>();
  for (const [symbol, bars] of barsBySymbol) {
    for (const b of bars) {
      const arr = closesByDate.get(b.trade_date);
      if (arr) arr.push({ symbol, close: b.close });
      else closesByDate.set(b.trade_date, [{ symbol, close: b.close }]);
    }
  }
  const sortedDates = [...closesByDate.keys()].sort();

  // First date a signal could fire: the 200-day trend/regime checks need
  // TREND_LOOKBACK bars of warm-up first.
  const usableWindowStart =
    sortedDates.length >= TREND_LOOKBACK ? sortedDates[TREND_LOOKBACK - 1] : null;

  // Point-in-time universe, IF the snapshots reach back far enough. Applying
  // today's membership to a date the snapshots don't cover would silently
  // reintroduce the very survivorship bias the snapshots exist to remove, so
  // partial coverage falls back to static rather than mixing the two.
  const timeline = loadUniverseTimeline(db);
  const pitUsable =
    timeline.first_date !== null &&
    usableWindowStart !== null &&
    timeline.first_date <= usableWindowStart;
  const universeMode: UniverseMode = pitUsable ? "point_in_time" : "static_today";

  if (pitUsable) {
    caveats.push(
      `Universe membership is POINT-IN-TIME: a symbol is only tradeable on dates when the universe_snapshot table shows it in the scanner universe (${timeline.dates.length} snapshots from ${timeline.first_date} to ${timeline.last_date}).`,
    );
  } else {
    caveats.push(
      timeline.first_date === null
        ? "Universe membership is TODAY'S NIFTY 500 applied backward — the universe_snapshot table is empty, so delisted and demoted names are missing entirely. This is survivorship bias and it inflates results; it resolves itself once snapshots accumulate (scripts/cron/snapshot-universe.sh)."
        : `Universe membership is TODAY'S NIFTY 500 applied backward — universe_snapshot only reaches back to ${timeline.first_date}, after this backtest's usable window starts (${usableWindowStart}). Point-in-time membership switches on automatically once snapshots cover the window.`,
    );
  }

  /** Symbols tradeable on `date` under the resolved mode. Null = no restriction. */
  const eligibleOn = (date: string): Set<string> | null =>
    pitUsable ? eligibleSymbolsAsOf(timeline, date) : null;

  // Market-regime gate: median close across the universe as it stood on each
  // date, vs that median series' own 200-day SMA.
  const medianSeries = sortedDates.map((d) => {
    const cross = closesByDate.get(d)!;
    const eligible = eligibleOn(d);
    // A median over a handful of names is noise, so fall back to the full
    // cross-section rather than let a thin snapshot distort the regime call.
    const filtered = eligible ? cross.filter((c) => eligible.has(c.symbol)) : cross;
    return median((filtered.length >= 20 ? filtered : cross).map((c) => c.close));
  });
  const regimeBullByDate = new Map<string, boolean>();
  for (let i = 0; i < sortedDates.length; i++) {
    const window = medianSeries.slice(Math.max(0, i - TREND_LOOKBACK + 1), i + 1);
    const s200 = sma(window, TREND_LOOKBACK);
    regimeBullByDate.set(sortedDates[i], s200 !== null && medianSeries[i] > s200);
  }

  // Per-symbol candidate signals, independent of daily cap / concurrency.
  const candidatesBySymbol = new Map<string, CandidateSignal[]>();
  for (const [symbol, bars] of barsBySymbol) {
    candidatesBySymbol.set(symbol, findCandidateSignals(symbol, bars, p));
  }

  // Global chronological pass: apply the regime gate, the daily MAX_SIGNALS_PER_DAY
  // cap (ranked by momentum, nulls last), and the one-open-trade-per-symbol rule.
  const candidatesByDate = new Map<string, CandidateSignal[]>();
  for (const list of candidatesBySymbol.values()) {
    for (const c of list) {
      const arr = candidatesByDate.get(c.entry_date);
      if (arr) arr.push(c);
      else candidatesByDate.set(c.entry_date, [c]);
    }
  }
  const busyUntilIdx = new Map<string, number>(); // symbol -> bar index the symbol is busy through (inclusive)
  const trades: BacktestTrade[] = [];
  // Parallel to `trades`, but with a partial'd trade's two legs collapsed into
  // one synthetic liquidation price whose ratio to entry equals the trade's
  // size-weighted gross return. That keeps the equity curve reproducing the
  // same net return the trade table reports (see the CAVEAT emitted below for
  // what it costs in mark-to-market fidelity between the two legs).
  const curveTrades: { symbol: string; entry_date: string; exit_date: string; exit_paise: number }[] = [];
  const costFrac = DEFAULT_COST_BPS_ROUNDTRIP / 10_000;

  for (const date of sortedDates) {
    if (entryFrom && date < entryFrom) continue;
    if (entryTo && date > entryTo) continue;
    if (!regimeBullByDate.get(date)) continue;
    const eligible = eligibleOn(date);
    const dayCandidates = (candidatesByDate.get(date) ?? []).filter((c) => {
      // Point-in-time gate applies to ENTRIES only. An existing position is
      // managed to its own exit rule even if the symbol leaves the index —
      // that's what a real book would do, and forcing an index-exit sale would
      // invent an exit reason the strategy doesn't have.
      if (eligible && !eligible.has(c.symbol)) return false;
      const busy = busyUntilIdx.get(c.symbol);
      return busy === undefined || c.entry_idx > busy;
    });
    if (dayCandidates.length === 0) continue;
    dayCandidates.sort((a, b) => (b.mom_score ?? -Infinity) - (a.mom_score ?? -Infinity));
    const chosen = dayCandidates.slice(0, MAX_SIGNALS_PER_DAY);
    for (const c of chosen) {
      const bars = barsBySymbol.get(c.symbol)!;
      const exit = simulateExit(bars, c.entry_idx, c.entry_paise, c.stop_paise, c.target_paise, p);
      // Cost is charged on the full round trip regardless of how many legs the
      // exit took — a scale-out plus a final sale is two sell tickets, so if
      // anything this understates cost slightly rather than overstating it.
      const netReturn = (1 + exit.grossReturn) * (1 - costFrac) - 1;
      trades.push({
        symbol: c.symbol,
        entry_date: c.entry_date,
        entry_paise: c.entry_paise,
        exit_date: bars[exit.exitIdx].trade_date,
        exit_paise: exit.exitPaise,
        exit_reason: exit.exitReason,
        bars_held: exit.barsHeld,
        return_pct: netReturn * 100,
        risk_pct: ((c.entry_paise - c.stop_paise) / c.entry_paise) * 100,
        ...(exit.partialIdx !== null
          ? {
              partial_exit_date: bars[exit.partialIdx].trade_date,
              partial_bars_held: exit.partialIdx - c.entry_idx,
            }
          : {}),
      });
      curveTrades.push({
        symbol: c.symbol,
        entry_date: c.entry_date,
        exit_date: bars[exit.exitIdx].trade_date,
        exit_paise: c.entry_paise * (1 + exit.grossReturn),
      });
      busyUntilIdx.set(c.symbol, exit.exitIdx);
    }
  }

  const scored = trades.filter((t) => t.exit_reason !== "data_end");
  const returns = scored.map((t) => t.return_pct);
  const wins = returns.filter((r) => r > 0);
  const losses = returns.filter((r) => r <= 0);
  const exitReasons: Record<string, number> = {};
  for (const t of trades) exitReasons[t.exit_reason] = (exitReasons[t.exit_reason] ?? 0) + 1;
  // R-multiples: each trade's net return divided by its OWN 1R, so a wide-stop
  // trade and a tight-stop one are commensurable.
  const rMultiples = scored.filter((t) => t.risk_pct > 0).map((t) => t.return_pct / t.risk_pct);
  const partialBars = scored.filter((t) => t.partial_bars_held !== undefined).map((t) => t.partial_bars_held!);
  const partialsEnabled = p.scaleOuts.length > 0;

  if (entryFrom || entryTo) {
    caveats.push(
      `ENTRY WINDOW RESTRICTED to ${entryFrom ?? "start"}..${entryTo ?? "end"} — trades opened inside it still run forward to their own exit, so the sample is a sub-period of entries, not a truncated set of trades.`,
    );
  }

  if (usableWindowStart) {
    caveats.push(
      `Signals can only fire after a ${TREND_LOOKBACK}-trading-day warm-up (for the 200-day trend/regime checks) — the usable window starts ${usableWindowStart}, not the full price-history start date. Treat this as a short-sample signal-fidelity check, not a long-run track record.`,
    );
  }

  // ---- Portfolio equity curve, metrics and benchmark -----------------------
  // Built from ALL trades including data_end ones: capital really was deployed
  // in those positions, so excluding them would understate both exposure and
  // drawdown. Their final mark is the last close treated as a liquidation, so
  // they carry the full round-trip cost slightly early.
  const curve = buildEquityCurve({
    trades: curveTrades,
    barsBySymbol,
    tradingDates: sortedDates,
    costBpsRoundtrip: DEFAULT_COST_BPS_ROUNDTRIP,
    slots,
  });

  let metrics: EquityMetrics | null = null;
  let benchmark: BenchmarkComparison | null = null;
  let benchmarkCurve: EquityPoint[] = [];

  if (curve && curve.curve.length >= 2) {
    metrics = computeEquityMetrics(toSeries(curve.curve), {
      periodsInMarket: curve.periods_in_market,
    });

    const bench = compareToBenchmark(db, curve.curve);
    if (bench) {
      benchmark = bench.comparison;
      benchmarkCurve = bench.points;
    }

    caveats.push(
      `Equity curve weights each open position at 1/max(open, ${curve.slots}) of ₹${curve.starting_rupees.toLocaleString("en-IN")} — never levered, and diluted to 1/n above ${curve.slots} concurrent holdings (peak here: ${curve.max_concurrent_positions}). No trade is dropped, so the curve and the trade table describe the same population.`,
      "Idle cash in the equity curve earns 0%, not the risk-free rate — an under-deployed strategy is penalized versus a real account earning liquid-fund interest on its cash leg.",
      `Sharpe, Sortino and alpha are computed against a ${DEFAULT_RISK_FREE_RATE_PCT}% annual risk-free rate and annualized at 252 trading days.`,
    );
    if (partialsEnabled) {
      caveats.push(
        `Scale-out approximation in the EQUITY CURVE only: a partial'd trade is marked at full size until its final exit, then liquidated at one synthetic blended price. Its net return matches the trade table exactly, but the day-to-day marks between the scale-out and the final exit carry more size than the book really held — so curve volatility and drawdown are, if anything, slightly overstated for the ${partialBars.length} trades that scaled out.`,
      );
    }
    if (curve.unmarked_position_days > 0) {
      caveats.push(
        `${curve.unmarked_position_days} position-days had no bar for the held symbol (exchange gap or missing backfill) and were carried unmarked rather than assigned an invented return.`,
      );
    }
    if (benchmark) {
      caveats.push(benchmarkCaveat(benchmark));
    } else {
      caveats.push("No benchmark series available for this window — relative return, alpha and beta are omitted rather than estimated.");
    }
  }

  return {
    summary: {
      universe_requested: universeRows.length,
      universe_quality_pass: qualityPass.length,
      quality_gate_applied: qualityGate,
      universe_with_enough_history: barsBySymbol.size,
      universe_mode: universeMode,
      n_trades: scored.length,
      n_symbols_traded: new Set(scored.map((t) => t.symbol)).size,
      win_rate_pct: scored.length > 0 ? (wins.length / scored.length) * 100 : null,
      avg_return_pct: returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : null,
      median_return_pct: returns.length > 0 ? median(returns) : null,
      profit_factor:
        losses.length > 0 && losses.reduce((a, b) => a + b, 0) < 0
          ? wins.reduce((a, b) => a + b, 0) / -losses.reduce((a, b) => a + b, 0)
          : wins.length > 0
            ? Infinity
            : null,
      avg_bars_held: scored.length > 0 ? scored.reduce((a, t) => a + t.bars_held, 0) / scored.length : null,
      median_bars_held: scored.length > 0 ? median(scored.map((t) => t.bars_held)) : null,
      n_partial_exits: partialsEnabled ? partialBars.length : null,
      avg_partial_bars_held:
        partialBars.length > 0 ? partialBars.reduce((a, b) => a + b, 0) / partialBars.length : null,
      expectancy_r: rMultiples.length > 0 ? rMultiples.reduce((a, b) => a + b, 0) / rMultiples.length : null,
      avg_win_pct: wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : null,
      avg_loss_pct: losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / losses.length : null,
      params: p,
      exit_reasons: exitReasons,
      usable_window_start: usableWindowStart,
      last_bar_date: sortedDates[sortedDates.length - 1] ?? null,
      cost_bps_roundtrip: DEFAULT_COST_BPS_ROUNDTRIP,
      equity_slots: curve?.slots ?? DEFAULT_EQUITY_SLOTS,
      starting_capital_rupees: curve?.starting_rupees ?? DEFAULT_STARTING_RUPEES,
      max_concurrent_positions: curve?.max_concurrent_positions ?? null,
      metrics,
      benchmark,
      caveats,
    },
    trades: trades.slice(0, 500),
    equity_curve: curve?.curve ?? [],
    benchmark_curve: benchmarkCurve,
    generated_at: new Date().toISOString(),
  };
}

