import { readFileSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";

/**
 * One-off seed script. Rebuild quarterly when NSE rebalances the index.
 *
 * Inputs (fetched by the caller — NOT by this script — so it stays fully
 * deterministic and reruns idempotently):
 *   NIFTY100_CSV — /tmp/nifty100.csv from
 *     https://nsearchives.nseindia.com/content/indices/ind_nifty100list.csv
 *   KITE_INSTRUMENTS_CSV — /tmp/kite-instruments.csv from
 *     https://api.kite.trade/instruments
 *
 * Output:
 *   - data/nifty100-instruments.json (canonical seed, checked into git)
 *   - Upserts each row into nifty100_universe with today's IST date as as_of_date.
 */

interface Nifty100Row {
  company: string;
  industry: string;
  symbol: string;
  isin: string;
}

interface KiteInstrument {
  instrument_token: number;
  tradingsymbol: string;
  name: string;
  instrument_type: string;
  segment: string;
  exchange: string;
}

interface SeedRow {
  symbol: string;
  exchange: "NSE";
  isin: string;
  tradingsymbol: string;
  instrument_token: number;
  company: string;
  sector: string;
}

function parseNifty100(csv: string): Nifty100Row[] {
  const lines = csv.trim().split("\n");
  const rows: Nifty100Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    // Parse CSV with quoted commas — company names sometimes contain commas.
    const fields = splitCsvLine(lines[i]);
    if (fields.length < 5) continue;
    const [company, industry, symbol, series, isin] = fields;
    if (series?.toUpperCase() !== "EQ") continue;
    rows.push({
      company: company.replace(/^"|"$/g, "").trim(),
      industry: industry.replace(/^"|"$/g, "").trim(),
      symbol: symbol.replace(/^"|"$/g, "").trim(),
      isin: isin.replace(/^"|"$/g, "").trim(),
    });
  }
  return rows;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      cur += ch;
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function loadKiteNSEEQ(csv: string): Map<string, KiteInstrument> {
  const lines = csv.split("\n");
  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const idx = (name: string) => header.indexOf(name);
  const iToken = idx("instrument_token");
  const iTsym = idx("tradingsymbol");
  const iName = idx("name");
  const iType = idx("instrument_type");
  const iSeg = idx("segment");
  const iExch = idx("exchange");
  const bySymbol = new Map<string, KiteInstrument>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const f = splitCsvLine(line);
    if (f[iExch] !== "NSE" || f[iType] !== "EQ" || f[iSeg] !== "NSE") continue;
    const tsym = f[iTsym].replace(/^"|"$/g, "").trim();
    bySymbol.set(tsym, {
      instrument_token: Number(f[iToken]),
      tradingsymbol: tsym,
      name: f[iName].replace(/^"|"$/g, "").trim(),
      instrument_type: f[iType],
      segment: f[iSeg],
      exchange: f[iExch],
    });
  }
  return bySymbol;
}

function istDate(now = Date.now()): string {
  return new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);
}

function main(): void {
  const niftyCsvPath = process.env.NIFTY100_CSV ?? "/tmp/nifty100.csv";
  const kiteCsvPath = process.env.KITE_INSTRUMENTS_CSV ?? "/tmp/kite-instruments.csv";
  const outJsonPath = process.env.OUT_JSON ?? "./data/nifty100-instruments.json";
  const dbPath = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";

  const nifty100 = parseNifty100(readFileSync(niftyCsvPath, "utf8"));
  const kiteBySymbol = loadKiteNSEEQ(readFileSync(kiteCsvPath, "utf8"));
  const asOf = istDate();

  const seed: SeedRow[] = [];
  const missing: string[] = [];
  for (const row of nifty100) {
    const k = kiteBySymbol.get(row.symbol);
    if (!k) {
      missing.push(row.symbol);
      continue;
    }
    seed.push({
      symbol: row.symbol,
      exchange: "NSE",
      isin: row.isin,
      tradingsymbol: k.tradingsymbol,
      instrument_token: k.instrument_token,
      company: row.company,
      sector: row.industry,
    });
  }

  writeFileSync(outJsonPath, JSON.stringify(seed, null, 2));

  // Also upsert into the DB table so scan scripts can join by (symbol, exchange).
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync("db/schema.sql", "utf8"));

  const stmt = db.prepare(
    `INSERT INTO nifty100_universe(symbol, exchange, isin, tradingsymbol, instrument_token, company, sector, as_of_date)
     VALUES(@symbol, @exchange, @isin, @tradingsymbol, @instrument_token, @company, @sector, @as_of_date)
     ON CONFLICT(symbol, exchange) DO UPDATE SET
       isin=excluded.isin, tradingsymbol=excluded.tradingsymbol,
       instrument_token=excluded.instrument_token, company=excluded.company,
       sector=excluded.sector, as_of_date=excluded.as_of_date`,
  );
  const tx = db.transaction(() => {
    for (const r of seed) stmt.run({ ...r, as_of_date: asOf });
  });
  tx();
  db.close();

  process.stdout.write(
    JSON.stringify({
      status: missing.length ? "partial" : "ok",
      seeded: seed.length,
      missing_symbols: missing,
      out: outJsonPath,
      as_of_date: asOf,
    }) + "\n",
  );
}

try {
  main();
} catch (err) {
  process.stdout.write(
    JSON.stringify({
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    }) + "\n",
  );
  process.exit(1);
}
