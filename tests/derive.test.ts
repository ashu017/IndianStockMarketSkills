import { test, expect } from "vitest";
import { deriveHolding } from "@/lib/derive";

test("derives pnl and pct from minor units", () => {
  // qty 15, avg 3720 (×10000 = 37200000), ltp 3845.2 (paise = 384520), close 3862 (386200)
  const h = deriveHolding(
    { qty: 15, avg_price: 37200000, ltp: 384520, close_price: 386200 },
    100000, // total portfolio current value in rupees
  );
  expect(h.invested).toBeCloseTo(55800, 2); // 15 × 3720
  expect(h.current).toBeCloseTo(57678, 2); // 15 × 3845.2
  expect(h.pnl).toBeCloseTo(1878, 2);
  expect(h.pnlPct).toBeCloseTo(3.366, 2);
  expect(h.weight).toBeCloseTo(57.678, 2); // 57678 / 100000
});

test("zero close price yields zero day change, no NaN", () => {
  const h = deriveHolding(
    { qty: 1, avg_price: 10000, ltp: 100, close_price: 0 },
    0,
  );
  expect(h.dayChangePct).toBe(0);
  expect(h.weight).toBe(0);
});
