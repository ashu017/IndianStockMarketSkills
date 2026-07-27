import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * Deterministic Screener financials extractor. For every stock in
 * nifty100_universe (or a filtered set via SYMBOLS env), spawns screener-mcp
 * over stdio, calls `get_financials`, and parses:
 *
 *   - Debt / Equity              → Balance Sheet: Borrowings / (Equity + Reserves)
 *                                  (banks/NBFCs left NULL — deposits ≠ debt)
 *   - Sales growth 3y (CAGR %)   → P&L: (Sales_latest / Sales_3y_ago)^(1/3) - 1
 *                                  (banks/NBFCs left NULL — Sales is Interest Income, meaningless)
 *   - Profit growth 3y (CAGR %)  → P&L: (Net Profit_latest / Net Profit_3y_ago)^(1/3) - 1
 *   - Promoter holding %         → Shareholding: "Promoters +" latest column
 *                                  (banks with no promoter leave NULL)
 *
 * Bonus (written to fundamentals_extra):
 *   - opm_pct_ttm, fcf_cr_ttm, cfo_op_pct_ttm, debtor_days, working_capital_days,
 *     cash_conversion_cycle, promoter_change_4q
 *
 * Notes:
 * - No LLM. Fully deterministic parser.
 * - Concurrency capped at 6 to keep the local MCP responsive.
 * - Idempotent — same-day re-runs overwrite existing values.
 */

const SCREENER_MCP_PATH = "/home/ashunsah/workplace/screener-mcp/dist/index.js";
// Sequential mode with a hard delay between requests. Screener throttles fast
// concurrent access; polite one-at-a-time gets far more through in practice.
// Override via env: SCREENER_DELAY_MS (default 3000) and CONCURRENCY (default 1).
const CONCURRENCY = Number(process.env.CONCURRENCY ?? "1");
const INTER_REQUEST_DELAY_MS = Number(process.env.SCREENER_DELAY_MS ?? "3000");
const REQUEST_TIMEOUT_MS = 15000;
const RETRY_BACKOFF_MS = [10000, 30000, 60000]; // longer backoff on "fetch failed"

const FINANCIALS_SECTORS = new Set(["Financial Services", "Banks", "Financials"]);

interface UniverseRow {
  isin: string;
  symbol: string;
  exchange: string;
  sector: string | null;
}

interface FinSection {
  section: string;
  columns: string[];
  rows: { label?: string; name?: string; values: (string | number)[] }[];
}

interface ParsedFinancials {
  symbol: string;
  debt_equity: number | null;
  sales_growth_3y: number | null;
  profit_growth_3y: number | null;
  promoter_holding: number | null;
  // Optional headline ratios from get_fundamentals — populated when we call that
  // tool too. All nullable; the writer COALESCEs so partial writes don't clobber.
  pe: number | null;
  pb: number | null;
  roe: number | null;
  roce: number | null;
  div_yield: number | null;
  market_cap_paise: number | null;
  extra: { key: string; value: number | null; unit: string | null }[];
  errors: string[];
}

interface FundamentalsRatio {
  name: string;
  value: string;
}
interface FundamentalsResponse {
  symbol?: string;
  ratios?: FundamentalsRatio[];
}

/**
 * Parse Screener's `get_fundamentals` "ratios" list into numeric fields.
 * Match by name substring, case-insensitive. Values are display strings like
 * "₹ 8,14,124 Cr." or "15.2" or "51.8 %" — strip glyphs before parsing.
 */
function parseFundamentalsCard(raw: FundamentalsResponse): {
  pe: number | null; pb: number | null; roe: number | null; roce: number | null;
  div_yield: number | null; market_cap_paise: number | null;
} {
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
    const cleaned = s.replace(/[₹%×,\s]|Cr\.?/g, "").trim();
    if (!cleaned || cleaned === "-" || cleaned === "NA") return null;
    const v = Number(cleaned);
    return Number.isFinite(v) ? v : null;
  };
  const mcapDisplay = find(["market cap"]);
  // Market Cap displays like "₹ 8,14,124 Cr." — parse the number then × 1e9 to get paise.
  const mcapCrore = stripped(mcapDisplay);
  const mcap_paise = mcapCrore !== null ? Math.round(mcapCrore * 1e9) : null;

  return {
    pe: stripped(find(["stock p/e", "p/e"])),
    pb: (() => {
      // Screener's "P/B" isn't always present. Sometimes derive from Current Price / Book Value.
      const px = stripped(find(["current price"]));
      const bv = stripped(find(["book value"]));
      if (px !== null && bv !== null && bv > 0) return px / bv;
      return stripped(find(["price to book", "price/book"]));
    })(),
    roe: stripped(find(["roe", "return on equity"])),
    roce: stripped(find(["roce", "return on capital"])),
    div_yield: stripped(find(["dividend yield"])),
    market_cap_paise: mcap_paise,
  };
}

function istDate(now = Date.now()): string {
  return new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);
}

/** Strip Screener's display glyphs (₹, %, ×, commas, Cr) and parse. */
function num(s: unknown): number | null {
  if (s === null || s === undefined) return null;
  const str = String(s).replace(/[₹%×,\s]|Cr\.?/g, "").trim();
  if (!str || str === "-" || str === "NA") return null;
  const v = Number(str);
  return Number.isFinite(v) ? v : null;
}

function findRow(section: FinSection | undefined, labelPatterns: (string | RegExp)[]): { values: (string | number)[] } | null {
  if (!section) return null;
  for (const r of section.rows) {
    const label = (r.label ?? r.name ?? "").trim();
    for (const p of labelPatterns) {
      if (typeof p === "string" ? label.includes(p) : p.test(label)) return r;
    }
  }
  return null;
}

/** CAGR from series values, given a start value and end value plus number of years. Returns percent. */
function cagrPct(startVal: number | null, endVal: number | null, years: number): number | null {
  if (startVal === null || endVal === null || startVal <= 0 || endVal <= 0 || years <= 0) return null;
  return (Math.pow(endVal / startVal, 1 / years) - 1) * 100;
}

/**
 * Compute 3-year CAGR from a series where index N-1 is latest and index N-4 is
 * 3 years ago. Uses "Mar YYYY" column labels; TTM (if present as last column)
 * is skipped since it isn't a full year of comparable data.
 */
function threeYearCagr(section: FinSection | undefined, labelPatterns: (string | RegExp)[]): number | null {
  if (!section) return null;
  const row = findRow(section, labelPatterns);
  if (!row) return null;
  // Drop TTM column if present at the end.
  const cols = section.columns;
  let endIdx = cols.length - 1;
  if (cols[endIdx] === "TTM") endIdx -= 1;
  const startIdx = endIdx - 3;
  if (startIdx < 0 || endIdx <= startIdx) return null;
  const startV = num(row.values[startIdx]);
  const endV = num(row.values[endIdx]);
  return cagrPct(startV, endV, 3);
}

function latestValueOfRow(section: FinSection | undefined, labelPatterns: (string | RegExp)[]): number | null {
  if (!section) return null;
  const row = findRow(section, labelPatterns);
  if (!row) return null;
  const cols = section.columns;
  let idx = cols.length - 1;
  if (cols[idx] === "TTM") idx -= 1;
  if (idx < 0) return null;
  return num(row.values[idx]);
}

function ttmValueOfRow(section: FinSection | undefined, labelPatterns: (string | RegExp)[]): number | null {
  if (!section) return null;
  const row = findRow(section, labelPatterns);
  if (!row) return null;
  const cols = section.columns;
  const ttmIdx = cols.indexOf("TTM");
  if (ttmIdx === -1) {
    // Fall back to latest annual column
    return latestValueOfRow(section, labelPatterns);
  }
  return num(row.values[ttmIdx]);
}

function parseFinancials(raw: Record<string, FinSection>, symbol: string, isFinancial: boolean): ParsedFinancials {
  const errors: string[] = [];
  const sections: Record<string, FinSection> = {};
  for (const k of Object.keys(raw)) {
    const s = raw[k];
    if (s?.section) sections[s.section] = s;
  }

  const bal = sections["Balance Sheet"];
  const pl = sections["Profit & Loss"];
  const cf = sections["Cash Flow"];
  const shp = sections["Shareholding Pattern"];
  const ratios = sections["Ratios"];

  // Debt/Equity — only meaningful for non-financials
  let debt_equity: number | null = null;
  if (!isFinancial) {
    const borrowings = latestValueOfRow(bal, ["Borrowings +", "Borrowings", "Borrowing"]);
    const equity = latestValueOfRow(bal, ["Equity Capital"]);
    const reserves = latestValueOfRow(bal, ["Reserves"]);
    if (borrowings !== null && equity !== null && reserves !== null) {
      const denom = equity + reserves;
      if (denom > 0) debt_equity = borrowings / denom;
    } else {
      errors.push("de_missing_inputs");
    }
  }

  // Sales growth — Sales column exists only for non-financials
  let sales_growth_3y: number | null = null;
  if (!isFinancial) {
    sales_growth_3y = threeYearCagr(pl, ["Sales +", "Sales"]);
    if (sales_growth_3y === null) {
      // Some companies expose "Revenue +" only
      sales_growth_3y = threeYearCagr(pl, ["Revenue +", "Revenue"]);
    }
  }

  // Profit growth 3y CAGR — universal
  const profit_growth_3y = threeYearCagr(pl, ["Net Profit +", "Net Profit"]);

  // Promoter holding
  const promoter_holding = latestValueOfRow(shp, ["Promoters +", "Promoter"]);

  // Bonus fields
  const extra: ParsedFinancials["extra"] = [];
  const opm = ttmValueOfRow(pl, ["OPM %"]);
  if (opm !== null) extra.push({ key: "opm_pct_ttm", value: opm, unit: "pct" });
  const fcf = ttmValueOfRow(cf, ["Free Cash Flow"]) ?? latestValueOfRow(cf, ["Free Cash Flow"]);
  if (fcf !== null) extra.push({ key: "fcf_cr_ttm", value: fcf, unit: "crore_rupees" });
  const cfoop = latestValueOfRow(cf, ["CFO/OP"]);
  if (cfoop !== null) extra.push({ key: "cfo_op_pct", value: cfoop, unit: "pct" });
  const debtor = latestValueOfRow(ratios, ["Debtor Days"]);
  if (debtor !== null) extra.push({ key: "debtor_days", value: debtor, unit: "days" });
  const wcd = latestValueOfRow(ratios, ["Working Capital Days"]);
  if (wcd !== null) extra.push({ key: "working_capital_days", value: wcd, unit: "days" });
  const ccc = latestValueOfRow(ratios, ["Cash Conversion Cycle"]);
  if (ccc !== null) extra.push({ key: "cash_conversion_cycle", value: ccc, unit: "days" });

  // Promoter-holding change over trailing 4 quarters (spot promoter selling)
  if (shp) {
    const promRow = findRow(shp, ["Promoters +", "Promoter"]);
    if (promRow && shp.columns.length >= 5) {
      const latest = num(promRow.values[shp.columns.length - 1]);
      const fourAgo = num(promRow.values[shp.columns.length - 5]);
      if (latest !== null && fourAgo !== null) {
        extra.push({ key: "promoter_change_4q", value: latest - fourAgo, unit: "pct_points" });
      }
    }
  }

  return {
    symbol,
    debt_equity, sales_growth_3y, profit_growth_3y, promoter_holding,
    pe: null, pb: null, roe: null, roce: null, div_yield: null, market_cap_paise: null,
    extra, errors,
  };
}

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
        } catch {
          /* not a JSON line; ignore */
        }
      }
    });
    proc.stderr.on("data", () => {
      /* discard stderr; too chatty on start */
    });
    proc.on("error", reject);

    // Initialize
    const initId = client.nextId++;
    client.pendingByLine.set(initId, () => resolve(client));
    proc.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: initId,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "financials-parse", version: "1" } },
      }) + "\n",
    );
  });
}

function mcpCallOnce(client: McpClient, tool: string, args: Record<string, unknown>): Promise<unknown> {
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
      if (!text) return reject(new Error("no text content in MCP response"));
      // Screener MCP surfaces upstream fetch errors as isError:true with plain-text body
      // like "fetch failed" or "Screener: <status>". Detect + surface as retriable.
      if (m.result?.isError === true) {
        return reject(new Error(`upstream:${text.slice(0, 80)}`));
      }
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        // Non-JSON body but not flagged isError — treat as upstream noise.
        reject(new Error(`upstream:non-json:${text.slice(0, 60)}`));
      }
    });
    client.proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args } }) + "\n",
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function mcpCall(
  client: McpClient,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < RETRY_BACKOFF_MS.length + 1; attempt++) {
    try {
      return await mcpCallOnce(client, tool, args);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      // Only retry on upstream/network-ish failures, not on genuine tool errors.
      if (!msg.startsWith("upstream:") && !msg.startsWith("timeout")) throw err;
      if (attempt >= RETRY_BACKOFF_MS.length) break;
      await sleep(RETRY_BACKOFF_MS[attempt]);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function main(): Promise<void> {
  const dbPath = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";
  const symbolsFilter = process.env.SYMBOLS
    ? new Set(process.env.SYMBOLS.split(",").map((s) => s.trim()))
    : null;
  const skipIfComplete = process.env.SKIP_COMPLETE !== "0";

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync("db/schema.sql", "utf8"));

  // Load universe from index_universe. DISTINCT across index memberships so a
  // stock in both NIFTY 100 and NIFTY 200 doesn't get fetched twice.
  const indexNameFilter = process.env.INDEX_NAME ?? null;
  const universeQuery = indexNameFilter
    ? `SELECT DISTINCT isin, symbol, exchange, sector FROM index_universe WHERE index_name = ? ORDER BY symbol`
    : `SELECT DISTINCT isin, symbol, exchange, sector FROM index_universe ORDER BY symbol`;
  const universe = (indexNameFilter
    ? db.prepare(universeQuery).all(indexNameFilter)
    : db.prepare(universeQuery).all()) as UniverseRow[];
  let work = symbolsFilter ? universe.filter((u) => symbolsFilter.has(u.symbol)) : universe;

  // Idempotent resume: skip stocks that already have ALL 4 fields populated
  // across any prior fetch date (respecting financials-sector exemptions).
  // This lets you re-run the script cheaply and only pick up the stragglers.
  if (skipIfComplete) {
    const coalesce = db.prepare(
      `SELECT
         (SELECT roe              FROM fundamentals WHERE isin=? AND roe              IS NOT NULL ORDER BY as_of_date DESC LIMIT 1) as roe,
         (SELECT roce             FROM fundamentals WHERE isin=? AND roce             IS NOT NULL ORDER BY as_of_date DESC LIMIT 1) as roce,
         (SELECT debt_equity      FROM fundamentals WHERE isin=? AND debt_equity      IS NOT NULL ORDER BY as_of_date DESC LIMIT 1) as de,
         (SELECT sales_growth_3y  FROM fundamentals WHERE isin=? AND sales_growth_3y  IS NOT NULL ORDER BY as_of_date DESC LIMIT 1) as s3,
         (SELECT profit_growth_3y FROM fundamentals WHERE isin=? AND profit_growth_3y IS NOT NULL ORDER BY as_of_date DESC LIMIT 1) as p3,
         (SELECT promoter_holding FROM fundamentals WHERE isin=? AND promoter_holding IS NOT NULL ORDER BY as_of_date DESC LIMIT 1) as prom`,
    );
    const before = work.length;
    work = work.filter((u) => {
      const isFin = u.sector != null && FINANCIALS_SECTORS.has(u.sector);
      const r = coalesce.get(u.isin, u.isin, u.isin, u.isin, u.isin, u.isin) as {
        roe: number | null; roce: number | null; de: number | null;
        s3: number | null; p3: number | null; prom: number | null;
      };
      const roeOK = r.roe !== null;
      const roceOK = r.roce !== null;
      const deOK = isFin || r.de !== null;
      const salesOK = isFin || r.s3 !== null;
      const profitOK = r.p3 !== null;
      const promOK = r.prom !== null;
      // "Complete" = every required-for-sector field has a value somewhere.
      return !(roeOK && roceOK && deOK && salesOK && profitOK && promOK);
    });
    process.stderr.write(
      `[fetch-financials] SKIP_COMPLETE=1 → ${before} → ${work.length} stocks need refresh\n`,
    );
  }

  process.stderr.write(
    `[fetch-financials] mode=${CONCURRENCY === 1 ? "sequential" : `concurrency=${CONCURRENCY}`}, delay=${INTER_REQUEST_DELAY_MS}ms\n`,
  );

  const client = await startScreenerMcp();
  const asOfDate = istDate();
  const fetchedAt = new Date().toISOString();

  const results: (ParsedFinancials & { isin: string; isFinancial: boolean })[] = [];

  // Prepared statements for incremental (per-stock) persistence so a mid-run
  // failure never loses the successful fetches.
  const insertOrUpdate = db.prepare(
    `INSERT INTO fundamentals(isin, as_of_date, pe, pb, roe, roce, debt_equity, sales_growth_3y,
                              profit_growth_3y, div_yield, market_cap, promoter_holding,
                              fetched_at, source, source_url, fetch_status)
     VALUES(@isin, @as_of_date, @pe, @pb, @roe, @roce, @debt_equity, @sales_growth_3y,
            @profit_growth_3y, @div_yield, @market_cap, @promoter_holding,
            @fetched_at, 'screener-financials', NULL, @fetch_status)
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
       fetch_status=CASE WHEN fundamentals.fetch_status='ok' THEN 'ok' ELSE excluded.fetch_status END`,
  );
  const extraStmt = db.prepare(
    `INSERT INTO fundamentals_extra(isin, as_of_date, metric_key, value_num, unit)
     VALUES(@isin, @as_of_date, @metric_key, @value_num, @unit)
     ON CONFLICT(isin, as_of_date, metric_key) DO UPDATE SET
       value_num=excluded.value_num, unit=excluded.unit`,
  );

  function persistOne(r: ParsedFinancials & { isin: string; isFinancial: boolean }): void {
    const hasAnyMainField =
      r.debt_equity !== null ||
      r.sales_growth_3y !== null ||
      r.profit_growth_3y !== null ||
      r.promoter_holding !== null ||
      r.pe !== null || r.roe !== null || r.roce !== null;
    const status = hasAnyMainField ? "ok" : "failed";
    const oneTx = db.transaction(() => {
      insertOrUpdate.run({
        isin: r.isin,
        as_of_date: asOfDate,
        pe: r.pe,
        pb: r.pb,
        roe: r.roe,
        roce: r.roce,
        debt_equity: r.debt_equity,
        sales_growth_3y: r.sales_growth_3y,
        profit_growth_3y: r.profit_growth_3y,
        div_yield: r.div_yield,
        market_cap: r.market_cap_paise,
        promoter_holding: r.promoter_holding,
        fetched_at: fetchedAt,
        fetch_status: status,
      });
      for (const e of r.extra) {
        extraStmt.run({
          isin: r.isin,
          as_of_date: asOfDate,
          metric_key: e.key,
          value_num: e.value,
          unit: e.unit,
        });
      }
    });
    oneTx();
  }

  // Sequential-ish worker: for concurrency>1 we still queue via cursor,
  // but the INTER_REQUEST_DELAY_MS pause between requests is enforced globally.
  let cursor = 0;
  let done = 0;
  let okCount = 0;
  let failCount = 0;
  let lastRequestAt = 0;

  async function paceGate(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, lastRequestAt + INTER_REQUEST_DELAY_MS - now);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  }

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= work.length) return;
      const u = work[idx];
      const isFinancial = u.sector != null && FINANCIALS_SECTORS.has(u.sector);
      await paceGate();
      let parsed: ParsedFinancials | null = null;
      let outerErr: string | null = null;
      try {
        const raw = (await mcpCall(client, "get_financials", { symbol: u.symbol })) as Record<string, FinSection>;
        parsed = parseFinancials(raw, u.symbol, isFinancial);
      } catch (err) {
        outerErr = `financials:${err instanceof Error ? err.message : String(err)}`;
      }
      // Second call: headline ratios card. Cheap; ~500 bytes. Only fetch if
      // financials came back OK (throttling would just cascade otherwise).
      if (parsed) {
        await paceGate();
        try {
          const rawF = (await mcpCall(client, "get_fundamentals", { symbol: u.symbol })) as FundamentalsResponse;
          const card = parseFundamentalsCard(rawF);
          parsed.pe = card.pe;
          parsed.pb = card.pb;
          parsed.roe = card.roe;
          parsed.roce = card.roce;
          parsed.div_yield = card.div_yield;
          parsed.market_cap_paise = card.market_cap_paise;
        } catch (err) {
          parsed.errors.push(`fundamentals:${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (parsed) {
        const row = { ...parsed, isin: u.isin, isFinancial };
        results.push(row);
        persistOne(row);
        okCount++;
      } else {
        const row = {
          symbol: u.symbol,
          isin: u.isin,
          isFinancial,
          debt_equity: null,
          sales_growth_3y: null,
          profit_growth_3y: null,
          promoter_holding: null,
          pe: null, pb: null, roe: null, roce: null, div_yield: null, market_cap_paise: null,
          extra: [],
          errors: [outerErr ?? "unknown"],
        };
        results.push(row);
        failCount++;
      }
      done++;
      // Live progress line so tail -f on the log is useful.
      process.stderr.write(
        `[${done}/${work.length}] ${u.symbol.padEnd(12)} ok=${okCount} fail=${failCount}\n`,
      );
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  client.proc.kill();
  db.close();

  const total = results.length;
  const withDE = results.filter((r) => r.debt_equity !== null || r.isFinancial).length;
  const withSales = results.filter((r) => r.sales_growth_3y !== null || r.isFinancial).length;
  const withProfit = results.filter((r) => r.profit_growth_3y !== null).length;
  const withProm = results.filter((r) => r.promoter_holding !== null).length;
  const errored = results.filter((r) => r.errors.length > 0).map((r) => ({ symbol: r.symbol, errors: r.errors }));

  process.stdout.write(
    JSON.stringify(
      {
        status: errored.length && errored.length === total ? "error" : "ok",
        as_of_date: asOfDate,
        processed: total,
        completeness: {
          debt_equity: withDE,
          sales_growth_3y: withSales,
          profit_growth_3y: withProfit,
          promoter_holding: withProm,
        },
        errors: errored.slice(0, 8),
      },
      null,
      2,
    ) + "\n",
  );
}

main().catch((err) => {
  process.stdout.write(
    JSON.stringify({ status: "error", message: err instanceof Error ? err.message : String(err) }) + "\n",
  );
  process.exit(1);
});
