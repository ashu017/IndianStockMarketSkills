import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/connection";
import { runOvernightBacktest } from "@/lib/overnight-backtest";

/**
 * On-demand overnight (close-to-open) backtest for one symbol.
 *
 *   POST /api/backtest/overnight/RELIANCE
 *
 * Pure in-process computation over cached OHLC, same rationale as
 * /api/backtest/[strategy] for skipping the spawn+subprocess pattern.
 */
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ symbol: string }> },
) {
  const { symbol } = await params;
  const decoded = decodeURIComponent(symbol).trim().toUpperCase();
  if (!decoded || !/^[A-Z0-9&.\-]{1,32}$/.test(decoded)) {
    return NextResponse.json({ status: "error", message: "invalid symbol" }, { status: 400 });
  }

  try {
    const result = await runOvernightBacktest(getDb(), decoded);
    if (!result) {
      return NextResponse.json(
        { status: "error", message: `${decoded} not found in tracked indices` },
        { status: 404 },
      );
    }
    return NextResponse.json({ status: "ok", ...result });
  } catch (e) {
    return NextResponse.json(
      { status: "error", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

