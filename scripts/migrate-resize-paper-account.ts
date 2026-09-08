/**
 * Retune the live paper account's sizing knobs to DEFAULT_SIZING.
 *
 * WHY. The account ran 5 slots at 1% risk / 25% capital cap, which put ~88% of
 * equity into 5 names and left no cash for a 6th. Lowering the capital cap alone
 * would not have helped: position size is min(risk_pct/stop_distance,
 * max_position_pct), and the cap only bites on stops closer than
 * risk_pct/max_position_pct (4% of price at the old values), which was true of
 * exactly 1 of the 5 open positions. `risk_pct_per_trade` is the knob that sizes
 * the rest, so it comes down with the slot count going up — holding aggregate
 * risk at a full book roughly constant while spreading it over more names.
 *
 * Existing open positions are NOT resized. Sizing is computed once in
 * openPaperTrade(); nothing re-derives qty for a live row. So the book converges
 * on the new sizing as old positions close, exactly like the exit-rule promotion.
 *
 * Idempotent: re-running writes the same values. Prints before/after and what
 * the new configuration implies for capacity.
 *
 *   tsx scripts/migrate-resize-paper-account.ts            # ./data/portfolio.db
 *   PORTFOLIO_DB_PATH=/tmp/copy.db tsx scripts/migrate-resize-paper-account.ts
 */
import Database from "better-sqlite3";
import { DEFAULT_SIZING } from "@/lib/paper";

const DB_PATH = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";

interface AccountRow {
  user_id: string;
  equity_paise: number;
  current_cash_paise: number;
  risk_pct_per_trade: number;
  max_concurrent_trades: number;
  max_position_pct: number;
}

const SELECT =
  `SELECT user_id, equity_paise, current_cash_paise, risk_pct_per_trade,
          max_concurrent_trades, max_position_pct FROM paper_account`;

function describe(a: AccountRow): string {
  return `risk ${a.risk_pct_per_trade}% | ${a.max_concurrent_trades} slots | cap ${a.max_position_pct}%`;
}

function main(): void {
  const db = new Database(DB_PATH);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");

    const before = db.prepare(SELECT).all() as AccountRow[];
    if (before.length === 0) {
      console.log("no paper_account rows — nothing to retune");
      return;
    }

    db.prepare(
      `UPDATE paper_account
          SET risk_pct_per_trade=?, max_concurrent_trades=?, max_position_pct=?,
              last_updated_at=?
        WHERE user_id=?`,
    ).run(
      DEFAULT_SIZING.riskPctPerTrade,
      DEFAULT_SIZING.maxConcurrentTrades,
      DEFAULT_SIZING.maxPositionPct,
      new Date().toISOString(),
      before[0].user_id,
    );

    const after = (db.prepare(SELECT).all() as AccountRow[])[0];
    console.log(`${after.user_id}: ${describe(before[0])}  ->  ${describe(after)}`);

    // Capacity implied by the new knobs, so the effect is visible without
    // waiting for the next scan to open something.
    const eq = after.equity_paise;
    const capBindsBelow = after.risk_pct_per_trade / after.max_position_pct * 100;
    console.log(
      `aggregate risk at a full book: ${(after.max_concurrent_trades * after.risk_pct_per_trade).toFixed(1)}% of equity`,
    );
    console.log(
      `capital cap now binds only on stops closer than ${capBindsBelow.toFixed(1)}% of price`,
    );
    console.log(
      `max capital in any one position: Rs ${(after.max_position_pct / 100 * eq / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`,
    );

    const open = db
      .prepare(
        `SELECT COUNT(*) n, COALESCE(SUM(capital_committed_paise),0) c
           FROM paper_trades WHERE user_id=? AND status='open'`,
      )
      .get(after.user_id) as { n: number; c: number };
    console.log(
      `open now: ${open.n}/${after.max_concurrent_trades} slots, ${(100 * open.c / eq).toFixed(1)}% of equity committed, ` +
        `cash Rs ${(after.current_cash_paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })} ` +
        `(${(100 * after.current_cash_paise / eq).toFixed(1)}%)`,
    );
    console.log("existing positions keep their original size — only new entries use the new sizing");
  } finally {
    db.close();
  }
}

main();
