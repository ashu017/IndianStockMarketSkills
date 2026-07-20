import Database from "better-sqlite3";
import { test, expect } from "vitest";
import { addVerdictColumns } from "@/scripts/migrate-analysis-verdict";

test("adds verdict/confidence to an old analysis table, idempotently", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE analysis (isin TEXT, narrative TEXT, generated_at TEXT,
           model_version TEXT, prompt_version TEXT, UNIQUE(isin));`);
  addVerdictColumns(db);
  addVerdictColumns(db); // second run must not throw
  const cols = (db.prepare("PRAGMA table_info(analysis)").all() as { name: string }[]).map((c) => c.name);
  expect(cols).toContain("verdict");
  expect(cols).toContain("confidence");
});
