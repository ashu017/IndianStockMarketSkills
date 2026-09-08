import { describe, it, expect } from "vitest";
import {
  buildEquityCurve,
  DEFAULT_EQUITY_SLOTS,
  type CurveBar,
  type CurveTrade,
} from "@/lib/equity-curve";
import { computeEquityMetrics, toSeries } from "@/lib/metrics";

/** Consecutive weekday-agnostic dates — the curve builder only needs sorted
 *  strings, not real trading days. */
function days(start: string, n: number): string[] {
  const out: string[] = [];
  const t0 = new Date(`${start}T00:00:00Z`).getTime();
  for (let i = 0; i < n; i++) out.push(new Date(t0 + i * 86_400_000).toISOString().slice(0, 10));
  return out;
}

/** Bars whose closes follow a given per-day return sequence. */
function bars(dates: string[], startClose: number, rets: number[]): CurveBar[] {
  const out: CurveBar[] = [{ trade_date: dates[0], close: startClose }];
  for (let i = 0; i < rets.length; i++) {
    out.push({ trade_date: dates[i + 1], close: out[i].close * (1 + rets[i]) });
  }
  return out;
}

function flat(dates: string[], close: number): CurveBar[] {
  return dates.map((d) => ({ trade_date: d, close }));
}

describe("buildEquityCurve", () => {
  it("returns null with no trades", () => {
    expect(
      buildEquityCurve({
        trades: [],
        barsBySymbol: new Map(),
        tradingDates: days("2024-01-01", 5),
        costBpsRoundtrip: 20,
      }),
    ).toBeNull();
  });

  it("opens at starting capital on the first entry date", () => {
    const dates = days("2024-01-01", 5);
    const res = buildEquityCurve({
      trades: [{ symbol: "A", entry_date: dates[1], exit_date: dates[3], exit_paise: 110 }],
      barsBySymbol: new Map([["A", flat(dates, 100)]]),
      tradingDates: dates,
      costBpsRoundtrip: 0,
      startingRupees: 100_000,
    })!;
    // Curve spans first entry -> last exit inclusive.
    expect(res.curve[0].date).toBe(dates[1]);
    expect(res.curve[res.curve.length - 1].date).toBe(dates[3]);
    // Nothing is held during the entry day itself (entry executes at its close).
    expect(res.curve[0].value_rupees).toBeCloseTo(100_000, 6);
  });

  it("with one slot and one trade, reproduces that trade's net return exactly", () => {
    // This is the consistency contract with lib/backtest.ts's trade table:
    // return_pct = (exit/entry) * (1 - costFrac) - 1.
    const dates = days("2024-01-01", 8);
    const symbolBars = bars(dates, 100, [0.02, -0.01, 0.03, 0.005, -0.02, 0.01, 0.04]);
    const entryIdx = 1;
    const exitIdx = 6;
    const entryClose = symbolBars[entryIdx].close;
    const exitPaise = symbolBars[exitIdx].close * 1.01; // exited above that day's close
    const costBps = 20;

    const res = buildEquityCurve({
      trades: [
        {
          symbol: "A",
          entry_date: dates[entryIdx],
          exit_date: dates[exitIdx],
          exit_paise: exitPaise,
        },
      ],
      barsBySymbol: new Map([["A", symbolBars]]),
      tradingDates: dates,
      costBpsRoundtrip: costBps,
      slots: 1,
      startingRupees: 100_000,
    })!;

    const expectedNet = (exitPaise / entryClose) * (1 - costBps / 10_000) - 1;
    const actual = res.curve[res.curve.length - 1].value_rupees / 100_000 - 1;
    expect(actual).toBeCloseTo(expectedNet, 12);
  });

  it("defaults to 20 slots, so a lone trade moves the book by ~1/20th", () => {
    const dates = days("2024-01-01", 6);
    const symbolBars = bars(dates, 100, [0.1, 0.1, 0.1, 0.1, 0.1]);
    const res = buildEquityCurve({
      trades: [{ symbol: "A", entry_date: dates[0], exit_date: dates[3], exit_paise: symbolBars[3].close }],
      barsBySymbol: new Map([["A", symbolBars]]),
      tradingDates: dates,
      costBpsRoundtrip: 0,
      startingRupees: 100_000,
    })!;
    expect(res.slots).toBe(DEFAULT_EQUITY_SLOTS);
    // Trade gained ~33% gross over 3 days at 1/20 weight -> ~1.65% on the book.
    const totalPct = (res.curve[res.curve.length - 1].value_rupees / 100_000 - 1) * 100;
    expect(totalPct).toBeGreaterThan(1.4);
    expect(totalPct).toBeLessThan(1.7);
  });

  it("never levers: 40 concurrent positions each get 1/40, not 1/20", () => {
    const dates = days("2024-01-01", 5);
    const barsBySymbol = new Map<string, CurveBar[]>();
    const trades: CurveTrade[] = [];
    const symbolBars = bars(dates, 100, [0.1, 0.1, 0.1, 0.1]);
    for (let i = 0; i < 40; i++) {
      barsBySymbol.set(`S${i}`, symbolBars);
      trades.push({
        symbol: `S${i}`,
        entry_date: dates[0],
        exit_date: dates[3],
        exit_paise: symbolBars[3].close,
      });
    }
    const res = buildEquityCurve({
      trades,
      barsBySymbol,
      tradingDates: dates,
      costBpsRoundtrip: 0,
      startingRupees: 100_000,
    })!;
    expect(res.max_concurrent_positions).toBe(40);
    // Fully invested in 40 identical positions == fully invested in one:
    // 3 days of +10% = +33.1%.
    const totalPct = (res.curve[res.curve.length - 1].value_rupees / 100_000 - 1) * 100;
    expect(totalPct).toBeCloseTo(33.1, 4);
  });

  it("tracks exposure and peak concurrency", () => {
    const dates = days("2024-01-01", 10);
    const b = flat(dates, 100);
    const res = buildEquityCurve({
      trades: [
        { symbol: "A", entry_date: dates[0], exit_date: dates[2], exit_paise: 100 },
        { symbol: "B", entry_date: dates[1], exit_date: dates[5], exit_paise: 100 },
      ],
      barsBySymbol: new Map([
        ["A", b],
        ["B", b],
      ]),
      tradingDates: dates,
      costBpsRoundtrip: 0,
    })!;
    // Curve runs dates[0]..dates[5] = 6 points. Day 0 holds nothing (A enters at
    // its close); days 1-5 hold something.
    expect(res.curve.length).toBe(6);
    expect(res.periods_in_market).toBe(5);
    // Day 2: A and B both open. Day 3+: only B.
    expect(res.max_concurrent_positions).toBe(2);
  });

  it("carries a position unmarked when its symbol has no bar that day", () => {
    const dates = days("2024-01-01", 5);
    // "A" is missing a bar on dates[2].
    const gappy: CurveBar[] = [
      { trade_date: dates[0], close: 100 },
      { trade_date: dates[1], close: 110 },
      { trade_date: dates[3], close: 121 },
      { trade_date: dates[4], close: 121 },
    ];
    const res = buildEquityCurve({
      trades: [{ symbol: "A", entry_date: dates[0], exit_date: dates[4], exit_paise: 121 }],
      barsBySymbol: new Map([["A", gappy]]),
      tradingDates: dates,
      costBpsRoundtrip: 0,
      slots: 1,
    })!;
    expect(res.unmarked_position_days).toBe(1);
    // The gap day contributes 0; the next marked day still compares against the
    // last available close (110 -> 121), so no return is lost, only deferred.
    const finalPct = res.curve[res.curve.length - 1].value_rupees / res.starting_rupees - 1;
    expect(finalPct).toBeCloseTo(0.21, 12);
  });

  it("charges the round-trip cost exactly once per trade, on the exit day", () => {
    const dates = days("2024-01-01", 4);
    const b = flat(dates, 100);
    const withCost = buildEquityCurve({
      trades: [{ symbol: "A", entry_date: dates[0], exit_date: dates[2], exit_paise: 100 }],
      barsBySymbol: new Map([["A", b]]),
      tradingDates: dates,
      costBpsRoundtrip: 100, // 1%
      slots: 1,
      startingRupees: 100_000,
    })!;
    // Flat prices, so the only P&L is the cost: -1%.
    expect(withCost.curve[withCost.curve.length - 1].value_rupees).toBeCloseTo(99_000, 6);
  });

  it("produces a curve that computeEquityMetrics can score", () => {
    const dates = days("2024-01-01", 200);
    const rets = Array.from({ length: 199 }, (_, i) => (i % 3 === 0 ? -0.008 : 0.006));
    const symbolBars = bars(dates, 100, rets);
    const res = buildEquityCurve({
      trades: [
        { symbol: "A", entry_date: dates[0], exit_date: dates[80], exit_paise: symbolBars[80].close },
        { symbol: "A", entry_date: dates[90], exit_date: dates[199], exit_paise: symbolBars[199].close },
      ],
      barsBySymbol: new Map([["A", symbolBars]]),
      tradingDates: dates,
      costBpsRoundtrip: 20,
      slots: 5,
    })!;
    const m = computeEquityMetrics(toSeries(res.curve), {
      periodsInMarket: res.periods_in_market,
    })!;
    expect(m).not.toBeNull();
    expect(m.span_days).toBeGreaterThan(90);
    expect(m.cagr_pct).not.toBeNull();
    expect(m.max_drawdown_pct).toBeGreaterThan(0);
    // Idle stretch between the two trades means exposure is below 100%.
    expect(m.exposure_time_pct).not.toBeNull();
    expect(m.exposure_time_pct!).toBeGreaterThan(80);
    expect(m.exposure_time_pct!).toBeLessThan(100);
  });
});
