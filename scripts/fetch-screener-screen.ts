import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Fetch a Screener /screen/raw/ query using stored session cookies. One HTTP
 * call returns 50 stocks per page; the fetcher pages until all results are in.
 * Persists into screener_screen_cache keyed by sha256(query + run_date + symbol).
 *
 * The scanner reads the latest run of a given query and treats those symbols as
 * the "quality-approved pool" — replacing the per-stock get_fundamentals loop
 * that used to take 5-10 minutes at 3s pacing.
 *
 * Env:
 *   PORTFOLIO_DB_PATH=./data/portfolio.db
 *   QUERY=<Screener DSL>       — the filter query; default = tightened v1 recipe at Mcap>20000
 *   SCREENER_CSRF_TOKEN        — from .env
 *   SCREENER_SESSION_ID        — from .env
 *   MAX_PAGES=10               — safety cap; each page = 50 stocks, so 10 = up to 500
 *   MAX_MCAP=                  — optional upper cap on Market Capitalization (rare, mostly for testing)
 *
 * Auth: Screener free tier requires a logged-in browser session. Cookies expire
 * after ~2 weeks of inactivity. If a fetch returns 302 to /register/, we surface
 * that clearly so the caller knows to rotate cookies.
 */

const DEFAULT_QUERY =
  "Return on capital employed > 15 AND " +
  "Return on equity > 15 AND " +
  "Debt to equity < 1 AND " +
  "Sales growth 3Years > 10 AND " +
  "Profit growth 3Years > 10 AND " +
  "YOY Quarterly profit growth > 10 AND " +
  "Piotroski score >= 7 AND " +
  "Pledged percentage < 20 AND " +
  "Interest Coverage Ratio > 3 AND " +
  "Promoter holding > 40 AND " +
  "Market Capitalization > 5000";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

function loadEnv(): void {
  try {
    for (const line of readFileSync(".env", "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* ok */ }
}

function istDate(now = Date.now()): string {
  return new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);
}

function hashQuery(q: string): string {
  return createHash("sha256").update(q).digest("hex").slice(0, 16);
}

interface ParsedRow {
  symbol: string;        // NSE tradingsymbol (mapped)
  displayName: string;   // Screener's company name (raw)
  screenerId: string | null; // slug from /company/<id>/
  metrics: Record<string, string>;
}

/**
 * Parse one HTML page of Screener /screen/raw/ results.
 * Extracts every stock row (each has a link to /company/<id>/) plus the value
 * of each visible column by header name.
 */
function parsePage(html: string, columnHeaders: string[] | null): {
  rows: ParsedRow[];
  headers: string[];
  totalResults: number | null;
} {
  const stripTags = (s: string): string => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  // Total result count (e.g. "45 results found")
  const totalMatch = html.match(/(\d+)\s*results?\s*found/i);
  const totalResults = totalMatch ? Number(totalMatch[1]) : null;

  // First table = the results table. Header cells define column order.
  const tblMatch = html.match(/<table[^>]*>([\s\S]*?)<\/table>/);
  if (!tblMatch) return { rows: [], headers: [], totalResults };
  const tblBody = tblMatch[1];

  let headers = columnHeaders;
  if (!headers) {
    // Extract headers by capturing content between <th …> and </th>
    headers = Array.from(tblBody.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g))
      .map((m) => stripTags(m[1]))
      .filter((h) => h.length > 0);
    // Screener duplicates the header block per group of 5 rows; keep only the first block.
    const firstIdx = headers.indexOf("S.No.");
    const secondIdx = headers.indexOf("S.No.", firstIdx + 1);
    if (firstIdx >= 0 && secondIdx > firstIdx) headers = headers.slice(firstIdx, secondIdx);
  }

  const rows: ParsedRow[] = [];
  const rowMatches = tblBody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g);
  for (const rm of rowMatches) {
    const rowHtml = rm[1];
    // Data rows have a link to /company/…
    const linkMatch = rowHtml.match(/<a[^>]+href="\/company\/([^\/]+)\/[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    if (!linkMatch) continue;
    const screenerId = linkMatch[1];
    const displayName = stripTags(linkMatch[2]);

    const cells = Array.from(rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)).map((m) =>
      stripTags(m[1]),
    );
    if (cells.length < headers.length) continue;

    const metrics: Record<string, string> = {};
    for (let i = 0; i < headers.length && i < cells.length; i++) {
      metrics[headers[i]] = cells[i];
    }
    // We resolve Screener's company name → NSE symbol later using our own
    // nifty200/nifty500 seed maps. For now store the display name; the
    // caller does the mapping.
    rows.push({ symbol: "", displayName, screenerId, metrics });
  }

  return { rows, headers, totalResults };
}

/**
 * Screener's display name is like "Reliance Industr" or "TCS" — sometimes the
 * NSE tradingsymbol is a straight prefix, sometimes it's abbreviated. We resolve
 * by fuzzy-matching against our seeded universe (index_universe.company).
 */
/**
 * Aggressive normalization for name matching. Handles HTML entities (`&amp;`
 * for `&`), truncation ("Reliance Industr" vs "Reliance Industries Ltd."), and
 * common suffixes.
 */
function normalizeName(s: string): string {
  return s
    .toLowerCase()
    // HTML entity decode (only the common ones Screener emits)
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    // strip trailing dots + common corporate suffixes
    .replace(/\.\s*$/g, "")
    .replace(/\bltd\.?\b/g, "")
    .replace(/\blimited\b/g, "")
    .replace(/\bcorporation\b/g, "corp")
    .replace(/\bindustries\b/g, "ind")
    .replace(/\bcompany\b/g, "co")
    // squash everything to alphanumeric only
    .replace(/[^a-z0-9]+/g, "");
}

function buildNameToSymbolMap(db: Database.Database): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT symbol, company FROM index_universe WHERE company IS NOT NULL AND company != ''`,
    )
    .all() as { symbol: string; company: string }[];
  const map = new Map<string, string>();
  for (const r of rows) {
    map.set(normalizeName(r.company), r.symbol);
    map.set(r.symbol.toLowerCase(), r.symbol);
  }
  return map;
}

function mapDisplayToSymbol(displayName: string, map: Map<string, string>): string | null {
  const norm = normalizeName(displayName);
  if (!norm) return null;
  if (map.has(norm)) return map.get(norm)!;
  // Prefix match — Screener truncates long names. Give the longer side priority:
  // if universe key starts with the (shorter) Screener normalized name → hit.
  for (const [k, v] of map.entries()) {
    if (k.length >= norm.length && k.startsWith(norm)) return v;
  }
  // Substring match as a final fallback (catches "Motors" prefixed by "Tata "…)
  for (const [k, v] of map.entries()) {
    if (k.includes(norm) || norm.includes(k)) return v;
  }
  return null;
}

async function fetchPage(query: string, page: number): Promise<{ status: number; html: string }> {
  const csrf = process.env.SCREENER_CSRF_TOKEN;
  const sess = process.env.SCREENER_SESSION_ID;
  if (!csrf || !sess) {
    throw new Error("SCREENER_CSRF_TOKEN and SCREENER_SESSION_ID must be set in .env");
  }
  const url = `https://www.screener.in/screen/raw/?sort=&order=&source_id=&query=${encodeURIComponent(query)}&page=${page}`;
  const res = await fetch(url, {
    headers: {
      "Cookie": `csrftoken=${csrf}; sessionid=${sess}`,
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Referer": "https://www.screener.in/screen/new/",
      "Accept-Language": "en-IN,en;q=0.9",
    },
    redirect: "manual",
  });
  const html = await res.text();
  return { status: res.status, html };
}

async function main(): Promise<void> {
  loadEnv();
  const dbPath = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";
  const query = process.env.QUERY ?? DEFAULT_QUERY;
  const maxPages = Number(process.env.MAX_PAGES ?? "10");
  const queryHash = hashQuery(query);
  const runDate = istDate();
  const runTs = new Date().toISOString();

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync("db/schema.sql", "utf8"));

  const nameMap = buildNameToSymbolMap(db);

  let headers: string[] | null = null;
  let totalResults: number | null = null;
  const allRows: ParsedRow[] = [];
  let pagesFetched = 0;

  for (let page = 1; page <= maxPages; page++) {
    const { status, html } = await fetchPage(query, page);
    if (status === 302 || status === 301) {
      db.close();
      process.stdout.write(
        JSON.stringify({ status: "error", message: "cookies expired — got redirect. Rotate SCREENER_CSRF_TOKEN + SCREENER_SESSION_ID in .env" }) + "\n",
      );
      process.exit(2);
      return;
    }
    if (status !== 200) {
      process.stderr.write(`[fetch-screener-screen] page ${page} HTTP ${status} — stopping\n`);
      break;
    }
    const { rows, headers: pageHeaders, totalResults: totalNow } = parsePage(html, headers);
    if (totalResults === null) totalResults = totalNow;
    if (!headers) headers = pageHeaders;
    if (rows.length === 0) break;
    allRows.push(...rows);
    pagesFetched++;
    if (totalResults !== null && allRows.length >= totalResults) break;
    // Polite pause between pages
    await new Promise((r) => setTimeout(r, 400));
  }

  // Build the set of ALL NSE tradingsymbols from the Kite instruments dump —
  // that's ~6000 stocks, covering everything Screener might return. If the dump
  // isn't cached, fall back to just the seeded index_universe.
  const knownSymbols = new Set<string>();
  try {
    const kitecsv = readFileSync("/tmp/kite-instruments.csv", "utf8");
    // header: instrument_token,exchange_token,tradingsymbol,name,...,exchange
    const lines = kitecsv.split("\n");
    const header = lines[0].split(",");
    const iTsym = header.indexOf("tradingsymbol");
    const iType = header.indexOf("instrument_type");
    const iSeg = header.indexOf("segment");
    const iExch = header.indexOf("exchange");
    for (let i = 1; i < lines.length; i++) {
      const f = lines[i].split(",");
      if (f.length < iExch + 1) continue;
      if (f[iExch] !== "NSE" || f[iType] !== "EQ" || f[iSeg] !== "NSE") continue;
      knownSymbols.add(f[iTsym].replace(/^"|"$/g, "").trim());
    }
  } catch {
    for (const r of db.prepare(`SELECT DISTINCT symbol FROM index_universe`).all() as { symbol: string }[]) {
      knownSymbols.add(r.symbol);
    }
  }

  const unmapped: string[] = [];
  for (const row of allRows) {
    // Prefer Screener's slug — it's almost always the NSE tradingsymbol. HTML
    // entities like &amp; need decoding.
    let sym: string | null = null;
    if (row.screenerId) {
      const cleaned = row.screenerId.replace(/&amp;/g, "&");
      if (knownSymbols.has(cleaned)) sym = cleaned;
    }
    // Fallback: fuzzy name match against the seeded universe
    if (!sym) sym = mapDisplayToSymbol(row.displayName, nameMap);
    if (sym) row.symbol = sym;
    else unmapped.push(row.displayName);
  }

  // Auto-seed any Screener-approved stock that isn't already in index_universe.
  // These are typically small-caps below Nifty 500's cutoff. The scanner needs
  // OHLC to score them; without a seed, they'd be dropped silently.
  const seedInto = db.prepare(
    `INSERT INTO index_universe(index_name, symbol, exchange, isin, tradingsymbol, instrument_token, company, sector, as_of_date)
     VALUES('AD-HOC', @symbol, 'NSE', @isin, @tradingsymbol, @token, @company, '', date('now'))
     ON CONFLICT(index_name, symbol, exchange) DO NOTHING`,
  );
  // Load the Kite tradingsymbol → instrument_token map once
  const kiteMap = new Map<string, { token: number; name: string }>();
  try {
    const kitecsv = readFileSync("/tmp/kite-instruments.csv", "utf8");
    const kl = kitecsv.split("\n");
    const kh = kl[0].split(",");
    const kIT = kh.indexOf("instrument_token");
    const kITs = kh.indexOf("tradingsymbol");
    const kNm = kh.indexOf("name");
    const kTy = kh.indexOf("instrument_type");
    const kSg = kh.indexOf("segment");
    const kEx = kh.indexOf("exchange");
    for (let i = 1; i < kl.length; i++) {
      const f = kl[i].split(",");
      if (f.length < kEx + 1) continue;
      if (f[kEx] !== "NSE" || f[kTy] !== "EQ" || f[kSg] !== "NSE") continue;
      const tsym = f[kITs].replace(/^"|"$/g, "").trim();
      kiteMap.set(tsym, { token: Number(f[kIT]), name: f[kNm].replace(/^"|"$/g, "").trim() });
    }
  } catch { /* Kite dump not cached — small-cap auto-seed will silently skip */ }

  const existing = new Set<string>(
    (db.prepare(`SELECT DISTINCT symbol FROM index_universe`).all() as { symbol: string }[])
      .map((r) => r.symbol),
  );
  let seededSmall = 0;
  for (const row of allRows) {
    if (!row.symbol) continue;
    if (existing.has(row.symbol)) continue;
    const k = kiteMap.get(row.symbol);
    if (!k) continue; // symbol not in Kite dump — bail
    seedInto.run({
      symbol: row.symbol,
      isin: `SYM-${row.symbol}`,
      tradingsymbol: row.symbol,
      token: k.token,
      company: row.displayName || k.name,
    });
    seededSmall++;
  }

  // Persist
  const upsert = db.prepare(
    `INSERT INTO screener_screen_cache(query_hash, run_date, run_ts, symbol, company, screener_id, metrics)
     VALUES(@query_hash, @run_date, @run_ts, @symbol, @company, @screener_id, @metrics)
     ON CONFLICT(query_hash, run_date, symbol) DO UPDATE SET
       run_ts=excluded.run_ts, company=excluded.company, screener_id=excluded.screener_id,
       metrics=excluded.metrics`,
  );
  const tx = db.transaction(() => {
    for (const r of allRows) {
      if (!r.symbol) continue; // skip unmapped
      upsert.run({
        query_hash: queryHash,
        run_date: runDate,
        run_ts: runTs,
        symbol: r.symbol,
        company: r.displayName,
        screener_id: r.screenerId,
        metrics: JSON.stringify(r.metrics),
      });
    }
  });
  tx();
  db.close();

  process.stdout.write(
    JSON.stringify({
      status: "ok",
      query_hash: queryHash,
      run_date: runDate,
      total_results: totalResults,
      pages_fetched: pagesFetched,
      rows_persisted: allRows.filter((r) => r.symbol).length,
      small_caps_seeded: seededSmall,
      unmapped_count: unmapped.length,
      unmapped_sample: unmapped.slice(0, 5),
      query,
    }) + "\n",
  );
}

main().catch((err) => {
  process.stdout.write(
    JSON.stringify({ status: "error", message: err instanceof Error ? err.message : String(err) }) + "\n",
  );
  process.exit(1);
});
