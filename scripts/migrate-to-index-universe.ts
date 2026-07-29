import Database from "better-sqlite3";
import { readFileSync } from "node:fs";

/**
 * One-shot migration: turn nifty100_universe (real table) into a slice of the
 * new index_universe table, then re-create nifty100_universe as a VIEW so
 * existing scripts keep working during the transition.
 *
 * Idempotent — running twice is safe. If nifty100_universe is already a VIEW
 * (i.e., migration already applied), the script exits cleanly with a note.
 */
function main(): void {
  const dbPath = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = OFF"); // temporarily; we recreate FKs after

  // Detect current state.
  const oldObj = db
    .prepare(`SELECT type FROM sqlite_master WHERE name='nifty100_universe'`)
    .get() as { type: string } | undefined;
  const alreadyMigrated = oldObj?.type === "view";

  const idxObj = db
    .prepare(`SELECT type FROM sqlite_master WHERE name='index_universe'`)
    .get() as { type: string } | undefined;

  if (alreadyMigrated && idxObj) {
    const n = (db.prepare(`SELECT count(*) as n FROM index_universe`).get() as { n: number }).n;
    process.stdout.write(
      JSON.stringify({ status: "already_migrated", index_universe_rows: n }) + "\n",
    );
    db.close();
    return;
  }

  // Step 1: create index_universe if not present.
  db.exec(`
    CREATE TABLE IF NOT EXISTS index_universe (
      index_name         TEXT NOT NULL,
      symbol             TEXT NOT NULL,
      exchange           TEXT NOT NULL CHECK (exchange IN ('NSE','BSE')),
      isin               TEXT NOT NULL,
      tradingsymbol      TEXT NOT NULL,
      instrument_token   INTEGER NOT NULL,
      company            TEXT,
      sector             TEXT,
      as_of_date         TEXT NOT NULL,
      PRIMARY KEY (index_name, symbol, exchange)
    );
    CREATE INDEX IF NOT EXISTS idx_index_universe_symbol ON index_universe(symbol, exchange);
    CREATE INDEX IF NOT EXISTS idx_index_universe_isin   ON index_universe(isin);
  `);

  // Step 2: copy existing rows (nifty100_universe → index_universe, tagged 'NIFTY 100')
  const copied = db.prepare(`
    INSERT OR IGNORE INTO index_universe(
      index_name, symbol, exchange, isin, tradingsymbol, instrument_token, company, sector, as_of_date
    )
    SELECT 'NIFTY 100', symbol, exchange, isin, tradingsymbol, instrument_token, company, sector, as_of_date
    FROM nifty100_universe
  `).run();
  const copiedCount = copied.changes;

  // Step 3: Rebuild `signals` without the FK to nifty100_universe.
  // The FK was baked into the CREATE TABLE and we can't ALTER-DROP it in SQLite.
  // Preserve all existing rows through the rename dance.
  db.exec(`
    CREATE TABLE signals_new (
      symbol         TEXT NOT NULL,
      exchange       TEXT NOT NULL,
      scan_date      TEXT NOT NULL,
      scan_time      TEXT NOT NULL,
      side           TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
      entry_paise    INTEGER NOT NULL,
      stop_paise     INTEGER NOT NULL,
      target_paise   INTEGER NOT NULL,
      risk_reward    REAL NOT NULL,
      atr14_paise    INTEGER,
      mom_rank       INTEGER,
      mom_score      REAL,
      reasons        TEXT,
      UNIQUE (symbol, exchange, scan_date, side)
    );
    INSERT INTO signals_new SELECT * FROM signals;
    DROP TABLE signals;
    ALTER TABLE signals_new RENAME TO signals;
    CREATE INDEX IF NOT EXISTS idx_signals_date ON signals(scan_date, side);
  `);

  // Step 4: drop the old universe table so we can create a view with the same name.
  db.exec(`DROP TABLE nifty100_universe`);

  // Step 5: re-create nifty100_universe as a VIEW (matches new schema.sql)
  db.exec(`
    CREATE VIEW IF NOT EXISTS nifty100_universe AS
    SELECT symbol, exchange, isin, tradingsymbol, instrument_token, company, sector, as_of_date
    FROM index_universe
    WHERE index_name = 'NIFTY 100'
  `);

  db.pragma("foreign_keys = ON");
  db.close();

  process.stdout.write(
    JSON.stringify({ status: "migrated", copied: copiedCount, view: "nifty100_universe" }) + "\n",
  );
}

try {
  main();
} catch (err) {
  process.stdout.write(
    JSON.stringify({ status: "error", message: err instanceof Error ? err.message : String(err) }) + "\n",
  );
  process.exit(1);
}
