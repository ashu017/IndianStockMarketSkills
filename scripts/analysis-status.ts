import Database from "better-sqlite3";

/**
 * TTL helper for the batch fundamental-analysis runner.
 * Given ISINs (JSON array in env ISINS, or all holdings if omitted), reports which
 * were already successfully analyzed TODAY (IST) so the caller can skip re-dispatching
 * the (slow) LLM agent for them. "Successfully" = fundamentals row for today with
 * fetch_status='ok' — so prior failed fetches are NOT skipped (they get retried).
 *
 * Set FORCE=1 to treat nothing as fresh (re-analyze everything).
 * Output: one JSON line { today, fresh:[isin...], stale:[isin...] }.
 */
function istDate(now = Date.now()): string {
  return new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);
}

function main(): void {
  const dbPath = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";
  const today = istDate();
  const db = new Database(dbPath, { readonly: true });

  const isins: string[] = process.env.ISINS
    ? (JSON.parse(process.env.ISINS) as string[])
    : (db
        .prepare("SELECT DISTINCT isin FROM v_holdings_current v JOIN stock_meta m ON m.symbol=v.symbol AND m.exchange=v.exchange WHERE v.user_id=?")
        .all(process.env.PORTFOLIO_USER_ID ?? "local")
        .map((r) => (r as { isin: string }).isin)
        .filter(Boolean));

  const force = process.env.FORCE === "1";
  const freshSet = new Set<string>();
  if (!force) {
    const rows = db
      .prepare(
        "SELECT DISTINCT isin FROM fundamentals WHERE as_of_date = ? AND fetch_status = 'ok'",
      )
      .all(today) as { isin: string }[];
    for (const r of rows) freshSet.add(r.isin);
  }

  const fresh = isins.filter((i) => freshSet.has(i));
  const stale = isins.filter((i) => !freshSet.has(i));
  process.stdout.write(JSON.stringify({ today, fresh, stale }) + "\n");
}

main();
