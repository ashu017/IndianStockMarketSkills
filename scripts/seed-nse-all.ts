import Database from "better-sqlite3";
import { readFileSync } from "node:fs";

/**
 * Bulk-seed the full NSE cash-equity main board (~4,800 stocks) into
 * index_universe under index_name = 'NSE-ALL'. Used to power autocomplete and
 * name/symbol search across the full market — the scanner keeps using Nifty 500
 * (or Screener's screen output) as its own universe.
 *
 * Filters applied (in-code, deterministic):
 *   - exchange = 'NSE'
 *   - instrument_type = 'EQ'
 *   - segment = 'NSE'
 *   - tradingsymbol does not end in -SM (SME), -BE (surveillance),
 *     -SG (government securities), -IL / -IT (illiquid tiers)
 *   - tradingsymbol does NOT start with a digit (weeds out debentures like 0ABCL31-N0)
 *   - tradingsymbol does NOT contain INAV (ETF NAV mirrors)
 *   - company or symbol does NOT match ETF / SGB / T-BILL / NCD / GILT patterns
 *   Result: ~2,500 real cash-equity main-board stocks.
 *
 * Idempotent: repeated runs upsert the same rows and don't disturb other
 * index_name memberships. Safe to run periodically to keep the master list
 * in sync with new listings.
 *
 * Env:
 *   PORTFOLIO_DB_PATH=./data/portfolio.db
 *   KITE_INSTRUMENTS_CSV=/tmp/kite-instruments.csv
 */

const KITE_CSV_PATH = process.env.KITE_INSTRUMENTS_CSV ?? "/tmp/kite-instruments.csv";
const DB_PATH = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";
const INDEX_NAME = "NSE-ALL";

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (const ch of line) {
    if (ch === '"') {
      inQ = !inQ;
      cur += ch;
    } else if (ch === "," && !inQ) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// Suffix-based rejects: SME (-SM), surveillance-restricted (-BE), gov securities
// (-SG), illiquid tiers (-IL, -IT), "special trading" (-ST) segments.
const EXCLUDE_SUFFIXES = /-(?:SM|BE|SG|IL|IT|ST|GB)$/;
// Debentures encode maturity in the ticker; strong signals include:
//   - starts with a digit (e.g. 0ABCL31-N0, 12BCL31-N0)
//   - contains -N0/-N1/-N2/-N3/-N4/-N5 (Kite's debenture tranches)
//   - contains -YW / -Px suffix (yield warrant / put-option variants)
//   - looks like AAFS30A-N0 (letters + 2-digit year + optional letter + tranche)
const DEBT_START = /^[0-9]/;
const DEBT_TRANCHE = /-(?:N[0-9]|YW|P[0-9])$/i;
const DEBT_MATURITY = /^[A-Z]+[0-9]{2}[A-Z]?-[A-Z][0-9]$/; // AAFS30-N0, AAFS30A-N0
const ETF_LIKE_SYM = /(?:ETF|INAV|GBSEC|NCD|TBILL|GILT|BEES|LIQUIDBEES|GOLDBEES)/i;
const ETF_LIKE_COMPANY = /\b(?:ETF|Bond|Debenture|Gilt|SGB|T-Bill|Treasury Bill|Nifty ETF|Sensex ETF|InvIT|REIT)\b/i;

function isMainBoardEquity(symbol: string, company: string): boolean {
  if (EXCLUDE_SUFFIXES.test(symbol)) return false;
  if (DEBT_START.test(symbol)) return false;
  if (DEBT_TRANCHE.test(symbol)) return false;
  if (DEBT_MATURITY.test(symbol)) return false;
  if (ETF_LIKE_SYM.test(symbol)) return false;
  if (ETF_LIKE_COMPANY.test(company)) return false;
  return true;
}

function istDate(now = Date.now()): string {
  return new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);
}

function main(): void {
  const csv = readFileSync(KITE_CSV_PATH, "utf8");
  const lines = csv.split("\n");
  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const iToken = header.indexOf("instrument_token");
  const iTsym = header.indexOf("tradingsymbol");
  const iName = header.indexOf("name");
  const iType = header.indexOf("instrument_type");
  const iSeg = header.indexOf("segment");
  const iExch = header.indexOf("exchange");

  interface Row {
    symbol: string;
    tradingsymbol: string;
    instrument_token: number;
    company: string;
  }
  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const f = splitCsvLine(lines[i]);
    if (f.length < iExch + 1) continue;
    if (f[iExch] !== "NSE" || f[iType] !== "EQ" || f[iSeg] !== "NSE") continue;
    const tsym = f[iTsym].replace(/^"|"$/g, "").trim();
    const comp = f[iName].replace(/^"|"$/g, "").trim();
    if (!tsym) continue;
    if (!isMainBoardEquity(tsym, comp)) continue;
    rows.push({
      symbol: tsym,
      tradingsymbol: tsym,
      instrument_token: Number(f[iToken]),
      company: comp,
    });
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync("db/schema.sql", "utf8"));

  const asOf = istDate();
  const stmt = db.prepare(
    `INSERT INTO index_universe(index_name, symbol, exchange, isin, tradingsymbol, instrument_token, company, sector, as_of_date)
     VALUES(@index_name, @symbol, 'NSE', @isin, @tradingsymbol, @instrument_token, @company, '', @as_of_date)
     ON CONFLICT(index_name, symbol, exchange) DO UPDATE SET
       tradingsymbol=excluded.tradingsymbol,
       instrument_token=excluded.instrument_token,
       company=excluded.company,
       as_of_date=excluded.as_of_date`,
  );

  let inserted = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      stmt.run({
        index_name: INDEX_NAME,
        symbol: r.symbol,
        isin: `SYM-${r.symbol}`,
        tradingsymbol: r.tradingsymbol,
        instrument_token: r.instrument_token,
        company: r.company,
        as_of_date: asOf,
      });
      inserted++;
    }
  });
  tx();

  const total = (db.prepare(`SELECT COUNT(*) as n FROM index_universe WHERE index_name = ?`).get(INDEX_NAME) as { n: number }).n;
  db.close();

  process.stdout.write(
    JSON.stringify({
      status: "ok",
      index_name: INDEX_NAME,
      seeded: inserted,
      total_after: total,
      as_of_date: asOf,
    }) + "\n",
  );
}

try {
  main();
} catch (err) {
  process.stdout.write(
    JSON.stringify({ status: "error", message: err instanceof Error ? err.message : String(err) }) + "\n",
  );
  process.exit(1);
}
