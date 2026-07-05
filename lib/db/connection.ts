import "server-only";
import Database from "better-sqlite3";

const DB_PATH = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";

// Cache the connection on globalThis so `next dev` HMR doesn't leak handles
// by re-opening the DB on every module re-evaluation.
const g = globalThis as unknown as { __portfolioDb?: Database.Database };

export function getDb(): Database.Database {
  if (g.__portfolioDb) return g.__portfolioDb;
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL"); // readers don't block the single writer
  db.pragma("busy_timeout = 5000"); // retry on transient contention
  db.pragma("foreign_keys = ON"); // off by default, per-connection
  g.__portfolioDb = db;
  return db;
}
