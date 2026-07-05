import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { test, expect } from "vitest";

test("schema applies and enforces snapshot uniqueness", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync("db/schema.sql", "utf8"));

  db.prepare(
    "INSERT INTO stock_meta(symbol,exchange,isin) VALUES('TCS','NSE','INE467B01029')",
  ).run();

  const ins = db.prepare(
    "INSERT INTO holding_snapshots(user_id,snapshot_date,symbol,exchange,qty,avg_price,ltp,close_price) VALUES(?,?,?,?,?,?,?,?)",
  );
  ins.run("u", "2026-07-06", "TCS", "NSE", 15, 37200000, 384520, 386200);
  expect(() =>
    ins.run("u", "2026-07-06", "TCS", "NSE", 15, 37200000, 384520, 386200),
  ).toThrow();
});

test("foreign key is enforced when PRAGMA is on", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync("db/schema.sql", "utf8"));
  // No stock_meta row for ZZZ/NSE → FK violation.
  expect(() =>
    db
      .prepare(
        "INSERT INTO holding_snapshots(user_id,snapshot_date,symbol,exchange,qty,avg_price,ltp,close_price) VALUES('u','2026-07-06','ZZZ','NSE',1,1,1,1)",
      )
      .run(),
  ).toThrow();
});
