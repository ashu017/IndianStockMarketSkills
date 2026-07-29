import { describe, it, expect } from "vitest";
import {
  sma,
  atr,
  donchianHigh,
  donchianLow,
  volAdjMomentum,
  avgVolume,
  goldenCross,
  isDonchianBreakout,
  intradayVolumeFraction,
  isDuringMarketHours,
  type OHLC,
} from "@/lib/indicators";

// Helper: build a UTC Date at a given IST time-of-day. IST is UTC+5:30.
function istDate(h: number, m: number): Date {
  // Pick an arbitrary weekday; the day-of-week doesn't matter for these tests.
  // 2026-07-27 was a Monday. Convert IST hh:mm to UTC by subtracting 5h30m.
  const istMinutes = h * 60 + m;
  const utcMinutes = istMinutes - 5 * 60 - 30;
  const day = 27;
  let addDay = 0;
  let mins = utcMinutes;
  if (mins < 0) {
    mins += 24 * 60;
    addDay = -1;
  }
  const hh = Math.floor(mins / 60);
  const mm = mins % 60;
  return new Date(Date.UTC(2026, 6, day + addDay, hh, mm, 0));
}

describe("sma", () => {
  it("returns null when series shorter than n", () => {
    expect(sma([1, 2], 5)).toBeNull();
  });
  it("averages the last n values", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toBe(4); // (3+4+5)/3
  });
});

describe("donchianHigh / donchianLow", () => {
  it("returns highest close over lookback (inclusive of latest)", () => {
    expect(donchianHigh([10, 12, 11, 13, 12], 3)).toBe(13);
  });
  it("returns lowest low over lookback", () => {
    expect(donchianLow([5, 4, 6, 3, 7], 3)).toBe(3);
  });
});

describe("atr", () => {
  it("returns null with fewer than n+1 bars", () => {
    const bars: OHLC[] = Array.from({ length: 14 }, (_, i) => ({
      open: i, high: i + 1, low: i - 1, close: i, volume: 1,
    }));
    expect(atr(bars, 14)).toBeNull(); // need 15 bars
  });

  it("produces a positive ATR when volatility is present", () => {
    // 30 bars with alternating ±1 close moves gives predictable TR = ~2 per bar.
    const bars: OHLC[] = Array.from({ length: 30 }, (_, i) => {
      const c = 100 + (i % 2 === 0 ? 0 : 2);
      return { open: c, high: c + 1, low: c - 1, close: c, volume: 1 };
    });
    const v = atr(bars, 14)!;
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(5);
  });
});

describe("volAdjMomentum", () => {
  it("returns null when history is shorter than tPast", () => {
    expect(volAdjMomentum([1, 2, 3], 252, 21)).toBeNull();
  });

  it("returns positive for a steadily rising series", () => {
    // 300 bars of 1% daily growth with tiny noise.
    const closes: number[] = [100];
    for (let i = 1; i < 300; i++) closes.push(closes[i - 1] * 1.01);
    const m = volAdjMomentum(closes, 252, 21)!;
    expect(m).toBeGreaterThan(0);
  });

  it("returns negative for a steadily falling series", () => {
    const closes: number[] = [100];
    for (let i = 1; i < 300; i++) closes.push(closes[i - 1] * 0.99);
    const m = volAdjMomentum(closes, 252, 21)!;
    expect(m).toBeLessThan(0);
  });

  it("throws when tPast <= tSkip (invalid config)", () => {
    expect(() => volAdjMomentum([1, 2, 3, 4], 5, 5)).toThrow();
  });
});

describe("avgVolume", () => {
  it("mirrors sma over the last n volumes", () => {
    expect(avgVolume([100, 200, 300, 400], 2)).toBe(350);
  });
});

describe("goldenCross", () => {
  it("null when insufficient history", () => {
    expect(goldenCross([1, 2, 3])).toBeNull();
  });

  it("true when last close > sma200 and sma50 > sma200 (rising series)", () => {
    // 260 bars of steady growth — sma50 (recent) > sma200 (older), and last close is highest.
    const closes: number[] = [];
    for (let i = 0; i < 260; i++) closes.push(100 + i);
    expect(goldenCross(closes)).toBe(true);
  });

  it("false when last close < sma200 (falling series)", () => {
    const closes: number[] = [];
    for (let i = 0; i < 260; i++) closes.push(1000 - i);
    expect(goldenCross(closes)).toBe(false);
  });
});

describe("isDonchianBreakout", () => {
  it("null when history is too short", () => {
    expect(isDonchianBreakout([1, 2], 20)).toBeNull();
  });

  it("true when today's close > max of prior n closes", () => {
    const closes = [...Array(20).fill(100), 101]; // 20 flat, then +1
    expect(isDonchianBreakout(closes, 20)).toBe(true);
  });

  it("false when today's close equals the prior high (not strictly greater)", () => {
    const closes = [...Array(20).fill(100), 100];
    expect(isDonchianBreakout(closes, 20)).toBe(false);
  });
});

describe("intradayVolumeFraction", () => {
  it("returns 0 before market open (09:15 IST)", () => {
    expect(intradayVolumeFraction(istDate(9, 0))).toBe(0);
    expect(intradayVolumeFraction(istDate(9, 15))).toBe(0);
  });
  it("returns 1 after market close (15:30 IST)", () => {
    expect(intradayVolumeFraction(istDate(15, 30))).toBe(1);
    expect(intradayVolumeFraction(istDate(18, 0))).toBe(1);
  });
  it("returns anchor values on the dot", () => {
    // 10:00 IST → 0.20
    expect(intradayVolumeFraction(istDate(10, 0))).toBeCloseTo(0.20, 3);
    // 12:00 IST → 0.42
    expect(intradayVolumeFraction(istDate(12, 0))).toBeCloseTo(0.42, 3);
    // 15:00 IST → 0.74
    expect(intradayVolumeFraction(istDate(15, 0))).toBeCloseTo(0.74, 3);
  });
  it("interpolates linearly between anchors", () => {
    // 11:30 IST is midway between 11:00 (0.33) and 12:00 (0.42) → ~0.375
    expect(intradayVolumeFraction(istDate(11, 30))).toBeCloseTo(0.375, 3);
  });
  it("is monotonically non-decreasing across the day", () => {
    let prev = -0.001;
    for (let m = 9 * 60 + 15; m <= 15 * 60 + 30; m += 5) {
      const h = Math.floor(m / 60);
      const mm = m % 60;
      const f = intradayVolumeFraction(istDate(h, mm));
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
  });
});

describe("isDuringMarketHours", () => {
  it("false outside 09:15–15:30 IST", () => {
    expect(isDuringMarketHours(istDate(8, 0))).toBe(false);
    expect(isDuringMarketHours(istDate(16, 0))).toBe(false);
    expect(isDuringMarketHours(istDate(3, 0))).toBe(false);
  });
  it("true within market hours (inclusive of both bounds)", () => {
    expect(isDuringMarketHours(istDate(9, 15))).toBe(true);
    expect(isDuringMarketHours(istDate(11, 0))).toBe(true);
    expect(isDuringMarketHours(istDate(15, 30))).toBe(true);
  });
});
