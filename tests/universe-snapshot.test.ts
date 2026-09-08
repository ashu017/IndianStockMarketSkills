import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { test, expect } from "vitest";
import { loadUniverseAsOf } from "@/lib/universe-snapshot";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync("db/schema.sql", "utf8"));
  return db;
}

function insertRow(
  db: Database.Database,
  args: {
    date: string;
    symbol: string;
    exchange?: string;
    isin?: string | null;
    sector?: string | null;
    index_name?: string | null;
    in_screener?: 0 | 1;
    mcap_rs_cr?: number | null;
  },
): void {
  db.prepare(
    `INSERT INTO universe_snapshot
       (snapshot_date, symbol, exchange, isin, sector, index_name, in_screener, mcap_rs_cr)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.date,
    args.symbol,
    args.exchange ?? "NSE",
    args.isin ?? null,
    args.sector ?? null,
    args.index_name ?? null,
    args.in_screener ?? 0,
    args.mcap_rs_cr ?? null,
  );
}

test("empty DB: loadUniverseAsOf returns []", () => {
  const db = freshDb();
  expect(loadUniverseAsOf(db, "2026-01-01")).toEqual([]);
});

test("exact-date snapshot: returns all rows for that date", () => {
  const db = freshDb();
  insertRow(db, { date: "2026-07-28", symbol: "RELIANCE", index_name: "NIFTY 500" });
  insertRow(db, { date: "2026-07-28", symbol: "TCS", index_name: "NIFTY 500" });
  insertRow(db, { date: "2026-07-28", symbol: "INFY", index_name: "NIFTY 500" });
  const rows = loadUniverseAsOf(db, "2026-07-28");
  expect(rows).toHaveLength(3);
  expect(rows.map((r) => r.symbol).sort()).toEqual(["INFY", "RELIANCE", "TCS"]);
});

test("no snapshot for requested date: returns closest PRIOR date's rows", () => {
  const db = freshDb();
  insertRow(db, { date: "2026-07-28", symbol: "RELIANCE" });
  insertRow(db, { date: "2026-07-28", symbol: "TCS" });
  const rows = loadUniverseAsOf(db, "2026-07-30");
  expect(rows).toHaveLength(2);
  expect(rows.map((r) => r.symbol).sort()).toEqual(["RELIANCE", "TCS"]);
});

test("requested date precedes any snapshot: returns []", () => {
  const db = freshDb();
  insertRow(db, { date: "2026-07-28", symbol: "RELIANCE" });
  expect(loadUniverseAsOf(db, "2026-07-27")).toEqual([]);
});

test("in_screener=1 round-trips as boolean true; 0 as false", () => {
  const db = freshDb();
  insertRow(db, {
    date: "2026-07-28",
    symbol: "GLENMARK",
    in_screener: 1,
    mcap_rs_cr: 62229.49,
    sector: "Pharma",
  });
  insertRow(db, {
    date: "2026-07-28",
    symbol: "IDEA",
    in_screener: 0,
  });
  const rows = loadUniverseAsOf(db, "2026-07-28");
  const glenmark = rows.find((r) => r.symbol === "GLENMARK")!;
  const idea = rows.find((r) => r.symbol === "IDEA")!;
  expect(glenmark.in_screener).toBe(true);
  expect(glenmark.mcap_rs_cr).toBeCloseTo(62229.49);
  expect(glenmark.sector).toBe("Pharma");
  expect(idea.in_screener).toBe(false);
  expect(idea.mcap_rs_cr).toBeNull();
});

