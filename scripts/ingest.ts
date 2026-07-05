import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { writeSnapshot, type SnapshotPayload } from "@/lib/ingest/writer";

/**
 * CLI entry that `POST /api/refresh` spawns. It:
 *   1. computes the IST snapshot_date (YYYY-MM-DD),
 *   2. reads the writer payload (minus snapshotDate) from env INGEST_PAYLOAD,
 *   3. opens the SQLite DB and upserts the snapshot via writeSnapshot,
 *   4. prints a single JSON result line to stdout.
 * On failure it prints a JSON error line and exits non-zero.
 */

// IST = UTC+5:30. Shift the epoch, then take the UTC calendar date of the result.
function istSnapshotDate(now: number = Date.now()): string {
  return new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);
}

function main(): void {
  const snapshotDate = istSnapshotDate();
  const dbPath = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";

  const input = JSON.parse(process.env.INGEST_PAYLOAD ?? "{}") as Omit<
    SnapshotPayload,
    "snapshotDate"
  >;
  const payload: SnapshotPayload = { ...input, snapshotDate };

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  try {
    writeSnapshot(db, payload);
  } finally {
    db.close();
  }

  process.stdout.write(
    JSON.stringify({
      status: "ok",
      snapshotDate,
      holdings: payload.holdings?.length ?? 0,
    }) + "\n",
  );
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
