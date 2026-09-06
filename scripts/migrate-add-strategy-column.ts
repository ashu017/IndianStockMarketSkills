import Database from "better-sqlite3";

/**
 * Idempotently add paper_trades.strategy, defaulting existing rows to
 * 'quality_trend_momentum_breakout' (the only strategy that has ever opened
 * a paper trade in this app to date — see lib/strategies.ts).
 */
export function addStrategyColumn(db: Database.Database): void {
  const cols = (db.prepare("PRAGMA table_info(paper_trades)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("strategy")) {
    db.exec(
      "ALTER TABLE paper_trades ADD COLUMN strategy TEXT NOT NULL DEFAULT 'quality_trend_momentum_breakout'",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_paper_trades_strategy ON paper_trades(user_id, strategy, status)",
    );
  }
}

// Run directly: `tsx scripts/migrate-add-strategy-column.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";
  const db = new Database(path);
  addStrategyColumn(db);
  console.log("migrated paper_trades table:", path);
}

