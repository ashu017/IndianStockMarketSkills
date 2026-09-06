import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/connection";
import { computeBulkDealFifoAnalysis } from "@/lib/bulk-deal-fifo";

/**
 * On-demand FIFO reconstruction of non-HFT institutional bulk-deal trades.
 * No per-symbol input — this analyzes the whole bulk_deals table each call,
 * so it's a plain GET rather than the POST-with-symbol pattern used by
 * /api/backtest/overnight/[symbol].
 */
export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const openLotsPage = Number(searchParams.get("openLotsPage") ?? "1") || 1;
    const openLotsPageSize = Number(searchParams.get("openLotsPageSize") ?? "25") || 25;
    const result = computeBulkDealFifoAnalysis(getDb(), { openLotsPage, openLotsPageSize });
    return NextResponse.json({ status: "ok", ...result });
  } catch (e) {
    return NextResponse.json(
      { status: "error", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
