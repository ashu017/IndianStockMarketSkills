import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { test, expect, describe } from "vitest";
import { computeQty, ensureAccount, DEFAULT_SIZING } from "@/lib/paper";

/**
 * Pins position sizing and the account's seeded sizing knobs.
 *
 * WHY THIS FILE EXISTS. `risk_pct_per_trade` and `max_position_pct` look like two
 * independent caps, but only one of them is ever in force for a given trade:
 * size is min(risk cap, capital cap), so the capital cap is dead weight unless
 * the stop is closer than risk_pct/max_position_pct of price. That's a genuinely
 * counterintuitive interaction — it led to an attempt to fit more concurrent
 * positions by lowering max_position_pct, which would have resized exactly one
 * of five live positions and changed nothing else. The crossover is asserted
 * here so the relationship between the two knobs is checkable rather than folk
 * knowledge.
 *
 * Prices in paise. Equity is Rs 1,00,000 (10,000,000 paise) throughout.
 */

const EQUITY = 100_000_00;
const ENTRY = 1_000_00; // Rs 1,000/share

/** Sizing inputs at the seeded knobs, with the stop placed `pct` below entry. */
function atStopPct(pct: number) {
  return computeQty({
    equity_paise: EQUITY,
    entry_paise: ENTRY,
    stop_paise: Math.round(ENTRY * (1 - pct / 100)),
    risk_pct: DEFAULT_SIZING.riskPctPerTrade,
    max_position_pct: DEFAULT_SIZING.maxPositionPct,
  });
}

/** Position size as a percentage of equity. */
const pctOfEquity = (r: { capital_committed_paise: number }) =>
  (100 * r.capital_committed_paise) / EQUITY;

describe("computeQty — which cap binds", () => {
  // The crossover the whole sizing story hinges on. At the seeded knobs this is
  // 0.5/12.5 = 4% of price: wider stops are risk-limited, tighter ones are
  // capital-limited. If DEFAULT_SIZING is retuned, this recomputes with it —
  // the RELATIONSHIP is what's pinned, not the number 4.
  const crossover =
    (DEFAULT_SIZING.riskPctPerTrade / DEFAULT_SIZING.maxPositionPct) * 100;

  test("the crossover sits at risk_pct / max_position_pct of price", () => {
    expect(crossover).toBeCloseTo(4, 10);
  });

  const riskBudget = (DEFAULT_SIZING.riskPctPerTrade / 100) * EQUITY;

  test("a stop WIDER than the crossover is risk-limited, so the capital cap is slack", () => {
    const r = atStopPct(crossover * 2); // 8% stop
    // Ideal risk-limited size = risk_pct / stop_distance = 0.5/8 = 6.25% of
    // equity, i.e. 6.25 shares — floored to 6, so 6.0%. Asserted as the integer
    // rather than the ideal because whole-share flooring is not a rounding
    // nicety here: a Rs 1,000 share quantizes a Rs 1,00,000 account in 1%
    // steps, so the realized position is always at or below the intent.
    expect(r.qty).toBe(6);
    expect(pctOfEquity(r)).toBeCloseTo(6.0, 10);
    expect(pctOfEquity(r)).toBeLessThan(DEFAULT_SIZING.maxPositionPct);
    // Risk budget nearly exhausted — short of it by less than one share.
    expect(r.risk_paise).toBeLessThanOrEqual(riskBudget);
    expect(riskBudget - r.risk_paise).toBeLessThan(r.risk_paise / r.qty);
  });

  test("a stop TIGHTER than the crossover is capital-limited and under-uses the risk budget", () => {
    const r = atStopPct(crossover / 2); // 2% stop
    // Capital cap allows 12.5 shares, floored to 12 = 12.0% of equity. The risk
    // cap would have allowed 25, so the capital cap is what's binding.
    expect(r.qty).toBe(12);
    expect(pctOfEquity(r)).toBeLessThanOrEqual(DEFAULT_SIZING.maxPositionPct);
    // The trade therefore risks LESS than the nominal per-trade risk — the
    // capital cap is a de-risking device on tight stops, not a size booster.
    expect(r.risk_paise).toBeLessThan(riskBudget);
    expect(r.risk_paise).toBeCloseTo(0.48 * riskBudget, 0);
  });

  test("lowering max_position_pct does nothing to a risk-limited trade", () => {
    // THE MISCONCEPTION THIS FILE GUARDS. Halving the capital cap leaves an
    // 8% -stop position untouched, because the risk cap was the binding one.
    const wide = { equity_paise: EQUITY, entry_paise: ENTRY, stop_paise: ENTRY * 0.92 };
    const before = computeQty({ ...wide, risk_pct: 0.5, max_position_pct: 12.5 });
    const after = computeQty({ ...wide, risk_pct: 0.5, max_position_pct: 6.25 });
    expect(after.qty).toBe(before.qty);
    // Whereas halving risk_pct halves it, which is the knob that actually sizes.
    const halvedRisk = computeQty({ ...wide, risk_pct: 0.25, max_position_pct: 12.5 });
    expect(halvedRisk.qty).toBe(Math.floor(before.qty / 2));
  });
});

describe("computeQty — degenerate inputs", () => {
  test("a stop at or above entry is refused rather than sized", () => {
    for (const stop of [ENTRY, ENTRY + 1]) {
      const r = computeQty({
        equity_paise: EQUITY, entry_paise: ENTRY, stop_paise: stop,
        risk_pct: 1, max_position_pct: 25,
      });
      expect(r.qty).toBe(0);
      expect(r.reason).toBe("stop_not_below_entry");
    }
  });

  test("a share too expensive for the capital cap reports the capital cap, not the risk budget", () => {
    // Rs 20,000/share against a 12.5% cap on Rs 1,00,000 = Rs 12,500 — under one
    // share. The risk budget alone would have allowed 2.
    const r = computeQty({
      equity_paise: EQUITY, entry_paise: 20_000_00, stop_paise: 19_750_00,
      risk_pct: DEFAULT_SIZING.riskPctPerTrade,
      max_position_pct: DEFAULT_SIZING.maxPositionPct,
    });
    expect(r.qty).toBe(0);
    expect(r.reason).toBe("capital_cap_below_one_share");
  });

  test("too little equity to risk one share reports the risk budget", () => {
    const r = computeQty({
      equity_paise: 1_000_00, entry_paise: ENTRY, stop_paise: 900_00,
      risk_pct: 0.5, max_position_pct: 100,
    });
    expect(r.qty).toBe(0);
    expect(r.reason).toBe("risk_budget_too_small");
  });
});

describe("seeded account sizing", () => {
  test("ensureAccount writes DEFAULT_SIZING, not the schema DEFAULTs", () => {
    // openPaperTrade's INSERT names these columns, so schema DEFAULTs never
    // apply to an app-created account. This catches the two drifting apart.
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(readFileSync("db/schema.sql", "utf8"));
    const a = ensureAccount(db, "local", EQUITY);
    expect(a.risk_pct_per_trade).toBe(DEFAULT_SIZING.riskPctPerTrade);
    expect(a.max_concurrent_trades).toBe(DEFAULT_SIZING.maxConcurrentTrades);
    expect(a.max_position_pct).toBe(DEFAULT_SIZING.maxPositionPct);
    db.close();
  });

  test("a full book risks a sane fraction of equity in aggregate", () => {
    // The reason slots and risk_pct must move together: raising concurrency
    // without lowering per-trade risk raises total portfolio risk linearly.
    const aggregate = DEFAULT_SIZING.maxConcurrentTrades * DEFAULT_SIZING.riskPctPerTrade;
    expect(aggregate).toBeCloseTo(5, 10);
    expect(aggregate).toBeLessThanOrEqual(6);
  });

  test("the slot count and capital cap can't demand more capital than exists", () => {
    // slots × max_position_pct may exceed 100% (cash then binds first, which is
    // fine and deliberate), but a typical position must leave room for a full
    // book or the later slots are unreachable in practice.
    const typicalStopPct = 5.4; // median across the live book
    const typicalPositionPct = DEFAULT_SIZING.riskPctPerTrade / (typicalStopPct / 100) / 100;
    expect(DEFAULT_SIZING.maxConcurrentTrades * typicalPositionPct).toBeLessThanOrEqual(100);
  });
});
