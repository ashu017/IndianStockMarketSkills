import "server-only";
import { getDb } from "./db/connection";
import { QUALITY_THRESHOLDS, TECHNICAL_THRESHOLDS } from "./verdict";
import { LIVE_MOMENTUM_PARAMS, V1_MOMENTUM_PARAMS } from "./backtest";
import { accountAgeCagrPct } from "./metrics";
import {
  loadActivePaperTrades,
  loadClosedPaperTrades,
  summarize,
  getAccount,
  DEFAULT_SIZING,
  type ClosedTrade,
  type OpenTradeWithMark,
  type PaperSummary,
} from "./paper";

/**
 * Registry of strategies that can appear on the /strategies page. Each entry
 * describes a strategy conceptually; `live` marks whether it's actually
 * running as real paper trades (queryable via paper_trades.strategy) versus
 * only existing as a backtest in the separate trading-strategy-research
 * project. Adding a second live strategy later means: (1) tag its scanner's
 * openPaperTrade() calls with a new `strategy` key here, (2) add a registry
 * entry with live=true — no page/schema rework needed.
 *
 * `rules` (when present) drives the detailed overview section on the
 * strategy detail page — one bullet list per stage of the pipeline. Numbers
 * are pulled from the actual threshold constants (lib/verdict.ts,
 * lib/exit-rules.ts, and lib/backtest.ts's LIVE/V1_MOMENTUM_PARAMS) rather than
 * hardcoded here, so this page can't silently go stale if a threshold is tuned. Scanner-only knobs that live as env vars in
 * scripts/scan-nifty100-signals.ts (MOM_TOPN, MAX_SIGNALS, INDEX_NAME) are
 * hardcoded to their documented defaults since they aren't exported
 * constants — see that script's header comment if you change them.
 */
export interface StrategyRuleGroup {
  title: string;
  items: string[];
}

export interface StrategyDefinition {
  id: string;
  name: string;
  description: string;
  live: boolean;
  source?: string; // where the backtest lives, for non-live entries
  rules?: StrategyRuleGroup[];
  // Marks a strategy whose detail page is an on-demand backtest/analysis tool
  // rather than either a live paper-traded strategy or an inert "see the
  // separate research project" placeholder.
  // "overnight_close_to_open": user picks a symbol, we run it fresh — see
  //   components/portfolio/OvernightBacktestPanel.tsx.
  // "bulk_deal_institutional_holds": no symbol input — analyzes the whole
  //   bulk_deals table each run — see components/portfolio/BulkDealHoldsPanel.tsx.
  // "momentum_technical_only": runs lib/backtest.ts with the fundamental quality
  //   gate switched off — see components/portfolio/BacktestPanel.tsx (the same
  //   panel the live strategy uses, since it's the same engine).
  interactiveBacktestKind?:
    | "overnight_close_to_open"
    | "bulk_deal_institutional_holds"
    | "momentum_technical_only";
}

const Q = QUALITY_THRESHOLDS;
const T = TECHNICAL_THRESHOLDS;
const LIVE = LIVE_MOMENTUM_PARAMS;
// The frozen pre-2026-08-31 rule. Still described on the page because positions
// opened before the promotion are still managed on it — see lib/exit-rules.ts.
const V1 = V1_MOMENTUM_PARAMS;
// Sizing knobs. STRATEGIES is a static array, so this describes the SEEDED
// defaults rather than the live paper_account row. They agree today; if you ever
// retune one account's sizing without changing DEFAULT_SIZING, this prose goes
// stale — same caveat as the scanner env vars noted in the header.
const SIZE = DEFAULT_SIZING;
const pctAt = (outs: { r: number; fraction: number }[], joiner: string) =>
  outs.map((s) => `${Math.round(s.fraction * 100)}% at ${s.r}R`).join(joiner);

export const STRATEGIES: StrategyDefinition[] = [
  {
    id: "quality_trend_momentum_breakout",
    name: "Quality + Trend + Momentum + Breakout",
    description:
      "Fundamental quality gate plus a technical trend+breakout filter, ranked by vol-adjusted 12-1 momentum. The only strategy currently trading live paper positions.",
    live: true,
    rules: [
      {
        title: "1. Fundamental quality gate — all 6 must pass",
        items: [
          `ROCE (3y avg) ≥ ${Q.ROCE_MIN}%`,
          `ROE (3y avg) ≥ ${Q.ROE_MIN}%`,
          `Debt / Equity ≤ ${Q.DE_MAX} (exempt for banks/NBFCs — deposits ≠ debt)`,
          `Sales growth (3y) ≥ ${Q.SALES_GROWTH_3Y_MIN}% (exempt for financials — interest income ≠ sales)`,
          `Profit growth (3y) ≥ ${Q.PROFIT_GROWTH_3Y_MIN}%`,
          `Promoter holding ≥ ${Q.PROMOTER_HOLDING_MIN}%`,
        ],
      },
      {
        title: "2. Trend filter — both must pass",
        items: [
          "Close price > 200-day moving average",
          "50-day moving average > 200-day moving average (Golden Cross)",
        ],
      },
      {
        title: "3. Entry trigger — both must fire on the same day",
        items: [
          `Fresh ${T.DONCHIAN_LOOKBACK}-day closing high (Donchian breakout)`,
          `Volume ≥ ${T.VOL_SURGE_MIN}× the 20-day average (time-aware: extrapolated from partial-day volume during market hours, deferred before 10:00 IST)`,
        ],
      },
      {
        title: "4. Ranking — when more setups fire than slots available",
        items: [
          `Survivors ranked by volatility-adjusted 12-month momentum, skipping the most recent month (Carhart convention: ${T.MOMENTUM_LOOKBACK}-day lookback, ${T.MOMENTUM_SKIP}-day skip)`,
          "Only the top 30 by momentum are kept as eligible candidates each scan",
          "Up to 5 new BUY signals emitted per scan, highest momentum first",
          "Market regime gate: signals are only emitted when the median close across the scan universe is above its own 200-day moving average — no new entries in a detected bear regime",
        ],
      },
      {
        title: "5. Trade construction, once triggered",
        items: [
          `Stop-loss = entry − ${T.STOP_ATR_MULT}×ATR(${T.ATR_PERIOD}), or the ${T.DONCHIAN_LOOKBACK}-day low if that's tighter`,
          `Target = entry + ${T.TARGET_R_MULTIPLE}× the entry-to-stop risk (${T.TARGET_R_MULTIPLE}R)`,
          `Position sized to risk ${SIZE.riskPctPerTrade}% of account equity per trade, capped at ${SIZE.maxPositionPct}% of equity in any single position — the risk figure sets the size unless the stop is closer than ${(SIZE.riskPctPerTrade / SIZE.maxPositionPct * 100).toFixed(0)}% of price, where the capital cap takes over`,
        ],
      },
      {
        title: "6. Position management",
        items: [
          `Book ${LIVE.scaleOuts.map((s) => `${Math.round(s.fraction * 100)}% of the position at ${s.r}R`).join(" and ")}, then move the stop to entry and let the rest run to the ${LIVE.targetRMultiple}R target`,
          "No automatic breakeven move at 1R and no trailing stop — both measured as edge-destroying on this signal, stopping trades out at scratch on ordinary post-breakout noise",
          `Time-exit whatever remains if neither stop nor target hit within ${LIVE.timeExitBars} trading days`,
          `Max ${SIZE.maxConcurrentTrades} concurrent positions, so a full book risks ${(SIZE.maxConcurrentTrades * SIZE.riskPctPerTrade).toFixed(1)}% of equity in aggregate — a new signal can evict the weakest-momentum incumbent (held ≥5 bars, not yet at breakeven) if it outranks it`,
        ],
      },
      {
        title: "7. Why this exit rule, and what the older positions are doing",
        items: [
          `Rules 5 and 6 replaced the original rule on 2026-08-31. That rule was: stop ${V1.stopAtrMult}×ATR(${T.ATR_PERIOD}), target ${V1.targetRMultiple}R, breakeven at ${V1.breakevenRMultiple}R, trail the ${V1.trailLookback}-day low from ${V1.trailRMultiple}R, ${V1.timeExitBars}-day time exit, no partial booking`,
          `Measured on the same universe and window, old → new: win rate 26.8% → 50.4%, median hold 14 → 13 days, first profit booked at ~9 days, max drawdown 15.2% → 9.8%, Sharpe 0.32 → 0.64, expectancy 0.19R → 0.23R`,
          "Positions opened before the switch are grandfathered — each trade is stamped with the rule it was opened under and runs to completion on it, so no live position was re-planned. Only new entries use rules 5 and 6",
          "Closed-trade statistics on this page therefore blend both rules until the last grandfathered position closes",
          `Pick “Old rule (pre-2026-08-31)” in the backtest panel below to re-run the baseline for yourself`,
        ],
      },
    ],
  },
  {
    id: "trend_momentum_breakout_technical",
    name: "Trend + Momentum + Breakout (No Fundamentals)",
    description:
      "The same price rules as the strategy above — trend, breakout, volume surge, momentum ranking — run across the whole NIFTY 500 with no fundamental filter of any kind. Built as the controlled comparison: identical technicals, quality gate removed, so the difference is attributable to the gate. Not a live strategy; an on-demand backtest.",
    live: false,
    interactiveBacktestKind: "momentum_technical_only",
    rules: [
      {
        title: "1. Universe — no fundamental filter",
        items: [
          "Every NIFTY 500 member with at least 200 trading days of cached history is eligible",
          "No ROCE, ROE, debt, growth or promoter-holding requirement — nothing is asked of the balance sheet",
          "Names with no fundamentals data at all are included here, where the quality-gated strategy drops them",
        ],
      },
      {
        title: "2. Trend filter — both must pass",
        items: [
          "Close price > 200-day moving average",
          "50-day moving average > 200-day moving average (Golden Cross)",
        ],
      },
      {
        title: "3. Entry trigger — both must fire on the same day",
        items: [
          `Fresh ${T.DONCHIAN_LOOKBACK}-day closing high (Donchian breakout)`,
          `Volume ≥ ${T.VOL_SURGE_MIN}× the 20-day average`,
        ],
      },
      {
        title: "4. Ranking and gating",
        items: [
          `Survivors ranked by volatility-adjusted 12-month momentum, skipping the most recent month (${T.MOMENTUM_LOOKBACK}-day lookback, ${T.MOMENTUM_SKIP}-day skip)`,
          "Up to 5 new entries per day, highest momentum first",
          "Market regime gate: no new entries when the median close across the universe is below its own 200-day moving average",
        ],
      },
      {
        title: "5. Trade construction and exits",
        items: [
          `Current rule: stop = entry − ${T.STOP_ATR_MULT}×ATR(${T.ATR_PERIOD}) (or the ${T.DONCHIAN_LOOKBACK}-day low if tighter), target ${T.TARGET_R_MULTIPLE}R, book ${pctAt(LIVE.scaleOuts, " + ")} then stop to entry, no trailing stop, ${LIVE.timeExitBars}-day time exit`,
          `Old rule (pre-2026-08-31): stop ${V1.stopAtrMult}×ATR, target ${V1.targetRMultiple}R, breakeven at ${V1.breakevenRMultiple}R, trail the ${V1.trailLookback}-day low from ${V1.trailRMultiple}R, ${V1.timeExitBars}-day time exit, no partial booking`,
          "Both are selectable in the backtest panel below — identical to the quality-gated strategy's, so the two are directly comparable",
        ],
      },
      {
        title: "6. What removing the gate actually did",
        items: [
          "Trades ~4× as often (429 → 1,765 on the old rule) across 430 symbols instead of 71 — the gate is what makes that strategy narrow",
          "Per-trade edge nearly vanishes: expectancy 0.19R → 0.01R on the old rule, 0.23R → 0.03R on the current rule, with profit factor falling to ~1.0–1.06",
          "Win rate also falls (26.8% → 22.7% old rule, 50.4% → 42.5% current rule), so this is not a win-rate-versus-payoff trade-off — it is simply less edge",
          "Portfolio CAGR still reads 11–12.5%, but that is the equity curve's 1/n dilution rewarding a broadly-invested book at 99–120 peak concurrent positions, not a fundable account — read the expectancy, not the CAGR",
          "Read the other way round: on this data the fundamental quality gate is carrying most of the strategy's trade-level edge, which is the useful finding here",
        ],
      },
    ],
  },
  {
    id: "overnight_close_to_open",
    name: "Overnight Close-to-Open",
    description:
      "Buy any stock at today's close, sell at tomorrow's open — unconditionally, every trading day. Pick a symbol below and run it against the full cached price history. Not a live strategy — an on-demand what-if tool.",
    live: false,
    interactiveBacktestKind: "overnight_close_to_open",
    rules: [
      {
        title: "1. Entry — every single trading day",
        items: ["Buy at today's close, no filter or condition of any kind"],
      },
      {
        title: "2. Exit — the very next trading day",
        items: ["Sell at tomorrow's open — held overnight only, flat in cash during the trading session"],
      },
      {
        title: "3. Position sizing",
        items: [
          "Starts at ₹1,00,000, fully compounded — each trade re-invests the entire current value",
          "20bps round-trip cost applied to every trade",
        ],
      },
      {
        title: "4. Data-quality guard",
        items: [
          "Prices are not split/bonus-adjusted — an overnight move beyond ±20% is treated as a probable corporate-action artifact and excluded from compounding, not counted as a real gain or loss",
        ],
      },
    ],
  },
  {
    id: "bulk_deal_institutional_holds",
    name: "Institutional Bulk-Deal Holds (Non-HFT)",
    description:
      "Reconstructs each institutional bulk/block-deal client's actual buy→sell trades from NSE's disclosed deal data, excludes clients whose overall pattern is HFT/market-maker-like, and reports realized returns keyed by firm. Not a live strategy — an on-demand analysis over the whole bulk_deals table, recomputed each time you open it.",
    live: false,
    interactiveBacktestKind: "bulk_deal_institutional_holds",
    rules: [
      {
        title: "1. Trade reconstruction",
        items: [
          "Every SELL is FIFO-matched against that client+symbol's oldest still-open disclosed BUY lot, using each deal's own disclosed price",
          "Same-day buys are applied before same-day sells (deals carry no intraday timestamp)",
          "A sell with no open buy lot (shares acquired outside disclosed bulk/block deals) is excluded from P&L, not guessed at",
          "A buy never disclosed-sold by end of data is an open position — unrealized, reported separately",
        ],
      },
      {
        title: "2. HFT/market-maker exclusion",
        items: [
          "A client is classified HFT-like — and dropped entirely — when the MEDIAN holding period across ALL its realized trades is ≤5 days",
          "This is a firm-level pattern, not a per-trade filter: a genuine long-term holder who occasionally flips one position quickly still counts as non-HFT",
        ],
      },
      {
        title: "3. Reporting",
        items: [
          "Overall realized-trade stats: simple and quantity-weighted return, win rate, holding-period distribution",
          "Per-firm leaderboard: most active by trade count, and best/worst quantity-weighted return among firms with ≥5 realized trades",
        ],
      },
      {
        title: "4. Data-quality caveats",
        items: [
          "is_institution is a keyword heuristic on client name, not a verified legal classification",
          "No corporate-action adjustment — a buy/sell pair spanning a split or bonus would show a distorted return",
          "Best/worst-firm tables at low trade counts (5–10) are dominated by single large positions — treat as illustrative, not statistically reliable",
        ],
      },
    ],
  },
];

export function getStrategy(id: string): StrategyDefinition | null {
  return STRATEGIES.find((s) => s.id === id) ?? null;
}

export interface StrategyCardStats {
  id: string;
  name: string;
  description: string;
  live: boolean;
  interactiveBacktestKind?: StrategyDefinition["interactiveBacktestKind"];
  open_count: number;
  total_return_pct: number;
  cagr_pct: number | null;
  win_rate_pct: number | null;
  realized_pnl_paise: number;
  unrealized_pnl_paise: number;
}

// CAGR since the account's inception date, using the strategy-scoped
// realized+unrealized P&L on top of the account's starting capital as a proxy
// for "what this strategy's slice of the book is worth today". The function and
// its MIN_DAYS_FOR_CAGR floor live in lib/metrics.ts so this account-age CAGR,
// the equity-curve CAGR in the backtest engines, and the browser's live
// recomputation in LiveStrategyDetail can't drift apart. Null before the floor —
// callers fall back to displaying total_return_pct (non-annualized).

/**
 * Card-level stats for every registered strategy. Live strategies pull real
 * numbers from paper_trades filtered by strategy id; non-live strategies
 * return open_count=0 and null return figures (the card renders a
 * "Backtested only" state instead of live positions — see /strategies page).
 */
export async function listStrategyCards(userId = "local"): Promise<StrategyCardStats[]> {
  const db = getDb();
  const acc = getAccount(db, userId);

  return STRATEGIES.map((def) => {
    if (!def.live || !acc) {
      return {
        id: def.id,
        name: def.name,
        description: def.description,
        live: def.live,
        interactiveBacktestKind: def.interactiveBacktestKind,
        open_count: 0,
        total_return_pct: 0,
        cagr_pct: null,
        win_rate_pct: null,
        realized_pnl_paise: 0,
        unrealized_pnl_paise: 0,
      };
    }
    const sum = summarize(db, userId, def.id);
    const realized = sum?.realized_pnl_paise ?? 0;
    const unrealized = sum?.unrealized_pnl_paise ?? 0;
    // Strategy-scoped "current value" = starting cash + this strategy's own
    // realized+unrealized P&L. Not the whole account's equity (see the
    // shared-cash-pool note in lib/paper.ts's summarize()).
    const currentValue = acc.starting_cash_paise + realized + unrealized;
    return {
      id: def.id,
      name: def.name,
      description: def.description,
      live: def.live,
      open_count: sum?.open_count ?? 0,
      total_return_pct:
        acc.starting_cash_paise > 0
          ? ((currentValue - acc.starting_cash_paise) / acc.starting_cash_paise) * 100
          : 0,
      cagr_pct: accountAgeCagrPct(acc.starting_cash_paise, currentValue, acc.created_at),
      win_rate_pct: sum?.win_rate_pct ?? null,
      realized_pnl_paise: realized,
      unrealized_pnl_paise: unrealized,
    };
  });
}

export interface StrategyDetail {
  definition: StrategyDefinition;
  summary: PaperSummary | null;
  active_positions: OpenTradeWithMark[];
  /** Most recent closed trades for this strategy, newest exit first. Capped —
   *  this is the page's trade log, not the full history. */
  closed_positions: ClosedTrade[];
  cagr_pct: number | null;
  // Strategy-scoped total return (not summary.total_return_pct, which is
  // whole-account — see the note in lib/paper.ts's summarize()). Use this as
  // the fallback display whenever cagr_pct is null (insufficient history).
  strategy_total_return_pct: number | null;
  account_created_at: string | null;
}

export async function loadStrategyDetail(strategyId: string, userId = "local"): Promise<StrategyDetail | null> {
  const def = getStrategy(strategyId);
  if (!def) return null;
  const db = getDb();
  const acc = getAccount(db, userId);

  if (!def.live || !acc) {
    return {
      definition: def,
      summary: null,
      active_positions: [],
      closed_positions: [],
      cagr_pct: null,
      strategy_total_return_pct: null,
      account_created_at: acc?.created_at ?? null,
    };
  }

  const summary = summarize(db, userId, def.id);
  const positions = loadActivePaperTrades(db, userId, def.id);
  const closed = loadClosedPaperTrades(db, userId, def.id);
  const currentValue =
    acc.starting_cash_paise + (summary?.realized_pnl_paise ?? 0) + (summary?.unrealized_pnl_paise ?? 0);
  const strategyTotalReturnPct =
    acc.starting_cash_paise > 0 ? ((currentValue - acc.starting_cash_paise) / acc.starting_cash_paise) * 100 : 0;

  return {
    definition: def,
    summary,
    active_positions: positions,
    closed_positions: closed,
    cagr_pct: accountAgeCagrPct(acc.starting_cash_paise, currentValue, acc.created_at),
    strategy_total_return_pct: strategyTotalReturnPct,
    account_created_at: acc.created_at,
  };
}

