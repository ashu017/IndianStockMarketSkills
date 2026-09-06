import Database from "better-sqlite3";
import { runOvernightBacktest } from "../lib/overnight-backtest";

/**
 * Runs the overnight close-to-open backtest across an entire index universe
 * and reports which stocks it actually works on, plus any pattern among them
 * (sector, price level, liquidity) — an empirical answer to "what kind of
 * stocks does this strategy suit," not a guess from priors.
 *
 * Usage: PORTFOLIO_DB_PATH=./data/portfolio.db npx tsx scripts/backtest-overnight-sweep.ts [INDEX_NAME]
 */

const DB_PATH = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";
const INDEX_NAME = process.argv[2] ?? "NIFTY 500";
const MIN_TRADES = 100; // require a real sample before trusting a symbol's number

async function main() {
  const db = new Database(DB_PATH, { readonly: true });

  const universe = db
    .prepare(`SELECT DISTINCT symbol, exchange, sector, company FROM index_universe WHERE index_name=?`)
    .all(INDEX_NAME) as { symbol: string; exchange: string; sector: string | null; company: string | null }[];

  console.error(`Universe: ${INDEX_NAME} — ${universe.length} symbols`);

  type Row = {
    symbol: string;
    sector: string | null;
    company: string | null;
    n_trades: number;
    win_rate_pct: number | null;
    total_return_pct: number;
    profit_factor: number | null;
    avg_return_pct: number | null;
    n_excluded: number;
    avg_volume: number | null;
    avg_close_rupees: number | null;
  };
  const results: Row[] = [];
  let done = 0;

  for (const u of universe) {
    const result = await runOvernightBacktest(db, u.symbol);
    done++;
    if (done % 100 === 0) console.error(`...${done}/${universe.length}`);
    if (!result || result.n_trades < MIN_TRADES) continue;

    const liq = db
      .prepare(
        `SELECT AVG(volume) as avg_volume, AVG(close) as avg_close
         FROM ohlc_daily WHERE instrument_token = (
           SELECT instrument_token FROM index_universe WHERE symbol=? AND index_name=? LIMIT 1
         )`,
      )
      .get(u.symbol, INDEX_NAME) as { avg_volume: number | null; avg_close: number | null };

    results.push({
      symbol: result.symbol,
      sector: u.sector,
      company: u.company,
      n_trades: result.n_trades,
      win_rate_pct: result.win_rate_pct,
      total_return_pct: result.total_return_pct,
      profit_factor: result.profit_factor,
      avg_return_pct: result.avg_return_pct,
      n_excluded: result.n_excluded_corporate_action,
      avg_volume: liq.avg_volume,
      avg_close_rupees: liq.avg_close !== null ? liq.avg_close / 100 : null,
    });
  }

  results.sort((a, b) => b.total_return_pct - a.total_return_pct);

  console.log(`\n=== Sample: ${results.length} symbols with >=${MIN_TRADES} scored trades (of ${universe.length} in ${INDEX_NAME}) ===`);

  console.log(`\n=== TOP 30 by total return ===`);
  for (const r of results.slice(0, 30)) {
    console.log(
      `${r.symbol.padEnd(14)} sector=${(r.sector ?? "?").padEnd(28)} total=${r.total_return_pct.toFixed(1).padStart(8)}%  win=${r.win_rate_pct?.toFixed(1)}%  pf=${r.profit_factor === Infinity ? "inf" : r.profit_factor?.toFixed(2)}  avg_close=₹${r.avg_close_rupees?.toFixed(0)}  avg_vol=${r.avg_volume?.toFixed(0)}  excl=${r.n_excluded}`,
    );
  }

  console.log(`\n=== BOTTOM 30 by total return ===`);
  for (const r of results.slice(-30).reverse()) {
    console.log(
      `${r.symbol.padEnd(14)} sector=${(r.sector ?? "?").padEnd(28)} total=${r.total_return_pct.toFixed(1).padStart(8)}%  win=${r.win_rate_pct?.toFixed(1)}%  pf=${r.profit_factor === Infinity ? "inf" : r.profit_factor?.toFixed(2)}  avg_close=₹${r.avg_close_rupees?.toFixed(0)}  avg_vol=${r.avg_volume?.toFixed(0)}  excl=${r.n_excluded}`,
    );
  }

  // Sector aggregation — median total return per sector, top vs bottom.
  const bySector = new Map<string, number[]>();
  for (const r of results) {
    const key = r.sector ?? "(unknown)";
    const arr = bySector.get(key);
    if (arr) arr.push(r.total_return_pct);
    else bySector.set(key, [r.total_return_pct]);
  }
  const sectorStats = [...bySector.entries()]
    .filter(([, arr]) => arr.length >= 5)
    .map(([sector, arr]) => {
      const sorted = [...arr].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
      return { sector, n: arr.length, median, mean };
    })
    .sort((a, b) => b.median - a.median);

  console.log(`\n=== Sector medians (total return %, sectors with >=5 symbols) ===`);
  for (const s of sectorStats) {
    console.log(`${s.sector.padEnd(30)} n=${String(s.n).padEnd(4)} median=${s.median.toFixed(1)}%  mean=${s.mean.toFixed(1)}%`);
  }

  // Correlation-ish: split by avg price level (low vs high) and by liquidity (low vs high volume).
  const withPrice = results.filter((r) => r.avg_close_rupees !== null);
  const priceSorted = [...withPrice].sort((a, b) => (a.avg_close_rupees ?? 0) - (b.avg_close_rupees ?? 0));
  const half = Math.floor(priceSorted.length / 2);
  const lowPrice = priceSorted.slice(0, half);
  const highPrice = priceSorted.slice(half);
  const avg = (arr: Row[]) => arr.reduce((a, b) => a + b.total_return_pct, 0) / arr.length;
  console.log(`\n=== Price-level split ===`);
  console.log(`Low-price half (avg close < ₹${priceSorted[half].avg_close_rupees?.toFixed(0)}): n=${lowPrice.length}, avg total return=${avg(lowPrice).toFixed(1)}%`);
  console.log(`High-price half: n=${highPrice.length}, avg total return=${avg(highPrice).toFixed(1)}%`);

  const withVol = results.filter((r) => r.avg_volume !== null);
  const volSorted = [...withVol].sort((a, b) => (a.avg_volume ?? 0) - (b.avg_volume ?? 0));
  const halfV = Math.floor(volSorted.length / 2);
  const lowVol = volSorted.slice(0, halfV);
  const highVol = volSorted.slice(halfV);
  console.log(`\n=== Liquidity (avg daily volume) split ===`);
  console.log(`Low-volume half: n=${lowVol.length}, avg total return=${avg(lowVol).toFixed(1)}%`);
  console.log(`High-volume half: n=${highVol.length}, avg total return=${avg(highVol).toFixed(1)}%`);

  console.log(`\n=== Overall ===`);
  console.log(`Median total return across all ${results.length} scored symbols: ${[...results].sort((a, b) => a.total_return_pct - b.total_return_pct)[Math.floor(results.length / 2)].total_return_pct.toFixed(1)}%`);
  console.log(`Fraction with positive total return: ${((results.filter((r) => r.total_return_pct > 0).length / results.length) * 100).toFixed(1)}%`);

  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
