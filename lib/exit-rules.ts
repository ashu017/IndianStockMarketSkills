/**
 * Versioned exit rules — the single source of truth for how an open position is
 * managed after entry.
 *
 * WHY VERSIONED. On 2026-08-31 the live rule changed from "breakeven at 1R,
 * trail the 20-day low from 2R, 60-bar cap" to "book half at 1.5R then stop to
 * entry, 25-bar cap" (see lib/backtest.ts's LIVE_MOMENTUM_PARAMS for the
 * measured justification). Positions opened before that date were opened on the
 * old plan, so they keep being managed on it — paper_trades.exit_rule and
 * open_positions.exit_rule stamp each row with the rule it was opened under, and
 * the replay resolves the rule per row rather than applying today's rule to
 * yesterday's trades. Retroactively re-planning a live position would rewrite
 * history and, for anything already past the new 25-bar cap, book an exit on a
 * date the rule was never in force.
 *
 * WHY ITS OWN MODULE. Both exit engines (lib/paper.ts for the sized paper
 * portfolio, lib/positions.ts for the unsized signal tracker that feeds the
 * Telegram digest) previously each kept their own private copies of these
 * constants, which is how they'd silently drift apart. lib/backtest.ts's
 * MomentumParams now also builds on these, so the backtested rule and the traded
 * rule cannot disagree. Deliberately free of `server-only` and any DB import so
 * every one of those callers — and the tests — can import it.
 */

/** One scale-out rung: sell `fraction` of the ORIGINAL position at `r` R. */
export interface ScaleOutRung {
  r: number;
  fraction: number;
}

export interface ExitRule {
  /** Move the stop to entry once a bar CLOSES at or above this R multiple.
   *  Null disables — measured as edge-destroying on the momentum signal. */
  breakevenRMultiple: number | null;
  /** Start trailing the `trailLookback`-day low once a bar closes at or above
   *  this R multiple. Null disables. */
  trailRMultiple: number | null;
  trailLookback: number;
  /** Close whatever remains at this bar's close, counting from entry. */
  timeExitBars: number;
  /** Partial profit ladder, ascending by `r`, fractions summing to ≤ 1. */
  scaleOuts: ScaleOutRung[];
  /** Move the stop to entry as soon as the first rung fills. */
  breakevenAfterPartial: boolean;
}

export type ExitRuleId = "v1_atr2_3r" | "v2_scaleout";

export const EXIT_RULES: Record<ExitRuleId, ExitRule> = {
  // The rule every position opened before 2026-08-31 was planned on. Frozen —
  // it exists to finish managing those trades and to serve as the backtest
  // baseline, so it must never track a threshold change.
  v1_atr2_3r: {
    breakevenRMultiple: 1,
    trailRMultiple: 2,
    trailLookback: 20,
    timeExitBars: 60,
    scaleOuts: [],
    breakevenAfterPartial: false,
  },
  v2_scaleout: {
    breakevenRMultiple: null,
    trailRMultiple: null,
    trailLookback: 20,
    timeExitBars: 25,
    scaleOuts: [{ r: 1.5, fraction: 0.5 }],
    breakevenAfterPartial: true,
  },
};

/** The rule new entries are opened on. */
export const CURRENT_EXIT_RULE: ExitRuleId = "v2_scaleout";

/** v1's entry-plan geometry. Held here rather than read from
 *  TECHNICAL_THRESHOLDS because those now carry v2's values — a v1 trade's stop
 *  and target are already persisted on its row, but the backtest baseline needs
 *  to reconstruct them. */
export const V1_STOP_ATR_MULT = 2;
export const V1_TARGET_R_MULTIPLE = 3;

export function isExitRuleId(v: unknown): v is ExitRuleId {
  return v === "v1_atr2_3r" || v === "v2_scaleout";
}

/**
 * Rule for a stored row. An unrecognized or NULL id resolves to v1, because the
 * only rows that can carry one predate the column and were therefore opened on
 * v1 — defaulting to the CURRENT rule would silently re-plan them, which is the
 * exact failure the column exists to prevent.
 */
export function resolveExitRule(id: string | null | undefined): ExitRule {
  return isExitRuleId(id) ? EXIT_RULES[id] : EXIT_RULES.v1_atr2_3r;
}

/** Human-readable one-liner, for digests and the strategy page. */
export function describeExitRule(rule: ExitRule): string {
  const parts: string[] = [];
  if (rule.scaleOuts.length > 0) {
    parts.push(
      `book ${rule.scaleOuts.map((s) => `${Math.round(s.fraction * 100)}% at ${s.r}R`).join(" + ")}` +
        (rule.breakevenAfterPartial ? ", then stop to entry" : ""),
    );
  }
  parts.push(rule.breakevenRMultiple !== null ? `breakeven at ${rule.breakevenRMultiple}R` : "no auto-breakeven");
  if (rule.trailRMultiple !== null) {
    parts.push(`trail the ${rule.trailLookback}-day low from ${rule.trailRMultiple}R`);
  } else {
    parts.push("no trailing stop");
  }
  parts.push(`${rule.timeExitBars}-bar time exit`);
  return parts.join(", ");
}

/**
 * Shares to sell at each rung, given a whole-share position. Floors, so an odd
 * position leaves the extra share on the runner.
 *
 * A position too small to split (qty 1, or a fraction that floors to 0) yields 0
 * for that rung — callers must treat that as "exit in full at the rung" rather
 * than skipping it, since skipping would leave the trade running with no
 * breakeven protection at all, which is worse than either rule intends.
 */
export function rungQty(qty: number, fraction: number): number {
  return Math.floor(qty * fraction);
}

