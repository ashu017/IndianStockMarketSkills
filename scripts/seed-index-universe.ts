import { readFileSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";

/**
 * Generalized index-universe seeder. Reads an NSE constituent CSV, joins with
 * the Kite instruments dump to attach instrument_tokens, and upserts rows into
 * `index_universe` tagged with the given INDEX_NAME. Rebuild quarterly when NSE
 * rebalances an index.
 *
 * Inputs (fetch these before running — kept out of the script so it's deterministic):
 *   NSE_CSV                — /tmp/<index>.csv from
 *     https://nsearchives.nseindia.com/content/indices/ind_<index>list.csv
 *   KITE_INSTRUMENTS_CSV   — /tmp/kite-instruments.csv from
 *     https://api.kite.trade/instruments
 *   INDEX_NAME             — canonical name to store, e.g. "NIFTY 200"
 *   OUT_JSON (optional)    — companion seed JSON for git; e.g. data/nifty200-instruments.json
 *
 * Idempotent — repeated runs just upsert on (index_name, symbol, exchange).
 */

interface NseRow {
  company: string;
  industry: string;
  symbol: string;
  isin: string;
}

interface KiteInstrument {
  instrument_token: number;
  tradingsymbol: string;
  name: string;
}

interface SeedRow {
  index_name: string;
  symbol: string;
  exchange: "NSE";
  isin: string;
  tradingsymbol: string;
  instrument_token: number;
  company: string;
  sector: string;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
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

function parseNseIndex(csv: string): NseRow[] {
  const lines = csv.trim().split("\n");
  const rows: NseRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const f = splitCsvLine(lines[i]);
    if (f.length < 5) continue;
    const [company, industry, symbol, series, isin] = f;
    if (series?.toUpperCase().trim() !== "EQ") continue;
    rows.push({
      company: company.replace(/^"|"$/g, "").trim(),
      industry: industry.replace(/^"|"$/g, "").trim(),
      symbol: symbol.replace(/^"|"$/g, "").trim(),
      isin: isin.replace(/^"|"$/g, "").trim(),
    });
  }
  return rows;
}

function loadKiteNSEEQ(csv: string): Map<string, KiteInstrument> {
  const lines = csv.split("\n");
  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const iToken = header.indexOf("instrument_token");
  const iTsym = header.indexOf("tradingsymbol");
  const iName = header.indexOf("name");
  const iType = header.indexOf("instrument_type");
  const iSeg = header.indexOf("segment");
  const iExch = header.indexOf("exchange");

  const map = new Map<string, KiteInstrument>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const f = splitCsvLine(line);
    if (f[iExch] !== "NSE" || f[iType] !== "EQ" || f[iSeg] !== "NSE") continue;
    const tsym = f[iTsym].replace(/^"|"$/g, "").trim();
    map.set(tsym, {
      instrument_token: Number(f[iToken]),
      tradingsymbol: tsym,
      name: f[iName].replace(/^"|"$/g, "").trim(),
    });
  }
  return map;
}

function istDate(now = Date.now()): string {
  return new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);
}

function main(): void {
  const indexName = process.env.INDEX_NAME;
  if (!indexName) throw new Error("INDEX_NAME env is required (e.g., 'NIFTY 200')");

  const nseCsvPath = process.env.NSE_CSV;
  if (!nseCsvPath) throw new Error("NSE_CSV env is required (path to ind_<index>list.csv)");

  const kiteCsvPath = process.env.KITE_INSTRUMENTS_CSV ?? "/tmp/kite-instruments.csv";
  const outJsonPath = process.env.OUT_JSON ?? "";
  const dbPath = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";

  const nseRows = parseNseIndex(readFileSync(nseCsvPath, "utf8"));
  const kiteMap = loadKiteNSEEQ(readFileSync(kiteCsvPath, "utf8"));
  const asOf = istDate();

  const seed: SeedRow[] = [];
  const missing: string[] = [];
  for (const r of nseRows) {
    const k = kiteMap.get(r.symbol);
    if (!k) {
      missing.push(r.symbol);
      continue;
    }
    seed.push({
      index_name: indexName,
      symbol: r.symbol,
      exchange: "NSE",
      isin: r.isin,
      tradingsymbol: k.tradingsymbol,
      instrument_token: k.instrument_token,
      company: r.company,
      sector: r.industry,
    });
  }

  if (outJsonPath) {
    writeFileSync(outJsonPath, JSON.stringify(seed, null, 2));
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync("db/schema.sql", "utf8"));

  const stmt = db.prepare(
    `INSERT INTO index_universe(index_name, symbol, exchange, isin, tradingsymbol, instrument_token, company, sector, as_of_date)
     VALUES(@index_name, @symbol, @exchange, @isin, @tradingsymbol, @instrument_token, @company, @sector, @as_of_date)
     ON CONFLICT(index_name, symbol, exchange) DO UPDATE SET
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
      index_name: indexName,
      seeded: seed.length,
      missing_symbols: missing,
      out: outJsonPath || null,
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
