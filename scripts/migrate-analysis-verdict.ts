import Database from "better-sqlite3";

/** Idempotently add verdict/confidence columns to an existing analysis table. */
export function addVerdictColumns(db: Database.Database): void {
  const cols = (db.prepare("PRAGMA table_info(analysis)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("verdict")) db.exec("ALTER TABLE analysis ADD COLUMN verdict TEXT");
  if (!cols.includes("confidence")) db.exec("ALTER TABLE analysis ADD COLUMN confidence TEXT");
}

// Run directly: `tsx scripts/migrate-analysis-verdict.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";
  const db = new Database(path);
  addVerdictColumns(db);
  console.log("migrated analysis table:", path);
}
