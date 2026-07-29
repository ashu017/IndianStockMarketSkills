import { NextRequest, NextResponse } from "next/server";
import Database from "better-sqlite3";
import { closePaperTradeManual } from "@/lib/paper";

/**
 * POST /api/paper/close  { trade_id: number, reason?: string }
 * Closes an open paper trade at the latest known price.
 */

const DB_PATH = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => ({}))) as { trade_id?: unknown; reason?: unknown };
  const tradeId = typeof body.trade_id === "number" ? body.trade_id : NaN;
  if (!Number.isFinite(tradeId) || tradeId <= 0) {
    return NextResponse.json({ status: "error", message: "trade_id must be a positive integer" }, { status: 400 });
  }
  const reason = typeof body.reason === "string" && body.reason.trim().length > 0
    ? body.reason.trim().slice(0, 200)
    : "manual close via UI";

  const db = new Database(DB_PATH, { readonly: false });
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    const r = closePaperTradeManual(db, tradeId, reason);
    if (!r.closed) {
      return NextResponse.json({ status: "error", message: r.message ?? "close failed" }, { status: 400 });
    }
    return NextResponse.json({
      status: "ok",
      trade_id: tradeId,
      realized_pnl_rs: r.realized_pnl_paise ? r.realized_pnl_paise / 100 : 0,
    });
  } finally {
    db.close();
  }
}
