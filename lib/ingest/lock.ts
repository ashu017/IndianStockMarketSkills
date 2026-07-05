import { existsSync, writeFileSync, rmSync } from "node:fs";

const LOCK = (process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db") + ".ingest.lock";

/**
 * File-based single-writer guard. Returns false if a lock file already
 * exists (another ingest is running), otherwise writes this process's pid
 * to the lock file and returns true.
 */
export function acquireLock(): boolean {
  if (existsSync(LOCK)) return false;
  writeFileSync(LOCK, String(process.pid));
  return true;
}

/** Releases the lock by removing the lock file. Errors are ignored. */
export function releaseLock(): void {
  try {
    rmSync(LOCK);
  } catch {
    // ignore — lock may already be gone
  }
}
