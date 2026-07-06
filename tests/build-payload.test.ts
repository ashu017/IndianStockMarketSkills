import { test, expect } from "vitest";
import { buildPayload } from "@/lib/ingest/build-payload";
import type { RawKiteHolding } from "@/lib/ingest/kite-normalize";

const RAW: RawKiteHolding[] = [
  {
    tradingsymbol: "TCS",
    exchange: "NSE",
    quantity: 15,
    average_price: 3720,
    last_price: 3845.2,
    close_price: 3862,
    isin: "INE467B01029",
    company_name: "Tata Consultancy Services",
    sector: "IT",
  },
  {
    tradingsymbol: "HDFCBANK",
    exchange: "NSE",
    quantity: 45,
    average_price: 1540,
    last_price: 1612.35,
    close_price: 1594.5,
  },
];

test("builds meta + holdings in minor units", () => {
  const p = buildPayload("local", RAW);
  expect(p.userId).toBe("local");
  expect(p.meta).toHaveLength(2);
  const tcs = p.holdings.find((h) => h.symbol === "TCS")!;
  expect(tcs.avg_price).toBe(37200000); // 3720 ×10000
  expect(tcs.ltp).toBe(384520); // 3845.20 ×100
  expect(tcs.close_price).toBe(386200);
});

test("computes portfolio totals in paise", () => {
  const p = buildPayload("local", RAW);
  // TCS invested 15×3720=55800; HDFC 45×1540=69300 → 125100 rupees = 12510000 paise
  expect(p.totals.invested).toBe(12510000);
  // current: TCS 15×3845.2=57678; HDFC 45×1612.35=72555.75 → 130233.75 → 13023375 paise
  expect(p.totals.current_value).toBe(13023375);
  expect(p.totals.total_pnl).toBe(13023375 - 12510000);
  expect(p.totals.holdings_count).toBe(2);
  expect(p.totals.winners).toBe(2); // both up vs avg
  expect(p.totals.losers).toBe(0);
});

test("day P&L uses ltp vs close", () => {
  const p = buildPayload("local", RAW);
  // TCS day: 15×(3845.2-3862) = -252; HDFC: 45×(1612.35-1594.5)=+803.25 → +551.25 → 55125 paise
  expect(p.totals.day_pnl).toBe(55125);
});
