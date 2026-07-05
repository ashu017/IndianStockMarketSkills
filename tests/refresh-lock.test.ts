import { test, expect, afterAll } from "vitest";
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the lock at a temp DB path BEFORE importing the module under test,
// so we never collide with a real portfolio.db.ingest.lock.
const tmpDir = mkdtempSync(join(tmpdir(), "refresh-lock-"));
const dbPath = join(tmpDir, "portfolio.db");
process.env.PORTFOLIO_DB_PATH = dbPath;
const lockPath = dbPath + ".ingest.lock";

const { acquireLock, releaseLock } = await import("@/lib/ingest/lock");

afterAll(() => {
  try {
    rmSync(lockPath, { force: true });
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

test("lock is exclusive", () => {
  expect(acquireLock()).toBe(true);
  expect(acquireLock()).toBe(false);
  releaseLock();
  expect(acquireLock()).toBe(true);
  releaseLock();
  expect(existsSync(lockPath)).toBe(false);
});
