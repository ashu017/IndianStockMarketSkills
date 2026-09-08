import Database from "better-sqlite3";

/**
 * Idempotently add the exit-rule versioning and scale-out columns to
 * paper_trades and open_positions.
 *
 * Every pre-existing row defaults to 'v1_atr2_3r' — those positions were opened
 * and planned on the 2×ATR / 3R / breakeven-at-1R / 60-bar rule, and the whole
 * point of stamping the rule per row is that promoting v2 must not re-plan them
 * (see lib/exit-rules.ts). A DEFAULT on the ALTER does that automatically, which
 * is why there's no backfill UPDATE here.
 *
 * qty_open is left NULL for existing rows rather than backfilled to qty: NULL
 * means "never scaled out", and lib/paper.ts coalesces it to qty on read. A
 * backfill would be equivalent today but would lose that distinction for any
 * row written before the column existed.
 */
export function addExitRuleColumns(db: Database.Database): void {
  const columnsOf = (table: string): string[] =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

  const add = (table: string, column: string, ddl: string): boolean => {
    if (columnsOf(table).includes(column)) return false;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    return true;
  };

  const added: string[] = [];
  const track = (table: string, column: string, ddl: string) => {
    if (add(table, column, ddl)) added.push(`${table}.${column}`);
  };

  db.transaction(() => {
    track("paper_trades", "exit_rule", "exit_rule TEXT NOT NULL DEFAULT 'v1_atr2_3r'");
    track("paper_trades", "qty_open", "qty_open INTEGER");
    track("paper_trades", "partial_qty", "partial_qty INTEGER NOT NULL DEFAULT 0");
    track("paper_trades", "partial_exit_date", "partial_exit_date TEXT");
    track("paper_trades", "partial_exit_paise", "partial_exit_paise INTEGER");
    track("paper_trades", "partial_pnl_paise", "partial_pnl_paise INTEGER NOT NULL DEFAULT 0");

    track("open_positions", "exit_rule", "exit_rule TEXT NOT NULL DEFAULT 'v1_atr2_3r'");
    track("open_positions", "partial_exit_date", "partial_exit_date TEXT");
    track("open_positions", "partial_exit_paise", "partial_exit_paise INTEGER");
  })();

  if (added.length > 0) console.log("added columns:", added.join(", "));
  else console.log("already migrated — no columns added");
}

// Run directly: `tsx scripts/migrate-add-exit-rule-columns.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";
  const db = new Database(path);
  addExitRuleColumns(db);
  const open = db
    .prepare(
      `SELECT exit_rule, COUNT(*) AS n FROM paper_trades WHERE status='open' GROUP BY exit_rule`,
    )
    .all();
  console.log("migrated:", path);
  console.log("open paper trades by rule:", open);
}
