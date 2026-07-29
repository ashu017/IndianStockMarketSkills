import { NextRequest, NextResponse } from "next/server";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { evaluateFromDb, type StockVerdict } from "@/lib/verdict";
import { resolveWithDb, type Candidate } from "@/lib/symbol-resolve";

/**
 * GET /api/verdict/<SYMBOL>
 * GET /api/verdict/<SYMBOL>?refresh=1     — force refetch, bypass 24h cache
 * GET /api/verdict/<SYMBOL>?index=NIFTY+200 — prefer a specific index membership
 *
 * Returns a StockVerdict JSON. If fundamentals are older than 24 hours (or the
 * symbol isn't in index_universe at all), a fresh refresh is triggered before
 * evaluation.
 */

const DB_PATH = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";
const CACHE_HOURS = 24;

interface UniverseRow {
  symbol: string;
  exchange: string;
  isin: string;
  sector: string | null;
  instrument_token: number;
}

function pickUniverseRow(db: Database.Database, symbol: string, preferIndex?: string): UniverseRow | undefined {
  // Prefer the requested index; fall back to NIFTY 200 > NIFTY 100 > AD-HOC > any other.
  const priority = [preferIndex, "NIFTY 200", "NIFTY 100", "AD-HOC"].filter(Boolean) as string[];
  for (const idx of priority) {
    const r = db
      .prepare(
        `SELECT symbol, exchange, isin, sector, instrument_token
         FROM index_universe WHERE index_name=? AND symbol=? LIMIT 1`,
      )
      .get(idx, symbol) as UniverseRow | undefined;
    if (r) return r;
  }
  // Fallback: any index_universe row
  return db
    .prepare(
      `SELECT symbol, exchange, isin, sector, instrument_token
       FROM index_universe WHERE symbol=? LIMIT 1`,
    )
    .get(symbol) as UniverseRow | undefined;
}

function runRefresh(symbol: string, force: boolean): { ok: boolean; message?: string } {
  const env = { ...process.env, SYMBOL: symbol, PORTFOLIO_DB_PATH: DB_PATH } as NodeJS.ProcessEnv;
  if (force) env.FORCE = "1";
  const res = spawnSync("npx", ["tsx", "scripts/refresh-single-stock.ts"], {
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
  if (res.status !== 0) {
    return { ok: false, message: (res.stderr || res.stdout || "refresh failed").slice(0, 300) };
  }
  return { ok: true };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ symbol: string }> },
): Promise<NextResponse> {
  const { symbol: raw } = await params;
  const input = decodeURIComponent(raw).trim();
  if (!input) {
    return NextResponse.json({ status: "error", message: "missing symbol" }, { status: 400 });
  }

  const url = new URL(_req.url);
  const force = url.searchParams.get("refresh") === "1";
  const preferIndex = url.searchParams.get("index") ?? undefined;

  const db = new Database(DB_PATH, { readonly: false });
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");

    // Resolve the input (symbol OR name) against index_universe. Return an
    // ambiguity payload if the caller needs to disambiguate.
    const res = resolveWithDb(db, input);
    if (res.kind === "ambiguous") {
      return NextResponse.json(
        { status: "ambiguous", input, candidates: res.candidates as Candidate[] },
        { status: 300 },
      );
    }
    // For "notfound", still allow the arbitrary-Kite path (only if input looks
    // like a valid tradingsymbol — letters, digits, & or -). Names that don't
    // resolve become 404s.
    let symbol: string;
    if (res.kind === "exact") {
      symbol = res.symbol;
    } else {
      const upperCandidate = input.toUpperCase();
      if (!/^[A-Z0-9&\-]+$/.test(upperCandidate)) {
        return NextResponse.json(
          { status: "notfound", message: `no stock matches '${input}'`, input },
          { status: 404 },
        );
      }
      symbol = upperCandidate;
    }

    let row = pickUniverseRow(db, symbol, preferIndex);

    // Decide if we need to refresh: not in DB, or stale beyond CACHE_HOURS, or explicit force.
    let shouldRefresh = force || !row;
    let ageHours: number | null = null;
    if (row && !shouldRefresh) {
      const r = db
        .prepare(`SELECT fetched_at FROM fundamentals WHERE isin=? ORDER BY fetched_at DESC LIMIT 1`)
        .get(row.isin) as { fetched_at: string } | undefined;
      if (!r) {
        shouldRefresh = true;
      } else {
        ageHours = (Date.now() - new Date(r.fetched_at).getTime()) / 3600_000;
        if (ageHours > CACHE_HOURS) shouldRefresh = true;
      }
    }

    let refreshResult: { ok: boolean; message?: string } | null = null;
    if (shouldRefresh) {
      db.close();
      refreshResult = runRefresh(symbol, force);
      if (!refreshResult.ok) {
        return NextResponse.json(
          { status: "error", message: refreshResult.message ?? "refresh failed", symbol },
          { status: 502 },
        );
      }
      // Reopen and re-resolve universe row
      const db2 = new Database(DB_PATH, { readonly: false });
      row = pickUniverseRow(db2, symbol, preferIndex);
      if (!row) {
        db2.close();
        return NextResponse.json(
          { status: "error", message: `symbol ${symbol} not found in Kite instruments`, symbol },
          { status: 404 },
        );
      }
      const verdict = evaluateFromDb(db2, row);
      db2.close();
      return NextResponse.json({ status: "ok", refreshed: true, verdict } satisfies { status: string; refreshed: boolean; verdict: StockVerdict });
    }

    if (!row) {
      return NextResponse.json(
        { status: "error", message: `symbol ${symbol} not found`, symbol },
        { status: 404 },
      );
    }
    const verdict = evaluateFromDb(db, row);
    return NextResponse.json({
      status: "ok",
      refreshed: false,
      cache_age_hours: ageHours,
      verdict,
    });
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
}
