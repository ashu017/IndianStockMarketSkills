import { test, expect } from "vitest";
import { nextExpiryIso, loginUrl } from "@/lib/ingest/kite-client";

test("loginUrl includes api_key and v=3", () => {
  expect(loginUrl("abc123")).toBe(
    "https://kite.zerodha.com/connect/login?v=3&api_key=abc123",
  );
});

test("expiry is the next 6 AM IST, expressed as UTC (00:30Z)", () => {
  // 2026-07-13 10:00 IST  → 2026-07-13 04:30 UTC. Past 6 AM IST → expiry tomorrow 6 AM IST.
  const now = Date.parse("2026-07-13T04:30:00Z");
  // 6 AM IST on the 14th = 00:30 UTC on the 14th.
  expect(nextExpiryIso(now)).toBe("2026-07-14T00:30:00.000Z");
});

test("before 6 AM IST, expiry is the same day's 6 AM IST", () => {
  // 2026-07-13 03:00 IST = 2026-07-12 21:30 UTC. Before 6 AM IST → expiry today 6 AM IST.
  const now = Date.parse("2026-07-12T21:30:00Z");
  expect(nextExpiryIso(now)).toBe("2026-07-13T00:30:00.000Z");
});
