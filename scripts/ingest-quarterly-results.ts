import Database from "better-sqlite3";
import { fetchQuarterlyResults } from "../lib/screener-quarterly";
import { fetchFinancialResultAnnouncements, matchAnnouncementToQuarter } from "../lib/nse-announcements";

/**
 * Pilot ingestion: fetch ~13 quarters of Sales/Net Profit/EPS (Screener) +
 * exact results-announcement timestamps (NSE) for a small, diversified set
 * of large caps, and persist into quarterly_results. Two live external
 * fetches per symbol — this is why the pilot is scoped small before any
 * attempt at NIFTY 500 scale (each fetch is unauthenticated web scraping,
 * not a stable public API contract; rate limits are unknown).
 *
 * Usage: PORTFOLIO_DB_PATH=./data/portfolio.db npx tsx scripts/ingest-quarterly-results.ts
 */

const DB_PATH = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";

// Diversified across sectors: banks, IT, FMCG, auto, pharma, cement, paints,
// telecom, conglomerate, NBFC — not cherry-picked for the analysis outcome.
const PILOT_SYMBOLS = [
  "RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK",
  "HINDUNILVR", "ITC", "LT", "SBIN", "BHARTIARTL",
  "KOTAKBANK", "AXISBANK", "MARUTI", "SUNPHARMA", "TITAN",
  "ULTRACEMCO", "ASIANPAINT", "BAJFINANCE", "WIPRO", "TATAMOTORS",
];

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  const upsert = db.prepare(
    `INSERT INTO quarterly_results(symbol, exchange, quarter_end_date, sales_cr, net_profit_cr, eps, announcement_at, fetched_at)
     VALUES(?, 'NSE', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol, exchange, quarter_end_date) DO UPDATE SET
       sales_cr=excluded.sales_cr, net_profit_cr=excluded.net_profit_cr, eps=excluded.eps,
       announcement_at=excluded.announcement_at, fetched_at=excluded.fetched_at`,
  );

  const summary: { symbol: string; quarters: number; matched: number; status: string }[] = [];

  for (const symbol of PILOT_SYMBOLS) {
    try {
      const [quarters, announcements] = await Promise.all([
        fetchQuarterlyResults(symbol),
        fetchFinancialResultAnnouncements(symbol),
      ]);
      if (!quarters || quarters.length === 0) {
        summary.push({ symbol, quarters: 0, matched: 0, status: "no quarterly data" });
        continue;
      }
      const now = new Date().toISOString();
      let matched = 0;
      const tx = db.transaction(() => {
        for (const q of quarters) {
          const announcementAt = matchAnnouncementToQuarter(q.quarter_end_date, announcements);
          if (announcementAt) matched++;
          upsert.run(symbol, q.quarter_end_date, q.sales_cr, q.net_profit_cr, q.eps, announcementAt, now);
        }
      });
      tx();
      summary.push({ symbol, quarters: quarters.length, matched, status: "ok" });
      console.error(`${symbol}: ${quarters.length} quarters, ${matched} matched to an announcement date`);
    } catch (e) {
      summary.push({ symbol, quarters: 0, matched: 0, status: `error: ${e instanceof Error ? e.message : String(e)}` });
      console.error(`${symbol}: ERROR — ${e instanceof Error ? e.message : String(e)}`);
    }
    await sleep(1000); // be polite to two unauthenticated scraped sources
  }

  console.log(JSON.stringify(summary, null, 2));
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
