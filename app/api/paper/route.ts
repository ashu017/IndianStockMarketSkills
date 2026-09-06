import { NextResponse } from "next/server";
import Database from "better-sqlite3";
import {
  ensureAccount,
  loadActivePaperTrades,
  summarize,
  openQty,
} from "@/lib/paper";

/**
 * GET /api/paper
 *
 * Returns:
 *   - account summary (equity, return, cash, realized/unrealized P&L, win rate, max drawdown)
 *   - open trades (mark-to-market)
 *   - closed trades (last 50 by exit_date)
 *   - equity_curve (paper_account_history rows, oldest → newest)
 */

const DB_PATH = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";

interface ClosedTradeRow {
  id: number;
  symbol: string;
  exchange: string;
  entry_date: string;
  entry_paise: number;
  exit_date: string;
  exit_paise: number;
  exit_reason: string;
  status: string;
  qty: number;
  realized_pnl_paise: number;
  bars_held: number;
  initial_stop_paise: number;
}

export async function GET(): Promise<NextResponse> {
  const db = new Database(DB_PATH, { readonly: false });
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");

    ensureAccount(db);
    const sum = summarize(db);
    const active = loadActivePaperTrades(db);
    const closed = db
      .prepare(
        `SELECT id, symbol, exchange, entry_date, entry_paise, exit_date, exit_paise,
                exit_reason, status, qty, realized_pnl_paise, bars_held, initial_stop_paise
         FROM paper_trades
         WHERE status != 'open' AND user_id = 'local'
         ORDER BY exit_date DESC LIMIT 50`,
      )
      .all() as ClosedTradeRow[];
    const history = db
      .prepare(
        `SELECT snapshot_date, cash_paise, unrealized_pnl_paise, realized_pnl_paise,
                equity_paise, open_position_count, winners, losers
         FROM paper_account_history WHERE user_id = 'local'
         ORDER BY snapshot_date ASC`,
      )
      .all() as {
      snapshot_date: string; cash_paise: number; unrealized_pnl_paise: number;
      realized_pnl_paise: number; equity_paise: number; open_position_count: number;
      winners: number; losers: number;
    }[];

    return NextResponse.json({
      status: "ok",
      account: sum,
      open_trades: active.map((t) => ({
        id: t.id,
        symbol: t.symbol,
        exchange: t.exchange,
        entry_date: t.entry_date,
        entry_rs: t.entry_paise / 100,
        qty: t.qty,
        // Shares still held after any scale-out. The unrealized figures below are
        // marked on this, not on qty — the booked shares are already in cash.
        qty_open: openQty(t),
        scaled_out: t.scaled_out,
        partial_exit_date: t.partial_exit_date,
        partial_exit_rs: t.partial_exit_paise !== null ? t.partial_exit_paise / 100 : null,
        partial_pnl_rs: t.partial_pnl_paise / 100,
        capital_committed_rs: t.capital_committed_paise / 100,
        initial_stop_rs: t.initial_stop_paise / 100,
        current_stop_rs: t.current_stop_paise / 100,
        target_rs: t.target_paise / 100,
        latest_close_rs: t.latest_close_paise !== null ? t.latest_close_paise / 100 : null,
        unrealized_pnl_rs: t.unrealized_pnl_paise !== null ? t.unrealized_pnl_paise / 100 : null,
        unrealized_pct: t.unrealized_pct,
        bars_held: t.bars_held,
        moved_to_breakeven: t.moved_to_breakeven,
      })),
      closed_trades: closed.map((t) => {
        const perShareRisk = t.entry_paise - t.initial_stop_paise;
        const totalRisk = perShareRisk * t.qty;
        const rMultiple = totalRisk > 0 ? t.realized_pnl_paise / totalRisk : null;
        return {
          id: t.id,
          symbol: t.symbol,
          entry_date: t.entry_date,
          exit_date: t.exit_date,
          entry_rs: t.entry_paise / 100,
          exit_rs: t.exit_paise / 100,
          qty: t.qty,
          realized_pnl_rs: t.realized_pnl_paise / 100,
          r_multiple: rMultiple,
          exit_reason: t.exit_reason,
          status: t.status,
          bars_held: t.bars_held,
        };
      }),
      equity_curve: history.map((h) => ({
        date: h.snapshot_date,
        cash_rs: h.cash_paise / 100,
        equity_rs: h.equity_paise / 100,
        realized_pnl_rs: h.realized_pnl_paise / 100,
        unrealized_pnl_rs: h.unrealized_pnl_paise / 100,
        open_count: h.open_position_count,
        winners: h.winners,
        losers: h.losers,
      })),
    });
  } finally {
    db.close();
  }
}

