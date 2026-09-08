/**
 * Throwaway verification: replay every open paper trade and print what changed.
 * Point it at a COPY of the db. Confirms v1-stamped rows keep the old recipe.
 */
import Database from "better-sqlite3";
import { updateOpenPaperTrades } from "@/lib/paper";

const DB_PATH = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";
const COLS =
  "id, symbol, exit_rule, status, qty, qty_open, partial_qty, bars_held, current_stop_paise, target_paise, initial_stop_paise";

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

type Row = Record<string, unknown> & { id: number; symbol: string; exit_rule: string };
const before = db
  .prepare(`SELECT ${COLS} FROM paper_trades WHERE status='open' ORDER BY id`)
  .all() as Row[];

console.log("result:", updateOpenPaperTrades(db));

const ids = before.map((b) => b.id).join(",");
const after = db
  .prepare(`SELECT ${COLS} FROM paper_trades WHERE id IN (${ids}) ORDER BY id`)
  .all() as Row[];

before.forEach((b, i) => {
  const a = after[i];
  const diff = Object.keys(b)
    .filter((k) => b[k] !== a[k])
    .map((k) => `${k}: ${b[k]} -> ${a[k]}`);
  console.log(b.symbol.padEnd(10), b.exit_rule, "|", diff.length ? diff.join(", ") : "unchanged");
});
db.close();
