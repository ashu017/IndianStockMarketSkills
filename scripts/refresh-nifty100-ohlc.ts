import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Refresh daily OHLC for every DISTINCT constituent of `index_universe` (union
 * across every index we track) using the NSE **bhavcopy**
 * (`sec_bhavdata_full_DDMMYYYY.csv`). One HTTP request per trading day returns
 * every EQ segment row — so N stocks × 400 days is still ~275 requests
 * (skipping weekends). Free, official NSE source. No Kite quota.
 *
 * Behaviour:
 * - Enumerates weekdays from (today − OHLC_DAYS) back to today.
 * - For each candidate date, fetch the bhavcopy. If NSE serves the previous
 *   trading day's data (weekends, holidays), the file's DATE1 column will not
 *   match the requested date — we treat that as "already fetched under the
 *   real trade date" and skip the duplicate.
 * - Filters each CSV to the universe symbols (from index_universe) and upserts
 *   rows into ohlc_daily.
 *
 * Idempotent — repeated runs re-fetch only trade dates not already present.
 *
 * Env:
 *   PORTFOLIO_DB_PATH=./data/portfolio.db
 *   OHLC_DAYS=400        # calendar-day lookback window
 *   INDEX_NAME=          # restrict to a single index (e.g. "NIFTY 200"); default = all
 *   ONLY_DATE=YYYY-MM-DD # fetch just this one trade date and exit
 *   FORCE=1              # re-fetch every date even if present in DB
 */

const BHAV_URL = (ddmmyyyy: string) =>
  `https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${ddmmyyyy}.csv`;

const USER_AGENT = "Mozilla/5.0 (compatible; nifty100-scanner/1.0)";

interface UniverseRow {
  symbol: string;
  exchange: string;
  instrument_token: number;
}

// bhavcopy columns (header contains leading spaces after commas — trim on parse):
// SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE,
// CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER

function fmtDdMmYyyy(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${dd}${mm}${yyyy}`;
}

function fmtIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** DD-Mon-YYYY (as bhavcopy writes DATE1, e.g. "21-Jul-2026") → YYYY-MM-DD (IST). */
function parseBhavDate(s: string): string | null {
  const m = s.match(/^(\d{2})-(\w{3})-(\d{4})$/);
  if (!m) return null;
  const months: Record<string, string> = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
  };
  const mm = months[m[2]];
  if (!mm) return null;
  return `${m[3]}-${mm}-${m[1]}`;
}

function rsToPaise(rs: number): number {
  return Math.round(rs * 100);
}

/** Enumerate weekday (Mon-Fri) UTC dates going back `days` days from `to`. */
function weekdaysBack(to: Date, days: number): Date[] {
  const out: Date[] = [];
  const cur = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  const dayMs = 24 * 3600 * 1000;
  for (let i = 0; i <= days; i++) {
    const d = new Date(cur.getTime() - i * dayMs);
    const dow = d.getUTCDay(); // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6) out.push(d);
  }
  return out;
}

interface BhavRow {
  symbol: string;
  tradeDate: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function parseBhavCsv(csv: string): BhavRow[] {
  const lines = csv.trim().split("\n");
  const rows: BhavRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",").map((s) => s.trim());
    if (parts.length < 15) continue;
    const [symbol, series, date1, , open, high, low, , close, , volume] = parts;
    if (series !== "EQ") continue;
    const td = parseBhavDate(date1);
    if (!td) continue;
    const o = Number(open), h = Number(high), l = Number(low), c = Number(close), v = Number(volume);
    if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) continue;
    rows.push({ symbol, tradeDate: td, open: o, high: h, low: l, close: c, volume: v });
  }
  return rows;
}

async function fetchBhav(dateDdMmYyyy: string): Promise<string | null> {
  const res = await fetch(BHAV_URL(dateDdMmYyyy), {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "text/csv,*/*;q=0.9",
      "Accept-Language": "en-IN,en;q=0.9",
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`bhavcopy HTTP ${res.status} for ${dateDdMmYyyy}`);
  return await res.text();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const dbPath = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";
  const days = Number(process.env.OHLC_DAYS ?? "400");
  const onlyDate = process.env.ONLY_DATE ?? null; // YYYY-MM-DD
  const force = process.env.FORCE === "1";
  const indexNameFilter = process.env.INDEX_NAME ?? null;

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync("db/schema.sql", "utf8"));

  // Load universe from index_universe. DISTINCT across index memberships so a
  // stock in both NIFTY 100 and NIFTY 200 doesn't get double-processed.
  const universeQuery = indexNameFilter
    ? `SELECT DISTINCT symbol, exchange, instrument_token FROM index_universe WHERE index_name = ? ORDER BY symbol`
    : `SELECT DISTINCT symbol, exchange, instrument_token FROM index_universe ORDER BY symbol`;
  const universeRows = indexNameFilter
    ? (db.prepare(universeQuery).all(indexNameFilter) as UniverseRow[])
    : (db.prepare(universeQuery).all() as UniverseRow[]);
  const symToToken = new Map<string, number>();
  for (const u of universeRows) symToToken.set(u.symbol, u.instrument_token);

  // Which trade dates already present per token? Used to skip no-op fetches.
  const existingDatesByToken = new Map<number, Set<string>>();
  for (const r of db
    .prepare(`SELECT instrument_token, trade_date FROM ohlc_daily`)
    .all() as { instrument_token: number; trade_date: string }[]) {
    let s = existingDatesByToken.get(r.instrument_token);
    if (!s) {
      s = new Set();
      existingDatesByToken.set(r.instrument_token, s);
    }
    s.add(r.trade_date);
  }

  const upsert = db.prepare(
    `INSERT INTO ohlc_daily(instrument_token, trade_date, open, high, low, close, volume, fetched_at)
     VALUES(@instrument_token, @trade_date, @open, @high, @low, @close, @volume, @fetched_at)
     ON CONFLICT(instrument_token, trade_date) DO UPDATE SET
       open=excluded.open, high=excluded.high, low=excluded.low,
       close=excluded.close, volume=excluded.volume, fetched_at=excluded.fetched_at`,
  );

  const now = new Date();
  const candidates: Date[] = onlyDate ? [new Date(`${onlyDate}T00:00:00Z`)] : weekdaysBack(now, days);
  const fetchedAt = new Date().toISOString();

  // Track which (token, date) we've already inserted this run so a bhavcopy served
  // for an earlier trade date (weekend fallback) doesn't get re-inserted for the
  // same date across two loop iterations.
  const seenInsertKeys = new Set<string>();

  let fetchedFiles = 0;
  let insertedRows = 0;
  let skippedDup = 0;
  let notFound = 0;
  const errors: { date: string; message: string }[] = [];

  for (const d of candidates) {
    const requestedDate = fmtIso(d);
    // Cheap early-skip: if every Nifty 100 token already has this exact date, don't fetch.
    if (!force) {
      let allHave = true;
      for (const tok of symToToken.values()) {
        if (!existingDatesByToken.get(tok)?.has(requestedDate)) {
          allHave = false;
          break;
        }
      }
      if (allHave) continue;
    }

    const ddmmyyyy = fmtDdMmYyyy(d);
    let csv: string | null = null;
    try {
      csv = await fetchBhav(ddmmyyyy);
    } catch (err) {
      errors.push({ date: requestedDate, message: err instanceof Error ? err.message : String(err) });
      // Back off briefly on transient failures.
      await sleep(2000);
      continue;
    }
    if (!csv) {
      notFound++;
      continue;
    }
    fetchedFiles++;

    const rows = parseBhavCsv(csv);
    // Filter to Nifty 100 symbols.
    const relevant = rows.filter((r) => symToToken.has(r.symbol));

    const tx = db.transaction(() => {
      for (const r of relevant) {
        const token = symToToken.get(r.symbol)!;
        const key = `${token}|${r.tradeDate}`;
        if (seenInsertKeys.has(key)) {
          skippedDup++;
          continue;
        }
        seenInsertKeys.add(key);

        // Also skip if the DB already has an entry AND !force.
        if (!force && existingDatesByToken.get(token)?.has(r.tradeDate)) {
          skippedDup++;
          continue;
        }

        upsert.run({
          instrument_token: token,
          trade_date: r.tradeDate,
          open: rsToPaise(r.open),
          high: rsToPaise(r.high),
          low: rsToPaise(r.low),
          close: rsToPaise(r.close),
          volume: r.volume,
          fetched_at: fetchedAt,
        });
        insertedRows++;

        let s = existingDatesByToken.get(token);
        if (!s) {
          s = new Set();
          existingDatesByToken.set(token, s);
        }
        s.add(r.tradeDate);
      }
    });
    tx();

    // Small pause between requests to be polite (NSE will 429 aggressive clients).
    await sleep(200);
  }

  const totalBars = (
    db.prepare(`SELECT COUNT(*) as n FROM ohlc_daily`).get() as { n: number }
  ).n;
  const dateSpan = db
    .prepare(`SELECT MIN(trade_date) as mn, MAX(trade_date) as mx FROM ohlc_daily`)
    .get() as { mn: string | null; mx: string | null };

  db.close();
  process.stdout.write(
    JSON.stringify({
      status: errors.length ? "partial" : "ok",
      fetched_files: fetchedFiles,
      inserted_rows: insertedRows,
      skipped_duplicate: skippedDup,
      not_found: notFound,
      errors: errors.slice(0, 5),
      total_bars_in_db: totalBars,
      date_range: `${dateSpan.mn ?? "-"} to ${dateSpan.mx ?? "-"}`,
    }) + "\n",
  );
}

main().catch((err) => {
  process.stdout.write(
    JSON.stringify({ status: "error", message: err instanceof Error ? err.message : String(err) }) + "\n",
  );
  process.exit(1);
});
