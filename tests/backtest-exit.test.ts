import { test, expect, describe } from "vitest";
import {
  simulateExit,
  LIVE_MOMENTUM_PARAMS,
  V1_MOMENTUM_PARAMS,
  type Bar,
  type MomentumParams,
} from "@/lib/backtest";
import { CURRENT_EXIT_RULE, EXIT_RULES } from "@/lib/exit-rules";

/**
 * Pins lib/backtest.ts's exit simulator on hand-built bars.
 *
 * WHY THIS FILE EXISTS. Daily bars carry no intraday sequence, so a bar that
 * touches both the stop and a profit level is genuinely ambiguous, and the
 * engine has to pick a reading. Picking the optimistic one silently inflates
 * every downstream number — and it inflates hardest exactly on the scale-out
 * rule that the tuned params rely on for their win rate, because "ran up
 * through the rung, then closed back under entry" is that rule's most common
 * bar. That class of bug is invisible in a summary table: the result just looks
 * better. So the ordering is asserted directly instead.
 *
 * Prices are in paise, matching the engine. Entry is always bars[0]'s close.
 */

/** A bar with sensible defaults, so each test only states what it cares about. */
function bar(o: { high: number; low: number; close: number; date?: string }): Bar {
  return {
    trade_date: o.date ?? "2025-01-01",
    open: o.close,
    high: o.high,
    low: o.low,
    close: o.close,
    volume: 1_000,
  };
}

/** Series starting at a 100.00 entry bar, then the supplied forward bars. */
function series(...forward: Bar[]): Bar[] {
  return [bar({ high: 10_000, low: 10_000, close: 10_000 }), ...forward];
}

const ENTRY = 10_000;
const STOP = 9_000; // 1R = 1000 paise
const R = 1_000;
const level = (r: number) => ENTRY + r * R;

/**
 * Single all-out exit, no breakeven/trail/ladder — the plain skeleton.
 *
 * Every knob is pinned rather than inherited, INCLUDING targetRMultiple: these
 * tests assert exact fill prices against hand-built bars, so a threshold change
 * in lib/verdict.ts must not move the target out from under them (it did once —
 * a 3R→5R change left a "touches both stop and target" bar no longer reaching
 * the target, so the test kept passing for the wrong reason).
 */
const PLAIN: MomentumParams = {
  ...LIVE_MOMENTUM_PARAMS,
  stopAtrMult: 2,
  targetRMultiple: 3,
  breakevenRMultiple: null,
  trailRMultiple: null,
  timeExitBars: 1_000,
  scaleOuts: [],
  breakevenAfterPartial: false,
};

function run(bars: Bar[], p: MomentumParams, target = level(p.targetRMultiple)) {
  return simulateExit(bars, 0, ENTRY, STOP, target, p);
}

describe("simulateExit — basic exits", () => {
  test("stops out at the stop price, not the bar's low", () => {
    const out = run(series(bar({ high: 10_100, low: 8_500, close: 8_600 })), PLAIN);
    expect(out.exitReason).toBe("stopped");
    expect(out.exitPaise).toBe(STOP);
    expect(out.barsHeld).toBe(1);
    expect(out.grossReturn).toBeCloseTo(-0.1, 10);
  });

  test("target fills at the target price even when the bar overshoots it", () => {
    const out = run(series(bar({ high: 20_000, low: 10_000, close: 19_000 })), PLAIN);
    expect(out.exitReason).toBe("target_hit");
    expect(out.exitPaise).toBe(level(3));
    expect(out.grossReturn).toBeCloseTo(0.3, 10);
  });

  test("a bar touching BOTH stop and target resolves as the stop", () => {
    // The pessimistic reading of an ambiguous daily bar. If this ever flips,
    // every backtest in the app gets better for no real reason.
    const out = run(series(bar({ high: 14_000, low: 8_000, close: 13_000 })), PLAIN);
    expect(out.exitReason).toBe("stopped");
    expect(out.exitPaise).toBe(STOP);
  });

  test("time exit closes at the close of the capping bar", () => {
    const p = { ...PLAIN, timeExitBars: 2 };
    const out = run(
      series(
        bar({ high: 10_500, low: 9_800, close: 10_200 }),
        bar({ high: 10_600, low: 10_000, close: 10_400, date: "2025-01-02" }),
      ),
      p,
    );
    expect(out.exitReason).toBe("time_exit");
    expect(out.barsHeld).toBe(2);
    expect(out.exitPaise).toBe(10_400);
    expect(out.grossReturn).toBeCloseTo(0.04, 10);
  });

  test("running out of bars is data_end at the last close, not a target or stop", () => {
    const out = run(series(bar({ high: 10_500, low: 9_800, close: 10_300 })), PLAIN);
    expect(out.exitReason).toBe("data_end");
    expect(out.exitPaise).toBe(10_300);
    expect(out.partialIdx).toBeNull();
  });
});

describe("simulateExit — breakeven and trailing stop", () => {
  test("breakeven arms on the CLOSE at 1R, so it can't fire on the same bar", () => {
    const p = { ...PLAIN, breakevenRMultiple: 1 };
    const out = run(
      series(
        // Closes above 1R — arms breakeven. Its own low is above entry, so no exit.
        bar({ high: 11_200, low: 10_100, close: 11_100 }),
        // Next bar dips below entry and is caught by the raised stop.
        bar({ high: 11_200, low: 9_900, close: 9_950, date: "2025-01-02" }),
      ),
      p,
    );
    expect(out.exitReason).toBe("stopped");
    expect(out.exitPaise).toBe(ENTRY);
    expect(out.barsHeld).toBe(2);
    expect(out.grossReturn).toBe(0);
  });

  test("a bar that touches 1R intrabar but closes below it does NOT arm breakeven", () => {
    const p = { ...PLAIN, breakevenRMultiple: 1 };
    const out = run(
      series(
        bar({ high: 11_500, low: 9_500, close: 10_500 }), // high > 1R, close < 1R
        bar({ high: 10_600, low: 9_800, close: 9_900, date: "2025-01-02" }), // dips under entry
      ),
      p,
    );
    // Still running on the original stop, so the dip under entry is not an exit.
    expect(out.exitReason).toBe("data_end");
    expect(out.exitPaise).toBe(9_900);
  });

  test("the trail only ever ratchets the stop upward", () => {
    const p = { ...PLAIN, breakevenRMultiple: 1, trailRMultiple: 2, trailLookback: 3 };
    const out = run(
      series(
        bar({ high: 12_100, low: 11_000, close: 12_050 }), // closes > 2R: trail arms
        // 3-bar Donchian low across [entry, bar1, bar2] = 10_000 (entry bar's low),
        // which is not above the breakeven stop, so the stop must stay at entry —
        // never drop back toward the original 9_000.
        bar({ high: 12_200, low: 9_950, close: 9_960, date: "2025-01-02" }),
      ),
      p,
    );
    expect(out.exitReason).toBe("stopped");
    expect(out.exitPaise).toBe(ENTRY);
  });
});

describe("simulateExit — scale-out ladder", () => {
  const p: MomentumParams = {
    ...PLAIN,
    targetRMultiple: 5,
    scaleOuts: [{ r: 1.5, fraction: 0.5 }],
    breakevenAfterPartial: true,
  };

  test("books half at the rung and runs the rest to the target", () => {
    const out = run(
      series(
        // Low stays clear of entry, so the post-rung breakeven stop isn't touched.
        bar({ high: level(1.5), low: 10_050, close: 11_400 }), // rung fills
        bar({ high: level(5), low: 11_000, close: 15_000, date: "2025-01-02" }), // runner targets
      ),
      p,
    );
    expect(out.exitReason).toBe("target_hit");
    expect(out.partialIdx).toBe(1);
    expect(out.partialPaise).toBe(level(1.5));
    // 0.5 × 15% + 0.5 × 50%
    expect(out.grossReturn).toBeCloseTo(0.5 * 0.15 + 0.5 * 0.5, 10);
  });

  test("a bar that fills the rung and then breaks entry is charged the breakeven stop", () => {
    // THE REGRESSION THIS FILE WAS WRITTEN FOR. Without the same-bar re-check,
    // the rung is banked and the runner is carried forward for free, which
    // flatters the exact rule the tuned params depend on.
    const out = run(series(bar({ high: level(1.5), low: 9_500, close: 9_600 })), p);
    expect(out.exitReason).toBe("stopped");
    expect(out.exitPaise).toBe(ENTRY);
    expect(out.partialIdx).toBe(1);
    // Half booked at +15%, half stopped at entry for 0%.
    expect(out.grossReturn).toBeCloseTo(0.5 * 0.15, 10);
  });

  test("the stop is checked before the rung, so a stop-breaching bar books nothing", () => {
    // Bar breaches the ORIGINAL stop and also trades through the rung. Stop wins.
    const out = run(series(bar({ high: level(1.5), low: 8_900, close: 9_000 })), p);
    expect(out.exitReason).toBe("stopped");
    expect(out.partialIdx).toBeNull();
    expect(out.grossReturn).toBeCloseTo(-0.1, 10);
  });

  test("a rung and the target on one bar fill in order, not just the target", () => {
    const out = run(series(bar({ high: level(5), low: 10_050, close: 14_500 })), p);
    expect(out.exitReason).toBe("target_hit");
    expect(out.partialIdx).toBe(1);
    expect(out.grossReturn).toBeCloseTo(0.5 * 0.15 + 0.5 * 0.5, 10);
  });

  test("a low exactly AT the post-rung breakeven stop counts as filled", () => {
    // Boundary case, asserted rather than left to chance: touching the stop is
    // an exit (`low <= stop`), which is the pessimistic reading. A bar whose low
    // is exactly entry after the rung filled therefore ends the trade flat on
    // the runner rather than carrying it another day.
    const out = run(series(bar({ high: level(1.5), low: ENTRY, close: 11_400 })), p);
    expect(out.exitReason).toBe("stopped");
    expect(out.exitPaise).toBe(ENTRY);
    expect(out.grossReturn).toBeCloseTo(0.5 * 0.15, 10);
  });

  test("multiple rungs can fill on one bar, each at its own price", () => {
    const ladder: MomentumParams = {
      ...PLAIN,
      targetRMultiple: 5,
      scaleOuts: [
        { r: 1, fraction: 0.33 },
        { r: 2, fraction: 0.33 },
      ],
      breakevenAfterPartial: false,
    };
    const out = run(
      series(
        bar({ high: level(2), low: 10_000, close: 11_900 }),
        bar({ high: 12_000, low: 11_800, close: 11_850, date: "2025-01-02" }),
      ),
      ladder,
    );
    expect(out.exitReason).toBe("data_end");
    // First rung's date is the one reported, even though both filled together.
    expect(out.partialIdx).toBe(1);
    expect(out.partialPaise).toBe(level(1));
    const remaining = 1 - 0.66;
    expect(out.grossReturn).toBeCloseTo(
      0.33 * 0.1 + 0.33 * 0.2 + remaining * (11_850 / ENTRY - 1),
      10,
    );
  });

  test("an unreached rung leaves the whole position on the final exit", () => {
    const out = run(series(bar({ high: 11_000, low: 9_100, close: 10_900 })), p);
    expect(out.partialIdx).toBeNull();
    expect(out.grossReturn).toBeCloseTo(0.09, 10);
  });

  test("no partial exit is reported when the ladder is empty", () => {
    const out = run(series(bar({ high: level(2), low: 10_000, close: 11_900 })), PLAIN);
    expect(out.partialIdx).toBeNull();
    expect(out.partialPaise).toBeNull();
  });
});

describe("parameter sets", () => {
  // The v1 baseline is FROZEN — it exists to reproduce the pre-2026-08-31 rule
  // and to finish managing positions opened on it, so these literals are the
  // point of the test, not a restatement of a constant. If a threshold change
  // ever moves them, the baseline has stopped being a baseline.
  test("v1 params reproduce the pre-2026-08-31 recipe exactly", () => {
    expect(V1_MOMENTUM_PARAMS).toMatchObject({
      stopAtrMult: 2,
      targetRMultiple: 3,
      breakevenRMultiple: 1,
      trailRMultiple: 2,
      timeExitBars: 60,
      scaleOuts: [],
    });
  });

  test("live params shorten the horizon and hold a valid single-rung ladder", () => {
    expect(LIVE_MOMENTUM_PARAMS.timeExitBars).toBeLessThan(V1_MOMENTUM_PARAMS.timeExitBars);
    expect(LIVE_MOMENTUM_PARAMS.breakevenRMultiple).toBeNull();
    expect(LIVE_MOMENTUM_PARAMS.trailRMultiple).toBeNull();
    expect(LIVE_MOMENTUM_PARAMS.breakevenAfterPartial).toBe(true);
    const total = LIVE_MOMENTUM_PARAMS.scaleOuts.reduce((a: number, s) => a + s.fraction, 0);
    expect(total).toBeLessThanOrEqual(1);
    // Every rung must sit strictly below the target or it can never fill as a
    // separate leg — runTechnicalBacktest() throws on this, so assert it here.
    for (const s of LIVE_MOMENTUM_PARAMS.scaleOuts) {
      expect(s.r).toBeLessThan(LIVE_MOMENTUM_PARAMS.targetRMultiple);
    }
  });

  // The whole point of promoting the rule is that the live params ARE what the
  // paper engine trades. lib/exit-rules.ts is the single source; this pins that
  // the backtest didn't fork its own copy.
  test("live params are the v2 exit rule the paper engine resolves", () => {
    expect(LIVE_MOMENTUM_PARAMS).toMatchObject(EXIT_RULES[CURRENT_EXIT_RULE]);
    expect(V1_MOMENTUM_PARAMS).toMatchObject(EXIT_RULES.v1_atr2_3r);
  });
});
