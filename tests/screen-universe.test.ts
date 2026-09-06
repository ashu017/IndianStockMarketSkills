import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { test, expect } from "vitest";
import { loadScreenUniverse } from "@/lib/screen-universe";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync("db/schema.sql", "utf8"));
  return db;
}

function insertMembership(
  db: Database.Database,
  args: {
    index_name: string;
    symbol: string;
    exchange?: string;
    isin?: string;
    instrument_token?: number;
    sector?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO index_universe
       (index_name, symbol, exchange, isin, tradingsymbol, instrument_token, company, sector, as_of_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.index_name,
    args.symbol,
    args.exchange ?? "NSE",
    args.isin ?? `INE${args.symbol}01`,
    args.symbol,
    args.instrument_token ?? 100,
    args.symbol,
    args.sector === undefined ? "Healthcare" : args.sector,
    "2026-09-01",
  );
}

/**
 * The real-world shape that caused the 2026-09-01 duplicate-signal bug: a stock
 * present in both a named index and the catch-all NSE-ALL sweep, where the
 * NSE-ALL row carries a placeholder isin and an empty sector.
 */
function insertDualMembership(db: Database.Database, symbol: string): void {
  // The placeholder row goes in FIRST deliberately. Insert the good row first and
  // SQLite tends to return it first anyway, so the "keeps the real sector/isin"
  // assertions below would pass even without the ORDER BY that actually earns
  // them — they would be testing insertion luck, not the query. Verified by
  // mutation: with this order those tests fail against the pre-fix query.
  insertMembership(db, {
    index_name: "NSE-ALL",
    symbol,
    isin: `SYM-${symbol}`,
    instrument_token: 999937,
    sector: "",
  });
  insertMembership(db, {
    index_name: "NIFTY 500",
    symbol,
    isin: `INE${symbol}01`,
    instrument_token: 999937,
    sector: "Healthcare",
  });
}

test("empty symbol list short-circuits to []", () => {
  const db = freshDb();
  insertMembership(db, { index_name: "NIFTY 500", symbol: "CAPLIPOINT" });
  expect(loadScreenUniverse(db, [])).toEqual([]);
});

test("a symbol with no index_universe row is dropped (no OHLC for it)", () => {
  const db = freshDb();
  insertMembership(db, { index_name: "NIFTY 500", symbol: "CAPLIPOINT" });
  const rows = loadScreenUniverse(db, ["CAPLIPOINT", "VMARCINDIA"]);
  expect(rows.map((r) => r.symbol)).toEqual(["CAPLIPOINT"]);
});

test("single membership: returned as-is", () => {
  const db = freshDb();
  insertMembership(db, { index_name: "NIFTY 500", symbol: "CAPLIPOINT", sector: "Healthcare" });
  expect(loadScreenUniverse(db, ["CAPLIPOINT"])).toEqual([
    {
      symbol: "CAPLIPOINT",
      exchange: "NSE",
      isin: "INECAPLIPOINT01",
      instrument_token: 100,
      sector: "Healthcare",
    },
  ]);
});

// ─── the regression this module exists for ───────────────────────────────────

test("REGRESSION: dual index membership yields ONE row, not two", () => {
  const db = freshDb();
  insertDualMembership(db, "CAPLIPOINT");
  const rows = loadScreenUniverse(db, ["CAPLIPOINT"]);
  expect(rows).toHaveLength(1);
});

test("REGRESSION: the surviving row keeps the real sector, not NSE-ALL's empty one", () => {
  const db = freshDb();
  insertDualMembership(db, "CAPLIPOINT");
  const [row] = loadScreenUniverse(db, ["CAPLIPOINT"]);
  // Not cosmetic: SECTOR_DEMEAN=1 demeans momentum within sector, so an empty
  // sector here silently changes the ranking.
  expect(row.sector).toBe("Healthcare");
});

test("REGRESSION: the surviving row keeps the real isin, not the SYM- placeholder", () => {
  const db = freshDb();
  insertDualMembership(db, "CAPLIPOINT");
  const [row] = loadScreenUniverse(db, ["CAPLIPOINT"]);
  expect(row.isin).toBe("INECAPLIPOINT01");
  expect(row.isin).not.toMatch(/^SYM-/);
});

test("REGRESSION: scannable count equals screened count, not a multiple of it", () => {
  const db = freshDb();
  // The observed failure: 38 screened symbols became 61 rows because 23 of them
  // had two memberships. Same shape, smaller: 4 screened, 3 with duplicates.
  const dual = ["CAPLIPOINT", "DIVISLAB", "GLENMARK"];
  for (const s of dual) insertDualMembership(db, s);
  insertMembership(db, { index_name: "NIFTY 500", symbol: "OFSS", sector: "IT" });
  const symbols = [...dual, "OFSS"];

  const rows = loadScreenUniverse(db, symbols);
  expect(rows).toHaveLength(symbols.length);
  expect(new Set(rows.map((r) => r.symbol)).size).toBe(symbols.length);
  expect(rows.every((r) => !r.isin.startsWith("SYM-"))).toBe(true);
});

test("three memberships collapse to one just as two do", () => {
  const db = freshDb();
  insertDualMembership(db, "DIVISLAB");
  insertMembership(db, {
    index_name: "NIFTY 100",
    symbol: "DIVISLAB",
    isin: "INEDIVISLAB01",
    sector: "Healthcare",
  });
  expect(loadScreenUniverse(db, ["DIVISLAB"])).toHaveLength(1);
});

test("a sector of NULL is treated as missing, same as empty string", () => {
  const db = freshDb();
  insertMembership(db, {
    index_name: "NSE-ALL",
    symbol: "EMMVEE",
    isin: "SYM-EMMVEE",
    sector: null,
  });
  insertMembership(db, {
    index_name: "NIFTY 500",
    symbol: "EMMVEE",
    isin: "INEEMMVEE01",
    sector: "Energy",
  });
  const [row] = loadScreenUniverse(db, ["EMMVEE"]);
  expect(row.sector).toBe("Energy");
});

test("a stock whose ONLY row is the NSE-ALL placeholder is still scannable", () => {
  const db = freshDb();
  // Dropping these would silently shrink the universe: the placeholder row is
  // the only price context some screened small-caps have.
  insertMembership(db, {
    index_name: "NSE-ALL",
    symbol: "CPPLUS",
    isin: "SYM-CPPLUS",
    sector: "",
  });
  const rows = loadScreenUniverse(db, ["CPPLUS"]);
  expect(rows).toHaveLength(1);
  expect(rows[0].symbol).toBe("CPPLUS");
});

test("the same symbol on two exchanges is NOT collapsed", () => {
  const db = freshDb();
  // De-dup is keyed on (symbol, exchange) because that is what the rest of the
  // pipeline keys on — an NSE and a BSE listing are two tradable instruments.
  insertMembership(db, {
    index_name: "NIFTY 500",
    symbol: "DIVISLAB",
    exchange: "NSE",
    instrument_token: 1,
  });
  insertMembership(db, {
    index_name: "NIFTY 500",
    symbol: "DIVISLAB",
    exchange: "BSE",
    instrument_token: 2,
  });
  const rows = loadScreenUniverse(db, ["DIVISLAB"]);
  expect(rows).toHaveLength(2);
  expect(rows.map((r) => r.exchange).sort()).toEqual(["BSE", "NSE"]);
});

test("AD-HOC memberships from refresh-single-stock still count", () => {
  const db = freshDb();
  insertMembership(db, { index_name: "AD-HOC", symbol: "SHAILY", sector: "Healthcare" });
  expect(loadScreenUniverse(db, ["SHAILY"]).map((r) => r.symbol)).toEqual(["SHAILY"]);
});

test("output is ordered by symbol so digests are stable across runs", () => {
  const db = freshDb();
  for (const s of ["OFSS", "CAPLIPOINT", "DIVISLAB"]) {
    insertMembership(db, { index_name: "NIFTY 500", symbol: s });
  }
  const rows = loadScreenUniverse(db, ["OFSS", "CAPLIPOINT", "DIVISLAB"]);
  expect(rows.map((r) => r.symbol)).toEqual(["CAPLIPOINT", "DIVISLAB", "OFSS"]);
});

test("duplicate symbols in the INPUT list do not duplicate output rows", () => {
  const db = freshDb();
  insertMembership(db, { index_name: "NIFTY 500", symbol: "CAPLIPOINT" });
  expect(loadScreenUniverse(db, ["CAPLIPOINT", "CAPLIPOINT"])).toHaveLength(1);
});
