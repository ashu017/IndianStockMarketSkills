import { NextResponse } from "next/server";
import { getStrategy } from "@/lib/strategies";
import {
  MOMENTUM_VARIANTS,
  isMomentumVariant,
  runTechnicalBacktest,
  type MomentumVariant,
} from "@/lib/backtest";

/**
 * On-demand technical backtest for a strategy.
 *
 *   POST /api/backtest/quality_trend_momentum_breakout
 *   POST /api/backtest/quality_trend_momentum_breakout  {"variant":"v1"}
 *   POST /api/backtest/trend_momentum_breakout_technical
 *
 * `variant` picks the exit rule: "live" (default — what the paper account now
 * trades: 1.75×ATR stop, 5R target, half booked at 1.5R, 25-bar cap) or "v1"
 * (the frozen pre-2026-08-31 rule, kept as the historical baseline and still
 * managing positions opened under it). The panel offers both so the promotion is
 * compared rather than taken on trust; which one ran is echoed back in `variant`
 * and spelled out in summary.caveats.
 *
 * The strategy id picks the universe filter, NOT a different engine: the two
 * momentum strategies share every price rule and differ only in whether the
 * fundamental quality gate is applied (BACKTESTABLE below). Keeping that a
 * lookup here rather than a branch in the engine is what keeps them comparable.
 *
 * Unlike /api/analysis/[symbol] (which shells out to the `claude -p` CLI and
 * therefore needs the spawn+timeout dance), this is pure in-process
 * TypeScript computation over cached OHLC — no subprocess needed. Still runs
 * on the Node runtime (better-sqlite3 is a native module, not Edge-safe) with
 * a generous maxDuration since walking ~470 symbols' full price history is
 * heavier than a typical request.
 */
export const runtime = "nodejs";
export const maxDuration = 60;

/** Strategy id → whether the fundamental quality gate applies. A strategy absent
 *  from this map has no backtest implemented. */
const BACKTESTABLE: Record<string, { qualityGate: boolean }> = {
  quality_trend_momentum_breakout: { qualityGate: true },
  trend_momentum_breakout_technical: { qualityGate: false },
};

export async function POST(
  req: Request,
  { params }: { params: Promise<{ strategy: string }> },
) {
  const { strategy } = await params;
  const decoded = decodeURIComponent(strategy);
  const def = getStrategy(decoded);
  if (!def) {
    return NextResponse.json({ status: "error", message: "unknown strategy" }, { status: 404 });
  }
  const config = BACKTESTABLE[decoded];
  if (!config) {
    return NextResponse.json(
      { status: "error", message: "no backtest implemented for this strategy yet" },
      { status: 501 },
    );
  }

  // An unparseable or absent body is not an error — the endpoint is still
  // usable as a bare POST, it just runs the default variant.
  const body = (await req.json().catch(() => null)) as { variant?: unknown } | null;
  if (body?.variant !== undefined && !isMomentumVariant(body.variant)) {
    return NextResponse.json(
      { status: "error", message: `unknown variant — expected "live" or "v1"` },
      { status: 400 },
    );
  }
  const variant: MomentumVariant = isMomentumVariant(body?.variant) ? body.variant : "live";

  try {
    const result = await runTechnicalBacktest("local", {
      ...MOMENTUM_VARIANTS[variant],
      qualityGate: config.qualityGate,
    });
    return NextResponse.json({ status: "ok", variant, ...result });
  } catch (e) {
    return NextResponse.json(
      { status: "error", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

