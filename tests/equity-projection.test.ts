import { test, expect } from "vitest";
import { projectEquity, PROJECTION_DAYS } from "@/lib/equity-projection";

test("no projection from fewer than two points", () => {
  expect(projectEquity([])).toEqual([]);
  expect(projectEquity([{ date: "2026-09-08", value_rupees: 300_000 }])).toEqual([]);
});

test("starts at history's own last point so the lines meet", () => {
  const p = projectEquity([
    { date: "2026-09-01", value_rupees: 300_000 },
    { date: "2026-09-08", value_rupees: 310_000 },
  ]);
  expect(p[0]).toEqual({ date: "2026-09-08", value_rupees: 310_000 });
  expect(p).toHaveLength(PROJECTION_DAYS + 1); // the shared point plus one per day
  expect(p[p.length - 1].date).toBe("2026-12-07");
});

test("continues the trailing daily rate, compounded", () => {
  // +10,000 on 300,000 over 7 days => daily rate (310/300)^(1/7) - 1.
  const history = [
    { date: "2026-09-01", value_rupees: 300_000 },
    { date: "2026-09-08", value_rupees: 310_000 },
  ];
  const daily = Math.pow(310_000 / 300_000, 1 / 7) - 1;
  const p = projectEquity(history, 7);
  expect(p[7].value_rupees).toBeCloseTo(310_000 * Math.pow(1 + daily, 7), 6);
  // Seven more days at the rate that produced 310k from 300k lands on 320.3k.
  expect(p[7].value_rupees).toBeCloseTo(320_333.33, 0);
});

test("a losing curve projects downward", () => {
  const p = projectEquity(
    [
      { date: "2026-09-01", value_rupees: 300_000 },
      { date: "2026-09-08", value_rupees: 290_000 },
    ],
    7,
  );
  expect(p[7].value_rupees).toBeLessThan(290_000);
});

test("flat when a value is zero or negative rather than returning NaN", () => {
  // (−x/y)^(1/n) is NaN, which would render as a broken line, so flatline.
  const p = projectEquity(
    [
      { date: "2026-09-01", value_rupees: 0 },
      { date: "2026-09-08", value_rupees: 310_000 },
    ],
    3,
  );
  expect(p.map((x) => x.value_rupees)).toEqual([310_000, 310_000, 310_000, 310_000]);
});

test("same-day endpoints do not divide by zero", () => {
  const p = projectEquity(
    [
      { date: "2026-09-08", value_rupees: 300_000 },
      { date: "2026-09-08", value_rupees: 306_000 },
    ],
    2,
  );
  // spanDays floors at 1, so the whole 2% move is treated as one day's rate.
  expect(p[1].value_rupees).toBeCloseTo(306_000 * 1.02, 6);
  expect(Number.isFinite(p[2].value_rupees)).toBe(true);
});
