import { test, expect, describe } from "vitest";
import { STRATEGIES, getStrategy } from "@/lib/strategies";
import { LIVE_MOMENTUM_PARAMS, V1_MOMENTUM_PARAMS } from "@/lib/backtest";

/**
 * Guards the wiring between the registry, the detail page and the backtest route
 * — a mistyped strategy id or a new `interactiveBacktestKind` the page doesn't
 * handle both fail as a silently empty page rather than as an error, which is
 * the kind of thing nobody notices until they open it.
 */

/** Kinds StrategyDetailClient.tsx has an explicit branch for. */
const RENDERED_KINDS = [
  "overnight_close_to_open",
  "bulk_deal_institutional_holds",
  "momentum_technical_only",
];

/** Keys of BACKTESTABLE in app/api/backtest/[strategy]/route.ts. Duplicated
 *  rather than imported because importing a route module drags in the whole
 *  Next request runtime for no benefit — the point is that these ids resolve. */
const BACKTESTABLE_IDS = ["quality_trend_momentum_breakout", "trend_momentum_breakout_technical"];

describe("strategy registry", () => {
  test("ids are unique", () => {
    const ids = STRATEGIES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every interactiveBacktestKind has a branch in the detail page", () => {
    for (const s of STRATEGIES) {
      if (s.interactiveBacktestKind === undefined) continue;
      expect(RENDERED_KINDS).toContain(s.interactiveBacktestKind);
    }
  });

  test("every backtestable id is a registered strategy", () => {
    for (const id of BACKTESTABLE_IDS) {
      expect(getStrategy(id), `${id} is missing from STRATEGIES`).not.toBeNull();
    }
  });

  test("rule groups are numbered consecutively from 1", () => {
    // StrategyDetailClient matches its stage icon to the group's ordinal
    // position, so a gap or a repeat silently mislabels a stage.
    for (const s of STRATEGIES) {
      if (!s.rules) continue;
      const prefixes = s.rules.map((g) => g.title.match(/^(\d+)\./)?.[1]);
      expect(prefixes, `${s.id} has an unnumbered rule group`).not.toContain(undefined);
      expect(prefixes.map(Number)).toEqual(s.rules.map((_, i) => i + 1));
    }
  });
});

describe("the two momentum strategies", () => {
  const gated = getStrategy("quality_trend_momentum_breakout");
  const technical = getStrategy("trend_momentum_breakout_technical");

  test("both exist, and only the gated one is live", () => {
    expect(gated?.live).toBe(true);
    expect(technical?.live).toBe(false);
    expect(technical?.interactiveBacktestKind).toBe("momentum_technical_only");
  });

  test("only the gated one documents a fundamental quality gate", () => {
    expect(gated?.rules?.[0].title).toMatch(/quality gate/i);
    expect(JSON.stringify(gated?.rules)).toContain("ROCE");
    // The technical-only strategy's first group is the universe, and it says
    // outright that no fundamental criterion applies.
    expect(technical?.rules?.[0].title).toMatch(/no fundamental filter/i);
    expect(technical?.rules?.some((g) => /quality gate/i.test(g.title))).toBe(false);
  });

  test("the technical-only page quotes the real exit parameters, not stale copy", () => {
    const text = JSON.stringify(technical?.rules);
    expect(text).toContain(`${LIVE_MOMENTUM_PARAMS.targetRMultiple}R`);
    expect(text).toContain(`${LIVE_MOMENTUM_PARAMS.timeExitBars}-day time exit`);
    expect(text).toContain(`${V1_MOMENTUM_PARAMS.timeExitBars}-day time exit`);
  });

  test("the gated page describes the live exit rule, not a proposal", () => {
    const text = JSON.stringify(gated?.rules);
    // The scale-out ladder is the live rule's defining mechanic, so it must be
    // stated in the position-management group rather than parked in a
    // "backtest only" aside, which is what this page used to do.
    for (const s of LIVE_MOMENTUM_PARAMS.scaleOuts) {
      expect(text).toContain(`${s.r}R`);
    }
    expect(text).toContain(`${LIVE_MOMENTUM_PARAMS.timeExitBars} trading days`);
    expect(text).not.toMatch(/NOT trading|backtest only/i);
    // …and it must still explain that older positions run the old rule, or the
    // blended closed-trade stats on the page are unexplained.
    expect(text).toMatch(/grandfathered/i);
  });
});

