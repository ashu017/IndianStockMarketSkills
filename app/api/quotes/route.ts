import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/connection";
import { refreshLiveQuotes, type LiveQuote } from "@/lib/live-quotes";

/**
 * On-demand live quotes for a handful of symbols.
 *
 * WHY THIS EXISTS: ohlc_intraday is filled by the scan cron, which runs four
 * times a weekday. Between runs a strategy page was marking its positions at a
 * price up to two hours old while labelling the column "LTP". This route lets a
 * page ask for the current prices of the symbols it is actually showing, so the
 * mark matches the heading.
 *
 * It shares lib/live-quotes.ts with the cron rather than reimplementing the NSE
 * call — see the note there.
 *
 * POST { symbols: string[] }  ->  { quotes: { SYMBOL: { ltp_paise, ... } } }
 *
 * Two limits bound the outbound traffic this can generate, because an endpoint
 * that fans out to a third party on request is an amplifier if you let it be:
 *
 *   1. Requested symbols are intersected with the ones this database actually
 *      knows — the index universe plus every symbol ever paper-traded. The
 *      caller cannot make us go ask NSE about arbitrary strings.
 *   2. One refresh runs at a time, and a refresh reuses any ohlc_intraday row
 *      fetched in the last REUSE_WINDOW_SECONDS. So opening three strategies at
 *      once, or reloading a page, does not multiply into three rounds of NSE
 *      requests for the same prices.
 */

/** NSE's own feed lags a couple of minutes, so reusing a row this recent costs
 *  the reader no freshness they actually had. */
const REUSE_WINDOW_SECONDS = 90;

/** More than any one page displays. A request over this is a bug or abuse, not
 *  a page that legitimately has 200 positions. */
const MAX_SYMBOLS = 80;

/** Pre-filter before the DB intersection. NSE symbols are upper-case and may
 *  contain & (M&M, GVT&D), - (series suffixes) and . */
const SYMBOL_RE = /^[A-Z0-9&.-]{1,20}$/;

/**
 * Serializes refreshes across requests. Next runs route handlers concurrently,
 * and two simultaneous page opens would otherwise put two fan-outs on NSE at
 * once. The second waiter almost always finds fresh rows and returns without a
 * network call at all.
 */
let inFlight: Promise<unknown> = Promise.resolve();

function knownSymbols(candidates: string[]): Set<string> {
  const db = getDb();
  const placeholders = candidates.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT DISTINCT symbol FROM index_universe WHERE symbol IN (${placeholders})
       UNION
       SELECT DISTINCT symbol FROM paper_trades WHERE symbol IN (${placeholders})`,
    )
    .all(...candidates, ...candidates) as { symbol: string }[];
  return new Set(rows.map((r) => r.symbol));
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ status: "error", message: "body must be JSON" }, { status: 400 });
  }

  const raw = (body as { symbols?: unknown })?.symbols;
  if (!Array.isArray(raw)) {
    return NextResponse.json(
      { status: "error", message: "symbols must be an array of strings" },
      { status: 400 },
    );
  }

  const candidates = Array.from(
    new Set(raw.filter((s): s is string => typeof s === "string" && SYMBOL_RE.test(s))),
  );
  if (candidates.length === 0) {
    return NextResponse.json({ status: "error", message: "no valid symbols" }, { status: 400 });
  }
  if (candidates.length > MAX_SYMBOLS) {
    return NextResponse.json(
      { status: "error", message: `at most ${MAX_SYMBOLS} symbols per request` },
      { status: 400 },
    );
  }

  const known = knownSymbols(candidates);
  const symbols = candidates.filter((s) => known.has(s));
  const unknown = candidates.filter((s) => !known.has(s));

  if (symbols.length === 0) {
    return NextResponse.json({
      status: "ok",
      quotes: {} as Record<string, LiveQuote>,
      unknown_symbols: unknown,
      requested: 0,
      fetched: 0,
      reused: 0,
      failed: 0,
    });
  }

  const run = inFlight.then(
    () =>
      refreshLiveQuotes(getDb(), {
        symbols,
        reuseWithinSeconds: REUSE_WINDOW_SECONDS,
        // Nothing on the page needs peers, and skipping them keeps the write
        // small — the cron already collects them across the whole universe.
        opportunisticPeers: false,
      }),
    // A previous request's failure must not poison this one's turn.
    () =>
      refreshLiveQuotes(getDb(), {
        symbols,
        reuseWithinSeconds: REUSE_WINDOW_SECONDS,
        opportunisticPeers: false,
      }),
  );
  inFlight = run.catch(() => undefined);

  try {
    const res = await run;
    return NextResponse.json({
      status: "ok",
      quote_date: res.quote_date,
      fetched_at: res.fetched_at,
      requested: res.requested,
      fetched: res.fetched,
      reused: res.reused,
      failed: res.failed,
      unknown_symbols: unknown,
      quotes: res.quotes,
    });
  } catch (err) {
    // A quote refresh failing is never fatal to the caller: the page already
    // rendered end-of-day marks and simply keeps them.
    return NextResponse.json(
      { status: "error", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
