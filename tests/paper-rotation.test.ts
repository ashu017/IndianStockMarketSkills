import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { test, expect, beforeEach, describe } from "vitest";
import { ensureAccount, openPaperTrade } from "@/lib/paper";

/**
 * Rotation logic (qlib TopkDropoutStrategy pattern): when the concurrent cap is
 * hit, merge eligible incumbents + the incoming candidate, sort DESC by
 * mom_score, and keep the top-N (N = eligible count). If the candidate lands in
 * the top-N, evict the incumbent that got dropped (by construction the weakest
 * eligible one). Eligibility guardrails still apply:
 *   - Incumbent has bars_held ≥ 5 (grace period)
 *   - Incumbent is NOT at breakeven (current_stop < entry)
 *   - Incumbent's mom_score must be known
 * These tests build a paper account manually (max_concurrent_trades = 2 for
 * brevity) and exercise every branch.
 */

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync("db/schema.sql", "utf8"));
  return db;
}

function seedUniverse(db: Database.Database): void {
  const insU = db.prepare(
    `INSERT OR IGNORE INTO index_universe(index_name, symbol, exchange, isin, instrument_token, sector)
     VALUES(?, ?, ?, ?, ?, ?)`,
  );
  insU.run("TEST", "AAA", "NSE", "INE000A00000", 111, "Test");
  insU.run("TEST", "BBB", "NSE", "INE000B00000", 222, "Test");
  insU.run("TEST", "CCC", "NSE", "INE000C00000", 333, "Test");
  // Populate one OHLC bar per token so latestClosePaise() can compute exit.
  const insBar = db.prepare(
    `INSERT OR IGNORE INTO ohlc_daily(instrument_token, trade_date, open, high, low, close, volume)
     VALUES(?, '2026-07-27', ?, ?, ?, ?, 1000000)`,
  );
  insBar.run(111, 100000, 105000, 99000, 102000);
  insBar.run(222, 200000, 205000, 199000, 201000);
  insBar.run(333, 300000, 305000, 299000, 300000);
}

function makeAccount(db: Database.Database, maxConcurrent = 2): void {
  ensureAccount(db, "local", 100_000_00); // Rs 1,00,000 starting
  db.prepare(`UPDATE paper_account SET max_concurrent_trades=? WHERE user_id='local'`).run(maxConcurrent);
}

function openTrade(
  db: Database.Database,
  symbol: string,
  opts: {
    entry_paise?: number;
    stop_paise?: number;
    target_paise?: number;
    bars_held?: number;
    current_stop_paise?: number; // to force breakeven
  } = {},
): number {
  const entry = opts.entry_paise ?? 100_00;
  const stop = opts.stop_paise ?? 93_00;
  const target = opts.target_paise ?? 121_00;
  const currentStop = opts.current_stop_paise ?? stop;
  const bars = opts.bars_held ?? 10;
  const info = db
    .prepare(
      `INSERT INTO paper_trades(user_id, symbol, exchange, entry_signal_scan_date, entry_date, entry_time,
                                entry_paise, qty, capital_committed_paise, initial_stop_paise, current_stop_paise,
                                target_paise, atr14_paise, status, bars_held)
       VALUES('local', ?, 'NSE', '2026-07-15', '2026-07-15', '2026-07-15T04:30:00Z',
              ?, 10, ?, ?, ?, ?, 300, 'open', ?)`,
    )
    .run(symbol, entry, entry * 10, stop, currentStop, target, bars);
  return info.lastInsertRowid as number;
}

describe("rotation logic in openPaperTrade", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    seedUniverse(db);
    makeAccount(db, 2);
  });

  test("(a) at cap, incoming below all eligible incumbents → NO rotation", () => {
    openTrade(db, "AAA");
    openTrade(db, "BBB");
    const r = openPaperTrade(db, {
      symbol: "CCC",
      exchange: "NSE",
      entry_signal_scan_date: "2026-07-28",
      scan_date: "2026-07-28",
      scan_time: "2026-07-28T04:30:00Z",
      entry_paise: 300_00,
      stop_paise: 279_00,
      target_paise: 363_00,
      atr14_paise: 500,
      mom_score: 0.90,                       // below both incumbents
      open_mom_scores: new Map([["AAA", 1.00], ["BBB", 1.05]]),
    });
    expect(r.opened).toBe(false);
    expect(r.reason).toContain("concurrent_cap");
    expect(r.rotation).toBeUndefined();
  });

  test("(b) at cap, incoming above weakest eligible incumbent → ROTATE", () => {
    const aaaId = openTrade(db, "AAA");
    openTrade(db, "BBB");
    const r = openPaperTrade(db, {
      symbol: "CCC",
      exchange: "NSE",
      entry_signal_scan_date: "2026-07-28",
      scan_date: "2026-07-28",
      scan_time: "2026-07-28T04:30:00Z",
      entry_paise: 300_00,
      stop_paise: 279_00,
      target_paise: 363_00,
      atr14_paise: 500,
      // Merged DESC = [BBB 1.30, CCC 1.10, AAA 1.00]; top-2 = {BBB, CCC}; AAA
      // is displaced. Incoming is only barely above the weakest, but the new
      // ranking-based logic still rotates.
      mom_score: 1.10,
      open_mom_scores: new Map([["AAA", 1.00], ["BBB", 1.30]]),
    });
    expect(r.opened).toBe(true);
    expect(r.rotation).toBeDefined();
    expect(r.rotation!.out_symbol).toBe("AAA");
    expect(r.rotation!.in_symbol).toBe("CCC");
    // The rotated-out trade is now closed with status='rotated_out'.
    const closed = db
      .prepare(`SELECT status, exit_reason FROM paper_trades WHERE id=?`)
      .get(aaaId) as { status: string; exit_reason: string };
    expect(closed.status).toBe("rotated_out");
    expect(closed.exit_reason).toMatch(/rotated_out for CCC/);
  });

  test("(c) worst incumbent moved to breakeven → NOT ELIGIBLE", () => {
    // AAA has current_stop=entry (breakeven), BBB is the only eligible incumbent.
    openTrade(db, "AAA", { entry_paise: 100_00, stop_paise: 93_00, current_stop_paise: 100_00 });
    openTrade(db, "BBB", { entry_paise: 200_00, stop_paise: 186_00 });
    const r = openPaperTrade(db, {
      symbol: "CCC",
      exchange: "NSE",
      entry_signal_scan_date: "2026-07-28",
      scan_date: "2026-07-28",
      scan_time: "2026-07-28T04:30:00Z",
      entry_paise: 300_00,
      stop_paise: 279_00,
      target_paise: 363_00,
      atr14_paise: 500,
      // AAA (mom 1.00) at breakeven → skipped from eligible set.
      // Only BBB (2.00) is eligible; incoming 1.90 is below BBB → merged top-1
      // is {BBB}, candidate not in top-N → no rotation.
      mom_score: 1.90,
      open_mom_scores: new Map([["AAA", 1.00], ["BBB", 2.00]]),
    });
    expect(r.opened).toBe(false);
    expect(r.reason).toContain("concurrent_cap");
  });

  test("(d) worst incumbent has bars_held < 5 → NOT ELIGIBLE", () => {
    // AAA is the weakest but has only 3 bars — protected. BBB is the fallback.
    openTrade(db, "AAA", { bars_held: 3 });
    openTrade(db, "BBB", { bars_held: 10 });
    const r = openPaperTrade(db, {
      symbol: "CCC",
      exchange: "NSE",
      entry_signal_scan_date: "2026-07-28",
      scan_date: "2026-07-28",
      scan_time: "2026-07-28T04:30:00Z",
      entry_paise: 300_00,
      stop_paise: 279_00,
      target_paise: 363_00,
      atr14_paise: 500,
      // Only BBB is eligible (AAA is inside grace period). BBB's mom is 2.00;
      // incoming 1.90 is below BBB → merged top-1 = {BBB}, candidate excluded.
      mom_score: 1.90,
      open_mom_scores: new Map([["AAA", 1.00], ["BBB", 2.00]]),
    });
    expect(r.opened).toBe(false);
    expect(r.reason).toContain("concurrent_cap");
  });

  test("(e) below cap → normal open path, no rotation attempted", () => {
    openTrade(db, "AAA");
    // Only 1 open, cap is 2 → new signal goes straight in.
    const r = openPaperTrade(db, {
      symbol: "BBB",
      exchange: "NSE",
      entry_signal_scan_date: "2026-07-28",
      scan_date: "2026-07-28",
      scan_time: "2026-07-28T04:30:00Z",
      entry_paise: 200_00,
      stop_paise: 186_00,
      target_paise: 242_00,
      atr14_paise: 500,
      mom_score: 5.0,                        // huge score — no rotation attempted anyway
      open_mom_scores: new Map([["AAA", 1.00]]),
    });
    expect(r.opened).toBe(true);
    expect(r.rotation).toBeUndefined();
  });
});
