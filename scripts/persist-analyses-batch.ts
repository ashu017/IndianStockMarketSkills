import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeAnalysis, type AnalysisPayload } from "@/lib/ingest/analysis-writer";

/**
 * Bulk-persist N analysis payloads produced by a single batched fundamentals run.
 * Reads a JSON array from ANALYSES_PAYLOAD env or from --file <path>. Each element
 * is the same shape scripts/persist-analysis.ts accepts (asOfDate optional; defaults
 * to today in IST). All writes happen inside ONE SQLite transaction so a mid-batch
 * crash doesn't leave a partially-populated day.
 */

function istDate(now = Date.now()): string {
  return new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);
}

function loadInput(): unknown[] {
  const raw = process.env.ANALYSES_PAYLOAD;
  if (raw) return JSON.parse(raw);
  const fileArg = process.argv.indexOf("--file");
  if (fileArg !== -1 && process.argv[fileArg + 1]) {
    return JSON.parse(readFileSync(process.argv[fileArg + 1], "utf8"));
  }
  throw new Error("ANALYSES_PAYLOAD env or --file <path> is required");
}

function main(): void {
  const dbPath = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";
  const arr = loadInput();
  if (!Array.isArray(arr)) throw new Error("Input must be a JSON array of AnalysisPayload");

  const today = istDate();
  const payloads: AnalysisPayload[] = arr.map((raw) => {
    const p = raw as Omit<AnalysisPayload, "asOfDate"> & { asOfDate?: string };
    return { ...p, asOfDate: p.asOfDate ?? today };
  });

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync("db/schema.sql", "utf8"));

  const results: { isin: string; asOfDate: string }[] = [];
  const errors: { isin: string; message: string }[] = [];

  const batchTx = db.transaction(() => {
    for (const p of payloads) {
      try {
        writeAnalysis(db, p);
        results.push({ isin: p.isin, asOfDate: p.asOfDate });
      } catch (err) {
        errors.push({ isin: p.isin, message: err instanceof Error ? err.message : String(err) });
      }
    }
  });

  try {
    batchTx();
  } finally {
    db.close();
  }

  process.stdout.write(
    JSON.stringify({
      status: errors.length ? "partial" : "ok",
      persisted: results.length,
      failed: errors.length,
      errors,
    }) + "\n",
  );
  if (errors.length && !results.length) process.exit(1);
}

try {
  main();
} catch (err) {
  process.stdout.write(
    JSON.stringify({
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    }) + "\n",
  );
  process.exit(1);
}
