import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { test, expect, beforeEach, describe } from "vitest";
import { ensureAccount, openPaperTrade, updateOpenPaperTrades } from "@/lib/paper";
import type { ExitRuleId } from "@/lib/exit-rules";

/**
 * Replay idempotence for updateOpenPaperTrades().
 *
 * updateOpenPaperTrades() re-walks every bar since entry on each invocation, and
 * the scanner calls it up to 3× per trading day. That only yields the same answer
 * if the walk restarts from the state entry began with — the INITIAL stop.
 *
 * The regression this pins down: seeding the walk with the stored current stop
 * applied an already-ratcheted stop to bars that predate the ratchet. A trade
 * whose stop moved to breakeven on day 6 was, on the next run, tested against the
 * breakeven stop starting from day 1 and exited at the first day whose low dipped
 * below entry — booking a fabricated Rs 0 scratch on a date when the stop was
 * still well below. Two live trades (FIEMIND, SHAILY) were closed this way,
 * hiding ~Rs 5,900 of open risk and overstating the account's return.
 *
 * Every test pins its exit rule EXPLICITLY. The v1 group's behaviour (breakeven
 * at 1R, no partials) is still live for the grandfathered positions opened before
 * 2026-08-31, so those assertions are load-bearing, not history — and pinning
 * also stops the whole file quietly re-pointing the next time the current rule
 * changes.
 */

const TOKEN = 111;
const WIDE_TOKEN = 222;

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync("db/schema.sql", "utf8"));
  const ins = db.prepare(
    `INSERT INTO index_universe(index_name, symbol, exchange, isin, tradingsymbol,
                                instrument_token, sector, as_of_date)
     VALUES('TEST', ?, 'NSE', ?, ?, ?, 'Test', '2026-07-28')`,
  );
  ins.run("AAA", "INE000A00000", "AAA", TOKEN);
  ins.run("WIDE", "INE000A00001", "WIDE", WIDE_TOKEN);
  ensureAccount(db, "local", 100_000_00);
  // Pin sizing rather than inherit DEFAULT_SIZING. These tests assert exact
  // share counts and paise amounts against hand-built bars, and they need a qty
  // that halves cleanly at a rung — so an account-level retune must not move the
  // quantities out from under them (it did once: risk 1% -> 0.5% silently made
  // every qty 5 instead of 10 and failed all ten tests at the helper's guard).
  db.prepare(
    `UPDATE paper_account SET risk_pct_per_trade=1.0, max_position_pct=25.0
      WHERE user_id='local'`,
  ).run();
  return db;
}

/** Append one daily bar. Prices in paise. */
function bar(
  db: Database.Database,
  date: string,
  low: number,
  high: number,
  close: number,
  token = TOKEN,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO ohlc_daily(instrument_token, trade_date, open, high, low, close,
                                       volume, fetched_at)
     VALUES(?, ?, ?, ?, ?, ?, 1000000, '2026-07-28T00:00:00.000Z')`,
  ).run(token, date, close, high, low, close);
}

/**
 * Entry 1000.00, initial stop 900.00 (risk 100.00), target 1300.00.
 * So 1R = 1100.00 and 1.5R = 1150.00. Sizing: 1% of Rs 1,00,000 equity is
 * Rs 1,000 of risk at Rs 100/share → qty 10, which halves cleanly at a rung.
 */
function openTrade(db: Database.Database, exitRule: ExitRuleId): void {
  bar(db, "2026-07-28", 99000, 101000, 100000);
  const r = openPaperTrade(db, {
    symbol: "AAA",
    exchange: "NSE",
    entry_signal_scan_date: "2026-07-28",
    scan_date: "2026-07-28",
    scan_time: "2026-07-28T04:00:00.000Z",
    entry_paise: 100000,
    stop_paise: 90000,
    target_paise: 130000,
    atr14_paise: 5000,
    mom_score: 1.5,
    exit_rule: exitRule,
  });
  expect(r.opened).toBe(true);
  expect(r.qty).toBe(10);
}

function trade(db: Database.Database, symbol = "AAA") {
  return db
    .prepare(
      `SELECT status, exit_date, exit_paise, exit_reason, realized_pnl_paise, current_stop_paise,
              qty, qty_open, partial_qty, partial_exit_date, partial_exit_paise,
              partial_pnl_paise, bars_held
       FROM paper_trades WHERE symbol=?`,
    )
    .get(symbol) as {
    status: string;
    exit_date: string | null;
    exit_paise: number | null;
    exit_reason: string | null;
    realized_pnl_paise: number | null;
    current_stop_paise: number;
    qty: number;
    qty_open: number | null;
    partial_qty: number;
    partial_exit_date: string | null;
    partial_exit_paise: number | null;
    partial_pnl_paise: number;
    bars_held: number;
  };
}

function cash(db: Database.Database): number {
  return (db
    .prepare(`SELECT current_cash_paise AS c FROM paper_account WHERE user_id='local'`)
    .get() as { c: number }).c;
}

let db: Database.Database;
beforeEach(() => {
  db = freshDb();
});

describe("v1 (grandfathered) rule — breakeven at 1R, no partials", () => {
  beforeEach(() => openTrade(db, "v1_atr2_3r"));

  test("a dip below entry BEFORE the breakeven ratchet does not close the trade", () => {
    // Day 1 dips to 950 — below entry (1000) but above the initial stop (900).
    // Nothing should trigger: the stop is still 900 on this date.
    bar(db, "2026-07-29", 95000, 100500, 96000);
    updateOpenPaperTrades(db);
    expect(trade(db).status).toBe("open");

    // Day 2 closes at 1150 (> 1R = 1100) so the stop legitimately moves to entry.
    bar(db, "2026-07-30", 114000, 116000, 115000);
    updateOpenPaperTrades(db);
    let t = trade(db);
    expect(t.status).toBe("open");
    expect(t.current_stop_paise).toBe(100000); // ratcheted to entry
    expect(t.partial_qty).toBe(0); // v1 never books a partial

    // Re-running must NOT reach back and exit on 07-29's dip. That date's low was
    // never below the stop that applied then — this is the exact regression.
    updateOpenPaperTrades(db);
    t = trade(db);
    expect(t.status).toBe("open");
    expect(t.exit_date).toBeNull();
  });

  test("repeated runs on unchanged bars are idempotent", () => {
    bar(db, "2026-07-29", 95000, 100500, 96000);
    bar(db, "2026-07-30", 114000, 116000, 115000); // ratchets stop to entry
    bar(db, "2026-07-31", 113000, 118000, 117000);

    updateOpenPaperTrades(db);
    const first = trade(db);
    const firstCash = cash(db);
    for (let i = 0; i < 5; i++) updateOpenPaperTrades(db);
    expect(trade(db)).toEqual(first);
    expect(cash(db)).toBe(firstCash);
  });

  test("breakeven stop still closes the trade on a LATER dip below entry", () => {
    bar(db, "2026-07-29", 114000, 116000, 115000); // ratchet to entry
    updateOpenPaperTrades(db);
    expect(trade(db).current_stop_paise).toBe(100000);

    // A subsequent bar dipping to 980 is below the breakeven stop — a real exit
    // at entry, booking a genuine Rs 0 scratch.
    bar(db, "2026-07-30", 98000, 101000, 99000);
    updateOpenPaperTrades(db);
    const t = trade(db);
    expect(t.status).toBe("stopped");
    expect(t.exit_date).toBe("2026-07-30");
    expect(t.exit_paise).toBe(100000);
    expect(t.realized_pnl_paise).toBe(0);
  });

  test("a genuine stop-out books the full loss at the initial stop", () => {
    bar(db, "2026-07-29", 89000, 99000, 90500); // low 890 < initial stop 900
    updateOpenPaperTrades(db);
    const t = trade(db);
    expect(t.status).toBe("stopped");
    expect(t.exit_paise).toBe(90000);
    // qty × (90000 − 100000); loss must be strictly negative, never a scratch.
    expect(t.realized_pnl_paise).toBeLessThan(0);
  });

  test("the 60-bar cap has not fired by bar 30", () => {
    // Guards the boundary from the other side: a v1 trade must NOT inherit v2's
    // 25-bar cap, which is the failure mode grandfathering exists to prevent.
    for (let i = 1; i <= 30; i++) {
      bar(db, `2026-09-${String(i).padStart(2, "0")}`, 99500, 100500, 100000);
    }
    updateOpenPaperTrades(db);
    const t = trade(db);
    expect(t.status).toBe("open");
    expect(t.bars_held).toBe(30);
  });
});

describe("v2 (current) rule — half booked at 1.5R, then stop to entry", () => {
  beforeEach(() => openTrade(db, "v2_scaleout"));

  test("the rung books half the position, moves the stop to entry, and returns cash", () => {
    const before = cash(db);
    // High 1160 clears the 1.5R rung at 1150. Close 1155 stays under the 1300
    // target, so the runner survives the bar.
    bar(db, "2026-07-29", 114000, 116000, 115500);
    updateOpenPaperTrades(db);
    const t = trade(db);
    expect(t.status).toBe("open");
    expect(t.partial_qty).toBe(5); // half of 10
    expect(t.qty_open).toBe(5);
    expect(t.partial_exit_date).toBe("2026-07-29");
    expect(t.partial_exit_paise).toBe(115000); // the rung level, not the bar high
    expect(t.partial_pnl_paise).toBe((115000 - 100000) * 5);
    // Stop to entry as soon as the rung fills — no 1R breakeven under v2.
    expect(t.current_stop_paise).toBe(100000);
    // The 5 sold shares came back as cash at the rung price.
    expect(cash(db) - before).toBe(115000 * 5);
  });

  test("re-running after a filled rung credits the cash exactly once", () => {
    bar(db, "2026-07-29", 114000, 116000, 115500);
    updateOpenPaperTrades(db);
    const afterFirst = trade(db);
    const afterFirstCash = cash(db);

    // The replay re-derives the partial from scratch every fire, so this is the
    // run where a gross (rather than delta) credit would double-count.
    for (let i = 0; i < 4; i++) updateOpenPaperTrades(db);
    expect(trade(db)).toEqual(afterFirst);
    expect(cash(db)).toBe(afterFirstCash);
  });

  test("a bar that clears the rung then falls back to entry stops the runner out on that same bar", () => {
    // Runs up through 1150 and back to 995. Without the same-bar re-check, the
    // rung would book and the remainder would ride to the next bar for free —
    // flattering the exact mechanic the win-rate gain comes from.
    bar(db, "2026-07-29", 99500, 116000, 100200);
    updateOpenPaperTrades(db);
    const t = trade(db);
    expect(t.status).toBe("stopped");
    expect(t.exit_paise).toBe(100000);
    expect(t.partial_qty).toBe(5);
    // Half booked at +15% of risk×… , the other half scratched at entry.
    expect(t.realized_pnl_paise).toBe((115000 - 100000) * 5);
  });

  test("the 25-bar time cap closes the remainder on the bar it is due", () => {
    bar(db, "2026-07-29", 114000, 116000, 115500); // rung fills on bar 1
    // Bars 2..25 drift sideways above the breakeven stop and below the target.
    for (let i = 2; i <= 25; i++) {
      bar(db, `2026-08-${String(i).padStart(2, "0")}`, 100500, 102000, 101000);
    }
    updateOpenPaperTrades(db);
    const t = trade(db);
    expect(t.status).toBe("time_exit");
    expect(t.bars_held).toBe(25);
    expect(t.exit_date).toBe("2026-08-25");
    expect(t.exit_paise).toBe(101000); // that bar's close
    // Realized spans both legs, so closed-trade stats need no knowledge of the split.
    expect(t.realized_pnl_paise).toBe((115000 - 100000) * 5 + (101000 - 100000) * 5);
  });

  test("a position too small to split exits IN FULL at the rung", () => {
    // Entry 1000, stop 100 → risk 900/share, so the Rs 1,000 risk budget buys
    // exactly 1 share and floor(1 × 0.5) is 0 shares at the rung. Skipping the
    // rung would leave the trade running with no breakeven protection at all.
    bar(db, "2026-07-28", 99000, 101000, 100000, WIDE_TOKEN);
    const r = openPaperTrade(db, {
      symbol: "WIDE",
      exchange: "NSE",
      entry_signal_scan_date: "2026-07-28",
      scan_date: "2026-07-28",
      scan_time: "2026-07-28T04:00:00.000Z",
      entry_paise: 100000,
      stop_paise: 10000,
      target_paise: 370000,
      atr14_paise: 5000,
      mom_score: 1.5,
      exit_rule: "v2_scaleout",
    });
    expect(r.opened).toBe(true);
    expect(r.qty).toBe(1);

    // 1.5R = 100000 + 1.5×90000 = 235000.
    bar(db, "2026-07-29", 99500, 240000, 236000, WIDE_TOKEN);
    updateOpenPaperTrades(db);
    const t = trade(db, "WIDE");
    expect(t.status).toBe("target_hit");
    expect(t.exit_paise).toBe(235000);
    expect(t.exit_reason).toMatch(/too small to split/);
    expect(t.partial_qty).toBe(0); // nothing was split off
    expect(t.qty_open).toBe(0);
    expect(t.realized_pnl_paise).toBe(235000 - 100000);
  });
});
