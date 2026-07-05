import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { test, expect } from "vitest";

// Verifies the portable "latest row per group" view logic directly against a
// fresh in-memory DB (the seam in lib/db reads process env / server-only, so we
// assert the view semantics the seam depends on).
test("v_holdings_current returns latest row per symbol", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync("db/schema.sql", "utf8"));
  db.prepare("INSERT INTO stock_meta(symbol,exchange,isin) VALUES('TCS','NSE','X')").run();
  const ins = db.prepare(
    "INSERT INTO holding_snapshots(user_id,snapshot_date,symbol,exchange,qty,avg_price,ltp,close_price) VALUES('u',?,?,?,?,?,?,?)",
  );
  ins.run("2026-07-05", "TCS", "NSE", 15, 37200000, 380000, 381000);
  ins.run("2026-07-06", "TCS", "NSE", 15, 37200000, 384520, 386200);

  const row = db
    .prepare("SELECT * FROM v_holdings_current WHERE user_id='u' AND symbol='TCS'")
    .get() as { snapshot_date: string; ltp: number };
  expect(row.snapshot_date).toBe("2026-07-06");
  expect(row.ltp).toBe(384520);
});
