import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ensureAccount, computeQty, recomputeEquity } from "@/lib/paper";

/**
 * One-shot migration: initialize the paper_account with the user-chosen starting
 * cash, then port every currently-open row in `open_positions` into
 * `paper_trades` with computed qty. Idempotent — if a paper_trade already exists
 * for a given symbol on the same entry date, we skip.
 *
 * Env:
 *   PORTFOLIO_DB_PATH=./data/portfolio.db
 *   STARTING_CASH_PAISE=30000000       (default Rs 3,00,000)
 *   USER_ID=local
 */

const USER_ID = process.env.USER_ID ?? "local";
const STARTING_CASH_PAISE = Number(process.env.STARTING_CASH_PAISE ?? "30000000");

function nowIso(): string {
  return new Date().toISOString();
}

interface LegacyOpen {
  symbol: string;
  exchange: string;
  entry_scan_date: string;
  entry_scan_time: string;
  entry_paise: number;
  initial_stop_paise: number;
  current_stop_paise: number;
  target_paise: number;
  atr14_paise: number | null;
  bars_held: number;
}

function main(): void {
  const dbPath = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync("db/schema.sql", "utf8"));

  const account = ensureAccount(db, USER_ID, STARTING_CASH_PAISE);
  const alreadyInitialized = account.starting_cash_paise !== STARTING_CASH_PAISE;
  if (alreadyInitialized) {
    process.stderr.write(
      `[init-paper-account] account already exists with starting cash Rs${(account.starting_cash_paise/100).toFixed(0)}; ` +
      `will not overwrite. Delete the row manually to reset.\n`,
    );
  }

  const legacyOpen = db
    .prepare(
      `SELECT symbol, exchange, entry_scan_date, entry_scan_time, entry_paise,
              initial_stop_paise, current_stop_paise, target_paise, atr14_paise, bars_held
       FROM open_positions
       WHERE status = 'open'
       ORDER BY entry_scan_date, symbol`,
    )
    .all() as LegacyOpen[];

  const insertTrade = db.prepare(
    `INSERT INTO paper_trades(user_id, symbol, exchange, entry_signal_scan_date,
                              entry_date, entry_time, entry_paise, qty, capital_committed_paise,
                              initial_stop_paise, current_stop_paise, target_paise, atr14_paise,
                              status, bars_held)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
     ON CONFLICT(user_id, symbol, exchange, entry_date) DO NOTHING`,
  );
  const deductCash = db.prepare(
    `UPDATE paper_account SET current_cash_paise = current_cash_paise - ?, last_updated_at = ?
     WHERE user_id = ?`,
  );

  let migrated = 0;
  const skipped: { symbol: string; reason: string }[] = [];

  // Migrate in order — each open trade eats into cash for the next one's sizing.
  const tx = db.transaction(() => {
    for (const p of legacyOpen) {
      const acct = db.prepare(`SELECT * FROM paper_account WHERE user_id=?`).get(USER_ID) as {
        equity_paise: number; current_cash_paise: number; risk_pct_per_trade: number; max_position_pct: number;
      };
      const size = computeQty({
        equity_paise: acct.equity_paise,
        entry_paise: p.entry_paise,
        stop_paise: p.initial_stop_paise,
        risk_pct: acct.risk_pct_per_trade,
        max_position_pct: acct.max_position_pct,
      });
      if (size.qty <= 0) {
        skipped.push({ symbol: p.symbol, reason: size.reason ?? "qty_zero" });
        continue;
      }
      if (size.capital_committed_paise > acct.current_cash_paise) {
        skipped.push({ symbol: p.symbol, reason: "insufficient_cash" });
        continue;
      }
      insertTrade.run(
        USER_ID, p.symbol, p.exchange, p.entry_scan_date,
        p.entry_scan_date, p.entry_scan_time, p.entry_paise, size.qty, size.capital_committed_paise,
        p.initial_stop_paise, p.current_stop_paise, p.target_paise, p.atr14_paise,
        p.bars_held,
      );
      deductCash.run(size.capital_committed_paise, nowIso(), USER_ID);
      migrated++;
    }
  });
  tx();

  recomputeEquity(db, USER_ID);
  const final = db.prepare(`SELECT * FROM paper_account WHERE user_id=?`).get(USER_ID) as {
    starting_cash_paise: number; current_cash_paise: number; equity_paise: number;
  };

  db.close();
  process.stdout.write(
    JSON.stringify({
      status: "ok",
      account: {
        starting_cash_rs: final.starting_cash_paise / 100,
        current_cash_rs: final.current_cash_paise / 100,
        equity_rs: final.equity_paise / 100,
      },
      migrated,
      skipped,
    }) + "\n",
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
