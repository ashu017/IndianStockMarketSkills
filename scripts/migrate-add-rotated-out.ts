import Database from "better-sqlite3";

/**
 * Idempotent migration: extend paper_trades.status CHECK to allow 'rotated_out'.
 * SQLite bakes CHECK into the table at CREATE time and CREATE TABLE IF NOT EXISTS
 * won't update it, so we rebuild the table in place under a transaction.
 */
function main(): void {
  const dbPath = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = OFF");

  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='paper_trades'`)
    .get() as { sql: string } | undefined;
  if (!row) {
    process.stdout.write("paper_trades table not found — nothing to migrate\n");
    db.close();
    return;
  }
  if (row.sql.includes("rotated_out")) {
    process.stdout.write("already migrated — CHECK already contains 'rotated_out'\n");
    db.close();
    return;
  }

  const rebuild = db.transaction(() => {
    db.exec(`
      CREATE TABLE paper_trades__new (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id                 TEXT NOT NULL,
        symbol                  TEXT NOT NULL,
        exchange                TEXT NOT NULL,
        entry_signal_scan_date  TEXT,
        entry_date              TEXT NOT NULL,
        entry_time              TEXT NOT NULL,
        entry_paise             INTEGER NOT NULL,
        qty                     INTEGER NOT NULL,
        capital_committed_paise INTEGER NOT NULL,
        initial_stop_paise      INTEGER NOT NULL,
        current_stop_paise      INTEGER NOT NULL,
        target_paise            INTEGER NOT NULL,
        atr14_paise             INTEGER,
        status                  TEXT NOT NULL DEFAULT 'open'
                                  CHECK (status IN ('open','target_hit','stopped','time_exit','manual_closed','rotated_out')),
        exit_date               TEXT,
        exit_time               TEXT,
        exit_paise              INTEGER,
        exit_reason             TEXT,
        realized_pnl_paise      INTEGER,
        bars_held               INTEGER NOT NULL DEFAULT 0,
        UNIQUE (user_id, symbol, exchange, entry_date)
      );
      INSERT INTO paper_trades__new
        SELECT id, user_id, symbol, exchange, entry_signal_scan_date, entry_date, entry_time,
               entry_paise, qty, capital_committed_paise, initial_stop_paise, current_stop_paise,
               target_paise, atr14_paise, status, exit_date, exit_time, exit_paise, exit_reason,
               realized_pnl_paise, bars_held
        FROM paper_trades;
      DROP TABLE paper_trades;
      ALTER TABLE paper_trades__new RENAME TO paper_trades;
      CREATE INDEX IF NOT EXISTS idx_paper_trades_open   ON paper_trades(user_id, status);
      CREATE INDEX IF NOT EXISTS idx_paper_trades_symbol ON paper_trades(symbol, exchange);
      CREATE INDEX IF NOT EXISTS idx_paper_trades_entry  ON paper_trades(entry_date);
    `);
  });
  rebuild();
  db.pragma("foreign_keys = ON");
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM paper_trades`).get() as { n: number }).n;
  process.stdout.write(`migrated paper_trades — ${n} rows preserved, CHECK now accepts 'rotated_out'\n`);
  db.close();
}

main();
