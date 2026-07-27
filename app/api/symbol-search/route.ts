import { NextRequest, NextResponse } from "next/server";
import Database from "better-sqlite3";

/**
 * GET /api/symbol-search?q=TC → returns up to 10 matching symbols from
 * index_universe. Case-insensitive prefix + substring match on symbol and
 * company name, ranked by (a) prefix on symbol > (b) prefix on company > (c)
 * substring on symbol > (d) substring on company. Used by the home-page
 * search autocomplete.
 */

const DB_PATH = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim().toUpperCase();
  if (!q) return NextResponse.json({ status: "ok", results: [] });

  const db = new Database(DB_PATH, { readonly: true });
  try {
    // Union DISTINCT across all index memberships. LIKE with UPPER for case-insensitive match.
    const rows = db
      .prepare(
        `SELECT DISTINCT symbol, company, sector
         FROM index_universe
         WHERE UPPER(symbol) LIKE ? OR UPPER(company) LIKE ?
         ORDER BY
           CASE
             WHEN UPPER(symbol) = ? THEN 0
             WHEN UPPER(symbol) LIKE ? THEN 1
             WHEN UPPER(company) LIKE ? THEN 2
             ELSE 3
           END,
           symbol
         LIMIT 10`,
      )
      .all(`%${q}%`, `%${q}%`, q, `${q}%`, `${q}%`) as {
      symbol: string;
      company: string | null;
      sector: string | null;
    }[];

    return NextResponse.json({
      status: "ok",
      results: rows.map((r) => ({
        symbol: r.symbol,
        company: r.company ?? "",
        sector: r.sector ?? "",
      })),
    });
  } finally {
    db.close();
  }
}
