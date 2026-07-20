import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { writeAnalysis, type AnalysisPayload } from "@/lib/ingest/analysis-writer";

function istDate(now = Date.now()): string {
  return new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);
}

function main(): void {
  const dbPath = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";
  const raw = process.env.ANALYSIS_PAYLOAD;
  if (!raw) throw new Error("ANALYSIS_PAYLOAD env is required");
  const input = JSON.parse(raw) as Omit<AnalysisPayload, "asOfDate"> & { asOfDate?: string };
  const payload: AnalysisPayload = { ...input, asOfDate: input.asOfDate ?? istDate() };

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  try {
    writeAnalysis(db, payload);
  } finally {
    db.close();
  }
  process.stdout.write(JSON.stringify({ status: "ok", isin: payload.isin, asOfDate: payload.asOfDate }) + "\n");
}

try {
  main();
} catch (err) {
  process.stdout.write(JSON.stringify({ status: "error", message: err instanceof Error ? err.message : String(err) }) + "\n");
  process.exit(1);
}
