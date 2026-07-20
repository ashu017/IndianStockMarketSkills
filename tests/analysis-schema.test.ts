import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { test, expect } from "vitest";

test("analysis table has verdict and confidence columns", () => {
  const db = new Database(":memory:");
  db.exec(readFileSync("db/schema.sql", "utf8"));
  const cols = (db.prepare("PRAGMA table_info(analysis)").all() as { name: string }[]).map((c) => c.name);
  expect(cols).toContain("verdict");
  expect(cols).toContain("confidence");
});
