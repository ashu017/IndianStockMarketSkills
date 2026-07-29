import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Fetch live (intraday) LTP + day-high/low/volume for every symbol in
 * `index_universe` from NSE's public NextApi endpoint (`getPeerComparisonData`).
 * ~2-5 minute delay, no auth, free.
 *
 * Design:
 *   - Concurrency 4 (polite; NSE is public-cache-friendly but 8-10 concurrent
 *     starts drawing 429s on us empirically)
 *   - One call per symbol; response gives ltp + PChange for THIS symbol at
 *     result[0] (target is always first). We also observe 5-7 peers "for free"
 *     but the peer LTPs are current too — we opportunistically cache them.
 *   - Idempotent — same-day rows are overwritten (ltp updates in place).
 *   - Persists to ohlc_intraday. Scanner reads this for today's price if present.
 *
 * Env:
 *   PORTFOLIO_DB_PATH=./data/portfolio.db
 *   INDEX_NAME       optional; restrict to one index (default: all universe)
 *   ONLY_SYMBOLS     comma-separated for testing
 *   CONCURRENCY      default 4
 *   REQUEST_DELAY_MS default 200 (between batches, per concurrent slot)
 */

const BASE_URL =
  "https://www.nseindia.com/api/NextApi/apiClient/GetQuoteApi?functionName=getPeerComparisonData&type=S&quarter=&param=industry&index=&symbol=";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

interface UniverseRow {
  symbol: string;
  instrument_token: number;
}

interface PeerRow {
  symbol: string;
  ltp: number | null;
  volume: number | null;
  PChange: number | null;
  marketCap: number | null;
}

function istDate(now = Date.now()): string {
  return new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);
}

function rsToPaise(n: number | null): number | null {
  if (n === null || !Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

async function fetchOne(symbol: string): Promise<PeerRow[] | null> {
  try {
    const res = await fetch(BASE_URL + encodeURIComponent(symbol), {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json,*/*;q=0.9",
        "Accept-Language": "en-IN,en;q=0.9",
      },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as PeerRow[];
    if (!Array.isArray(j)) return null;
    return j;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const dbPath = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";
  const indexName = process.env.INDEX_NAME ?? null;
  const onlySymbols = process.env.ONLY_SYMBOLS
    ? new Set(process.env.ONLY_SYMBOLS.split(",").map((s) => s.trim()))
    : null;
  const concurrency = Number(process.env.CONCURRENCY ?? "4");
  const requestDelayMs = Number(process.env.REQUEST_DELAY_MS ?? "200");

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync("db/schema.sql", "utf8"));

  const universeQuery = indexName
    ? `SELECT DISTINCT symbol, instrument_token FROM index_universe WHERE index_name = ? ORDER BY symbol`
    : `SELECT DISTINCT symbol, instrument_token FROM index_universe ORDER BY symbol`;
  const universe = (indexName
    ? db.prepare(universeQuery).all(indexName)
    : db.prepare(universeQuery).all()) as UniverseRow[];
  let work = universe;
  if (onlySymbols) work = work.filter((u) => onlySymbols.has(u.symbol));

  const symToToken = new Map<string, number>();
  for (const u of universe) symToToken.set(u.symbol, u.instrument_token);

  const quoteDate = istDate();
  const fetchedAt = new Date().toISOString();

  const upsert = db.prepare(
    `INSERT INTO ohlc_intraday(instrument_token, quote_date, ltp, day_high, day_low, day_volume, perc_change, fetched_at)
     VALUES(@instrument_token, @quote_date, @ltp, @day_high, @day_low, @day_volume, @perc_change, @fetched_at)
     ON CONFLICT(instrument_token, quote_date) DO UPDATE SET
       ltp=excluded.ltp,
       day_high=COALESCE(excluded.day_high, ohlc_intraday.day_high),
       day_low=COALESCE(excluded.day_low, ohlc_intraday.day_low),
       day_volume=excluded.day_volume,
       perc_change=excluded.perc_change,
       fetched_at=excluded.fetched_at`,
  );

  let fetched = 0, failed = 0, opportunistic = 0;

  // Simple concurrency pool
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= work.length) return;
      const u = work[idx];
      const rows = await fetchOne(u.symbol);
      if (!rows) {
        failed++;
        await sleep(requestDelayMs);
        continue;
      }
      // Target symbol is always in the response (usually index 0 but not always)
      const target = rows.find((r) => r.symbol === u.symbol);
      const persisted: { symbol: string; token: number; row: PeerRow }[] = [];
      if (target) persisted.push({ symbol: u.symbol, token: u.instrument_token, row: target });
      // Opportunistic: also cache peer rows that are in our universe
      for (const r of rows) {
        if (r.symbol === u.symbol) continue;
        const tok = symToToken.get(r.symbol);
        if (tok !== undefined) persisted.push({ symbol: r.symbol, token: tok, row: r });
      }

      const tx = db.transaction(() => {
        for (const p of persisted) {
          if (p.row.ltp === null || !Number.isFinite(p.row.ltp)) continue;
          upsert.run({
            instrument_token: p.token,
            quote_date: quoteDate,
            ltp: rsToPaise(p.row.ltp)!,
            day_high: null,
            day_low: null,
            day_volume: p.row.volume ?? null,
            perc_change: p.row.PChange ?? null,
            fetched_at: fetchedAt,
          });
          if (p.symbol === u.symbol) fetched++;
          else opportunistic++;
        }
      });
      tx();
      await sleep(requestDelayMs);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const total = (db.prepare(`SELECT COUNT(*) as n FROM ohlc_intraday WHERE quote_date = ?`).get(quoteDate) as { n: number }).n;
  db.close();

  process.stdout.write(
    JSON.stringify({
      status: "ok",
      quote_date: quoteDate,
      requested: work.length,
      fetched,
      opportunistic_peers: opportunistic,
      failed,
      total_intraday_rows_today: total,
    }) + "\n",
  );
}

main().catch((err) => {
  process.stdout.write(
    JSON.stringify({ status: "error", message: err instanceof Error ? err.message : String(err) }) + "\n",
  );
  process.exit(1);
});
