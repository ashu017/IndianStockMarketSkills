import Database from "better-sqlite3";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * On-demand refresh for a single stock symbol. Used by:
 *   - /api/verdict/[symbol]?refresh=1 (UI force-refresh button)
 *   - Telegram /check <symbol> handler
 *   - Any interactive research flow
 *
 * Behaviour:
 *   1. Look up the symbol in index_universe. If not present, seed it from
 *      the Kite instruments dump (arbitrary NSE-stock support).
 *   2. Top up OHLC from NSE bhavcopy for the last ~30 trading days
 *      (idempotent; only fetches dates missing from ohlc_daily).
 *   3. Fetch Screener get_fundamentals + get_financials, parse deterministically,
 *      upsert into fundamentals + fundamentals_extra.
 *   4. Print a JSON summary.
 *
 * Env:
 *   SYMBOL=<sym>           (required)
 *   PORTFOLIO_DB_PATH=./data/portfolio.db
 *   FORCE=1                (skip 24h cache check, always refetch)
 *   SKIP_OHLC=1            (skip bhavcopy top-up)
 *   SKIP_FUNDAMENTALS=1    (skip Screener fetch)
 */

const SCREENER_MCP_PATH = "/home/ashunsah/workplace/screener-mcp/dist/index.js";
const REQUEST_TIMEOUT_MS = 15000;
const FINANCIALS_SECTORS = new Set(["Financial Services", "Banks", "Financials"]);
const CACHE_HOURS = 24;

interface SeedRow {
  symbol: string;
  exchange: "NSE";
  isin: string;
  tradingsymbol: string;
  instrument_token: number;
  company: string;
  sector: string;
}

// -------------- Screener MCP over stdio (same pattern as fetch-financials-parse.ts) --------------

interface McpClient {
  proc: ChildProcessWithoutNullStreams;
  nextId: number;
  pendingByLine: Map<number, (v: unknown) => void>;
  buf: string;
}

function startScreenerMcp(): Promise<McpClient> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [SCREENER_MCP_PATH], { stdio: ["pipe", "pipe", "pipe"] });
    const client: McpClient = { proc, nextId: 1, pendingByLine: new Map(), buf: "" };
    proc.stdout.on("data", (chunk: Buffer) => {
      client.buf += chunk.toString();
      let i;
      while ((i = client.buf.indexOf("\n")) !== -1) {
        const line = client.buf.slice(0, i).trim();
        client.buf = client.buf.slice(i + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { id?: number };
          if (typeof msg.id === "number" && client.pendingByLine.has(msg.id)) {
            client.pendingByLine.get(msg.id)!(msg);
            client.pendingByLine.delete(msg.id);
          }
        } catch { /* ignore */ }
      }
    });
    proc.stderr.on("data", () => { /* discard */ });
    proc.on("error", reject);
    const initId = client.nextId++;
    client.pendingByLine.set(initId, () => resolve(client));
    proc.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: initId,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "refresh-single", version: "1" } },
      }) + "\n",
    );
  });
}

function mcpCall(client: McpClient, tool: string, args: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = client.nextId++;
    const timer = setTimeout(() => {
      client.pendingByLine.delete(id);
      reject(new Error(`timeout on ${tool}(${JSON.stringify(args)})`));
    }, REQUEST_TIMEOUT_MS);
    client.pendingByLine.set(id, (msg: unknown) => {
      clearTimeout(timer);
      const m = msg as { result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message?: string } };
      if (m.error) return reject(new Error(m.error.message ?? "mcp error"));
      const text = m.result?.content?.[0]?.text;
      if (!text) return reject(new Error("no text content"));
      if (m.result?.isError === true) return reject(new Error(`upstream:${text.slice(0, 80)}`));
      try { resolve(JSON.parse(text)); }
      catch (e) { reject(new Error(`invalid json: ${e instanceof Error ? e.message : e}`)); }
    });
    client.proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args } }) + "\n",
    );
  });
}

// -------------- Screener parsing (deterministic; mirrors fetch-financials-parse.ts) --------------

interface FinSection { section: string; columns: string[]; rows: { label?: string; name?: string; values: (string | number)[] }[] }
interface FundamentalsCard { symbol?: string; ratios?: { name: string; value: string }[] }

function num(s: unknown): number | null {
  if (s === null || s === undefined) return null;
  const str = String(s).replace(/[₹%×,\s]|Cr\.?/g, "").trim();
  if (!str || str === "-" || str === "NA") return null;
  const v = Number(str);
  return Number.isFinite(v) ? v : null;
}
function findRow(section: FinSection | undefined, patterns: (string | RegExp)[]) {
  if (!section) return null;
  for (const r of section.rows) {
    const label = (r.label ?? r.name ?? "").trim();
    for (const p of patterns) {
      if (typeof p === "string" ? label.includes(p) : p.test(label)) return r;
    }
  }
  return null;
}
function threeYearCagr(section: FinSection | undefined, patterns: (string | RegExp)[]): number | null {
  if (!section) return null;
  const row = findRow(section, patterns);
  if (!row) return null;
  const cols = section.columns;
  let endIdx = cols.length - 1;
  if (cols[endIdx] === "TTM") endIdx -= 1;
  const startIdx = endIdx - 3;
  if (startIdx < 0 || endIdx <= startIdx) return null;
  const s = num(row.values[startIdx]);
  const e = num(row.values[endIdx]);
  if (s === null || e === null || s <= 0 || e <= 0) return null;
  return (Math.pow(e / s, 1 / 3) - 1) * 100;
}
function latestOf(section: FinSection | undefined, patterns: (string | RegExp)[]): number | null {
  if (!section) return null;
  const row = findRow(section, patterns);
  if (!row) return null;
  const cols = section.columns;
  let idx = cols.length - 1;
  if (cols[idx] === "TTM") idx -= 1;
  if (idx < 0) return null;
  return num(row.values[idx]);
}

function parseFundamentalsCard(raw: FundamentalsCard) {
  const ratios = raw.ratios ?? [];
  const find = (needles: string[]): string | null => {
    for (const r of ratios) {
      const nm = (r.name ?? "").toLowerCase();
      for (const n of needles) {
        if (nm.includes(n.toLowerCase())) return r.value ?? null;
      }
    }
    return null;
  };
  const stripped = (s: string | null): number | null => {
    if (s === null) return null;
    return num(s);
  };
  const mcapCrore = stripped(find(["market cap"]));
  const px = stripped(find(["current price"]));
  const bv = stripped(find(["book value"]));
  return {
    pe: stripped(find(["stock p/e", "p/e"])),
    pb: px !== null && bv !== null && bv > 0 ? px / bv : stripped(find(["price to book"])),
    roe: stripped(find(["roe", "return on equity"])),
    roce: stripped(find(["roce", "return on capital"])),
    div_yield: stripped(find(["dividend yield"])),
    market_cap_paise: mcapCrore !== null ? Math.round(mcapCrore * 1e9) : null,
  };
}

function parseFinancials(raw: Record<string, FinSection>, isFinancial: boolean) {
  const sections: Record<string, FinSection> = {};
  for (const k of Object.keys(raw)) {
    const s = raw[k];
    if (s?.section) sections[s.section] = s;
  }
  const bal = sections["Balance Sheet"];
  const pl = sections["Profit & Loss"];
  const shp = sections["Shareholding Pattern"];

  let debt_equity: number | null = null;
  if (!isFinancial) {
    const borrowings = latestOf(bal, ["Borrowings +", "Borrowings", "Borrowing"]);
    const equity = latestOf(bal, ["Equity Capital"]);
    const reserves = latestOf(bal, ["Reserves"]);
    if (borrowings !== null && equity !== null && reserves !== null && equity + reserves > 0) {
      debt_equity = borrowings / (equity + reserves);
    }
  }
  const sales_growth_3y = isFinancial ? null : (threeYearCagr(pl, ["Sales +", "Sales"]) ?? threeYearCagr(pl, ["Revenue +", "Revenue"]));
  const profit_growth_3y = threeYearCagr(pl, ["Net Profit +", "Net Profit"]);
  const promoter_holding = latestOf(shp, ["Promoters +", "Promoter"]);

  return { debt_equity, sales_growth_3y, profit_growth_3y, promoter_holding };
}

// -------------- OHLC top-up from bhavcopy --------------

const BHAV_URL = (ddmmyyyy: string) =>
  `https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${ddmmyyyy}.csv`;

function fmtDdMmYyyy(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}${mm}${d.getUTCFullYear()}`;
}
function parseBhavDate(s: string): string | null {
  const m = s.match(/^(\d{2})-(\w{3})-(\d{4})$/);
  if (!m) return null;
  const months: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
  return months[m[2]] ? `${m[3]}-${months[m[2]]}-${m[1]}` : null;
}

/**
 * Bhavcopy top-up with two modes:
 *   - Deep mode (default when we have < 200 existing bars for this token): fetch
 *     ~400 calendar days back. Enables 200-DMA + 12-1 momentum on first-time
 *     stocks. Slow the first time (~30-60s for 275 trading days) but subsequent
 *     runs skip everything already in the DB.
 *   - Shallow mode (>= 200 existing bars): fetch just the last 30 days to top up.
 *
 * Bhavcopy CSVs are cached on disk at /tmp/bhav-YYYY-MM-DD.csv so a second stock
 * checked on the same day reuses the same CSV files — no re-download.
 */
async function ohlcTopUp(
  db: Database.Database,
  symbol: string,
  instrumentToken: number,
  daysOverride?: number,
): Promise<{ inserted: number; skipped: number; mode: "deep" | "shallow"; existing_before: number }> {
  const existing = new Set(
    (db.prepare(`SELECT trade_date FROM ohlc_daily WHERE instrument_token=?`)
      .all(instrumentToken) as { trade_date: string }[])
      .map((r) => r.trade_date),
  );
  const existingBefore = existing.size;
  // First-time-or-thin: go deep. Threshold 200 = enough for 200-DMA.
  const deep = daysOverride === undefined ? existingBefore < 200 : false;
  const days = daysOverride ?? (deep ? 500 : 30);

  const upsert = db.prepare(
    `INSERT INTO ohlc_daily(instrument_token, trade_date, open, high, low, close, volume, fetched_at)
     VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(instrument_token, trade_date) DO UPDATE SET
       open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close,
       volume=excluded.volume, fetched_at=excluded.fetched_at`,
  );
  const now = Date.now();
  const dayMs = 24 * 3600 * 1000;
  const fetchedAt = new Date().toISOString();
  let inserted = 0, skipped = 0;

  // Symbols like "M&M" and "BAJAJ-AUTO" need URL-safe handling in bhavcopy?
  // No — bhavcopy is filtered by SYMBOL column, exact string match on parts[0].
  const cacheDir = "/tmp";
  const { readFileSync: rs, writeFileSync: ws, existsSync } = require("node:fs") as typeof import("node:fs");

  for (let i = 0; i <= days; i++) {
    const d = new Date(now - i * dayMs);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const dstr = d.toISOString().slice(0, 10);
    if (existing.has(dstr)) { skipped++; continue; }

    // Disk cache for the bhavcopy file — reuse across stocks + across script runs.
    const cachePath = `${cacheDir}/bhav-${dstr}.csv`;
    let csv: string;
    if (existsSync(cachePath)) {
      csv = rs(cachePath, "utf8");
    } else {
      const res = await fetch(BHAV_URL(fmtDdMmYyyy(d)), { headers: { "User-Agent": "Mozilla/5.0" } });
      if (res.status === 404) continue;
      if (!res.ok) continue;
      csv = await res.text();
      try { ws(cachePath, csv); } catch { /* ok if /tmp is full */ }
      // Polite pause only when we hit the network
      await new Promise((r) => setTimeout(r, 150));
    }

    for (const line of csv.trim().split("\n").slice(1)) {
      const parts = line.split(",").map((s) => s.trim());
      if (parts.length < 15) continue;
      if (parts[0] !== symbol || parts[1] !== "EQ") continue;
      const td = parseBhavDate(parts[2]);
      if (!td || existing.has(td)) continue;
      const o = Number(parts[4]), h = Number(parts[5]), l = Number(parts[6]), c = Number(parts[8]), v = Number(parts[10]);
      if (![o, h, l, c].every(Number.isFinite)) continue;
      upsert.run(
        instrumentToken, td,
        Math.round(o * 100), Math.round(h * 100), Math.round(l * 100), Math.round(c * 100),
        v, fetchedAt,
      );
      existing.add(td);
      inserted++;
    }
  }
  return { inserted, skipped, mode: deep ? "deep" : "shallow", existing_before: existingBefore };
}

// -------------- Seed arbitrary-symbol into index_universe --------------

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; cur += ch; }
    else if (ch === "," && !inQ) { out.push(cur); cur = ""; }
    else { cur += ch; }
  }
  out.push(cur);
  return out;
}

async function seedFromKite(
  db: Database.Database,
  symbol: string,
): Promise<{ inserted: boolean; row?: SeedRow }> {
  // Look up in the local Kite instruments CSV if cached
  const kitePath = "/tmp/kite-instruments.csv";
  let csv: string;
  try {
    csv = readFileSync(kitePath, "utf8");
  } catch {
    const res = await fetch("https://api.kite.trade/instruments");
    csv = await res.text();
    require("node:fs").writeFileSync(kitePath, csv);
  }

  const lines = csv.split("\n");
  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const iToken = header.indexOf("instrument_token");
  const iTsym = header.indexOf("tradingsymbol");
  const iName = header.indexOf("name");
  const iType = header.indexOf("instrument_type");
  const iSeg = header.indexOf("segment");
  const iExch = header.indexOf("exchange");

  for (let i = 1; i < lines.length; i++) {
    const f = splitCsvLine(lines[i]);
    if (f.length < iExch + 1) continue;
    if (f[iExch] !== "NSE" || f[iType] !== "EQ" || f[iSeg] !== "NSE") continue;
    const tsym = f[iTsym].replace(/^"|"$/g, "").trim();
    if (tsym !== symbol) continue;
    // Insert into index_universe under a synthetic index_name so evaluate() finds it.
    // ISIN is required for the fundamentals table PK — use a synthetic SYM-<symbol>
    // key when the real ISIN isn't known. It survives across refreshes.
    const synthIsin = `SYM-${symbol}`;
    db.prepare(
      `INSERT INTO index_universe(index_name, symbol, exchange, isin, tradingsymbol, instrument_token, company, sector, as_of_date)
       VALUES('AD-HOC', ?, 'NSE', ?, ?, ?, ?, '', date('now'))
       ON CONFLICT(index_name, symbol, exchange) DO UPDATE SET
         tradingsymbol=excluded.tradingsymbol, instrument_token=excluded.instrument_token, company=excluded.company`,
    ).run(symbol, synthIsin, tsym, Number(f[iToken]), f[iName].replace(/^"|"$/g, "").trim());
    return {
      inserted: true,
      row: {
        symbol,
        exchange: "NSE",
        isin: synthIsin,
        tradingsymbol: tsym,
        instrument_token: Number(f[iToken]),
        company: f[iName].replace(/^"|"$/g, "").trim(),
        sector: "",
      },
    };
  }
  return { inserted: false };
}

// -------------- Main --------------

async function main(): Promise<void> {
  const symbol = process.env.SYMBOL;
  if (!symbol) throw new Error("SYMBOL env is required");
  const dbPath = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";
  const force = process.env.FORCE === "1";
  const skipOhlc = process.env.SKIP_OHLC === "1";
  const skipFund = process.env.SKIP_FUNDAMENTALS === "1";

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync("db/schema.sql", "utf8"));

  // Resolve symbol to universe row (or seed it).
  let row = db
    .prepare(
      `SELECT symbol, exchange, isin, tradingsymbol, instrument_token, sector
       FROM index_universe WHERE symbol=? LIMIT 1`,
    )
    .get(symbol) as
    | { symbol: string; exchange: string; isin: string; tradingsymbol: string; instrument_token: number; sector: string | null }
    | undefined;

  let seededNow = false;
  if (!row) {
    const s = await seedFromKite(db, symbol);
    if (!s.inserted || !s.row) {
      db.close();
      process.stdout.write(JSON.stringify({ status: "error", message: `symbol ${symbol} not found in Kite instruments` }) + "\n");
      process.exit(1);
      return;
    }
    seededNow = true;
    row = { ...s.row };
  }

  // 24h cache check — skip fundamentals fetch if fresh unless FORCE
  let cacheHit = false;
  if (!force && !skipFund && row.isin) {
    const r = db
      .prepare(`SELECT fetched_at FROM fundamentals WHERE isin=? ORDER BY fetched_at DESC LIMIT 1`)
      .get(row.isin) as { fetched_at: string } | undefined;
    if (r?.fetched_at) {
      const ageHours = (Date.now() - new Date(r.fetched_at).getTime()) / 3600_000;
      if (ageHours < CACHE_HOURS) {
        cacheHit = true;
      }
    }
  }

  // OHLC top-up
  let ohlcResult = { inserted: 0, skipped: 0 };
  if (!skipOhlc) {
    ohlcResult = await ohlcTopUp(db, symbol, row.instrument_token);
  }

  // Screener fetch (both endpoints)
  const isFinancial = row.sector != null && FINANCIALS_SECTORS.has(row.sector);
  const asOf = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const fetchedAt = new Date().toISOString();
  let fundamentalsResult:
    | { pe: number | null; pb: number | null; roe: number | null; roce: number | null; div_yield: number | null; market_cap_paise: number | null; debt_equity: number | null; sales_growth_3y: number | null; profit_growth_3y: number | null; promoter_holding: number | null }
    | null = null;

  let peersInserted = 0;
  if (!skipFund && !cacheHit && row.isin) {
    const client = await startScreenerMcp();
    try {
      const cardRaw = (await mcpCall(client, "get_fundamentals", { symbol })) as FundamentalsCard;
      const card = parseFundamentalsCard(cardRaw);
      const finRaw = (await mcpCall(client, "get_financials", { symbol })) as Record<string, FinSection>;
      const fin = parseFinancials(finRaw, isFinancial);
      fundamentalsResult = { ...card, ...fin };

      db.prepare(
        `INSERT INTO fundamentals(isin, as_of_date, pe, pb, roe, roce, debt_equity, sales_growth_3y,
                                  profit_growth_3y, div_yield, market_cap, promoter_holding,
                                  fetched_at, source, source_url, fetch_status)
         VALUES(@isin, @as_of_date, @pe, @pb, @roe, @roce, @debt_equity, @sales_growth_3y,
                @profit_growth_3y, @div_yield, @market_cap, @promoter_holding,
                @fetched_at, 'refresh-single-stock', NULL, 'ok')
         ON CONFLICT(isin, as_of_date) DO UPDATE SET
           pe=COALESCE(excluded.pe, fundamentals.pe),
           pb=COALESCE(excluded.pb, fundamentals.pb),
           roe=COALESCE(excluded.roe, fundamentals.roe),
           roce=COALESCE(excluded.roce, fundamentals.roce),
           debt_equity=COALESCE(excluded.debt_equity, fundamentals.debt_equity),
           sales_growth_3y=COALESCE(excluded.sales_growth_3y, fundamentals.sales_growth_3y),
           profit_growth_3y=COALESCE(excluded.profit_growth_3y, fundamentals.profit_growth_3y),
           div_yield=COALESCE(excluded.div_yield, fundamentals.div_yield),
           market_cap=COALESCE(excluded.market_cap, fundamentals.market_cap),
           promoter_holding=COALESCE(excluded.promoter_holding, fundamentals.promoter_holding),
           fetched_at=excluded.fetched_at,
           fetch_status='ok'`,
      ).run({
        isin: row.isin,
        as_of_date: asOf,
        pe: fundamentalsResult.pe,
        pb: fundamentalsResult.pb,
        roe: fundamentalsResult.roe,
        roce: fundamentalsResult.roce,
        debt_equity: fundamentalsResult.debt_equity,
        sales_growth_3y: fundamentalsResult.sales_growth_3y,
        profit_growth_3y: fundamentalsResult.profit_growth_3y,
        div_yield: fundamentalsResult.div_yield,
        market_cap: fundamentalsResult.market_cap_paise,
        promoter_holding: fundamentalsResult.promoter_holding,
        fetched_at: fetchedAt,
      });

      // Peers (best-effort — a failure here doesn't block the main fetch).
      try {
        const peersRaw = (await mcpCall(client, "get_peers", { symbol })) as {
          symbol?: string;
          peers?: { name: string; values: Record<string, string> }[];
        };
        const upsertPeer = db.prepare(
          `INSERT INTO peers(isin, as_of_date, peer_symbol, peer_company, pe, roe, roce, sales_growth)
           VALUES(@isin, @as_of_date, @peer_symbol, @peer_company, @pe, @roe, @roce, @sales_growth)
           ON CONFLICT(isin, as_of_date, peer_symbol) DO UPDATE SET
             peer_company=excluded.peer_company, pe=excluded.pe,
             roe=excluded.roe, roce=excluded.roce, sales_growth=excluded.sales_growth`,
        );
        // Screener peer names look like "PAGEIND (Page Industries)" — split into
        // symbol + company for storage.
        const parseName = (raw: string): { sym: string; comp: string | null } => {
          const m = raw.match(/^([^\s(]+)\s*(?:\(([^)]*)\))?/);
          if (!m) return { sym: raw, comp: null };
          return { sym: m[1].trim(), comp: (m[2] ?? "").trim() || null };
        };
        const numFrom = (s: string | undefined): number | null => {
          if (!s) return null;
          const cleaned = s.replace(/[₹%×,\s]|Cr\.?/g, "").trim();
          if (!cleaned || cleaned === "-") return null;
          const v = Number(cleaned);
          return Number.isFinite(v) ? v : null;
        };

        const peerTx = db.transaction(() => {
          for (const p of peersRaw.peers ?? []) {
            const { sym, comp } = parseName(p.name);
            upsertPeer.run({
              isin: row!.isin,
              as_of_date: asOf,
              peer_symbol: sym,
              peer_company: comp,
              pe: numFrom(p.values?.["P/E"]),
              roe: numFrom(p.values?.["ROE %"]),
              // Screener peer view exposes ROCE % but not always ROE %; older builds only show ROCE.
              roce: numFrom(p.values?.["ROCE %"]),
              sales_growth: numFrom(p.values?.["Qtr Sales Var %"]),
            });
            peersInserted++;
          }
        });
        peerTx();
      } catch {
        // Peer fetch failure is non-fatal.
      }
    } finally {
      client.proc.kill();
    }
  }

  db.close();

  process.stdout.write(
    JSON.stringify({
      status: "ok",
      symbol,
      seeded_from_kite: seededNow,
      cache_hit: cacheHit,
      ohlc: ohlcResult,
      fundamentals: fundamentalsResult ? "refetched" : cacheHit ? "cached" : "skipped",
      peers_inserted: peersInserted,
    }) + "\n",
  );
}

main().catch((err) => {
  process.stdout.write(
    JSON.stringify({ status: "error", message: err instanceof Error ? err.message : String(err) }) + "\n",
  );
  process.exit(1);
});
