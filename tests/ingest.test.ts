import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { test, expect } from "vitest";
import { writeSnapshot, type SnapshotPayload } from "@/lib/ingest/writer";
import { fetchFundamentals } from "@/lib/ingest/screener";
import {
  normalizeKiteHoldings,
  type RawKiteHolding,
} from "@/lib/ingest/kite-normalize";
import { rupeesToPrice, rupeesToPaise } from "@/lib/money";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync("db/schema.sql", "utf8"));
  return db;
}

const payload: SnapshotPayload = {
  userId: "u",
  snapshotDate: "2026-07-06",
  meta: [
    {
      symbol: "TCS",
      exchange: "NSE",
      isin: "INE467B01029",
      company: "TCS",
      sector: "IT",
    },
  ],
  holdings: [
    {
      symbol: "TCS",
      exchange: "NSE",
      qty: 15,
      avg_price: 37200000,
      ltp: 384520,
      close_price: 386200,
    },
  ],
  totals: {
    current_value: 1,
    invested: 1,
    total_pnl: 0,
    day_pnl: 0,
    holdings_count: 1,
    winners: 1,
    losers: 0,
  },
};

test("re-running same day overwrites, not duplicates", () => {
  const db = freshDb();
  writeSnapshot(db, payload);
  writeSnapshot(db, payload);

  const hs = db
    .prepare("SELECT COUNT(*) c FROM holding_snapshots")
    .get() as { c: number };
  const ps = db
    .prepare("SELECT COUNT(*) c FROM portfolio_snapshots")
    .get() as { c: number };
  const meta = db.prepare("SELECT COUNT(*) c FROM stock_meta").get() as {
    c: number;
  };
  expect(hs.c).toBe(1);
  expect(ps.c).toBe(1);
  expect(meta.c).toBe(1);
});

test("upsert updates changed values in place", () => {
  const db = freshDb();
  writeSnapshot(db, payload);
  writeSnapshot(db, {
    ...payload,
    holdings: [{ ...payload.holdings[0], ltp: 999999 }],
  });
  const row = db
    .prepare("SELECT ltp FROM holding_snapshots WHERE symbol='TCS'")
    .get() as { ltp: number };
  expect(row.ltp).toBe(999999);
});

test("screener returns status:failed on malformed input without throwing", async () => {
  // Empty / missing HTML → parse throws internally → degraded to 'failed'.
  await expect(fetchFundamentals("INE467B01029")).resolves.toEqual({
    status: "failed",
    data: null,
  });
  await expect(fetchFundamentals("INE467B01029", "   ")).resolves.toEqual({
    status: "failed",
    data: null,
  });
});

test("screener returns status:ok on parseable input", async () => {
  const res = await fetchFundamentals("INE467B01029", "<html>ok</html>");
  expect(res.status).toBe("ok");
  expect(res.data).not.toBeNull();
});

test("kite-normalize converts a rupee holding to correct minor units", () => {
  const raw: RawKiteHolding[] = [
    {
      tradingsymbol: "ASIANPAINT",
      exchange: "BSE",
      quantity: 5,
      average_price: 2936.31,
      last_price: 2700.0,
      close_price: 2708.1,
      isin: "INE021A01026",
    },
  ];
  const { meta, holdings } = normalizeKiteHoldings(raw);

  expect(meta).toEqual([
    {
      symbol: "ASIANPAINT",
      exchange: "BSE",
      isin: "INE021A01026",
      company: null,
      sector: null,
    },
  ]);
  expect(holdings[0]).toEqual({
    symbol: "ASIANPAINT",
    exchange: "BSE",
    qty: 5,
    avg_price: rupeesToPrice(2936.31), // 29363100
    ltp: rupeesToPaise(2700.0), // 270000
    close_price: rupeesToPaise(2708.1), // 270810
  });
  // Sanity-check the exact minor-unit magnitudes.
  expect(holdings[0].avg_price).toBe(29363100);
  expect(holdings[0].ltp).toBe(270000);
  expect(holdings[0].close_price).toBe(270810);
});

test("normalized kite output round-trips through the writer", () => {
  const db = freshDb();
  const raw: RawKiteHolding[] = [
    {
      tradingsymbol: "TCS",
      exchange: "NSE",
      quantity: 15,
      average_price: 3720.0,
      last_price: 3845.2,
      close_price: 3862.0,
    },
  ];
  const { meta, holdings } = normalizeKiteHoldings(raw);
  writeSnapshot(db, {
    userId: "u",
    snapshotDate: "2026-07-06",
    meta,
    holdings,
    totals: payload.totals,
  });
  const n = db
    .prepare("SELECT COUNT(*) c FROM holding_snapshots")
    .get() as { c: number };
  expect(n.c).toBe(1);
});
