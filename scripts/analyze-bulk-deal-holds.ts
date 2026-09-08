import Database from "better-sqlite3";
// NIFTY 50 ETF used as a same-window market benchmark — bulk-deal stocks skew
// toward small/microcaps, so a raw negative return needs a "vs. what". Imported
// rather than re-declared so this analysis and the backtests can't drift onto
// different yardsticks. (lib/benchmark.ts deliberately avoids `server-only`,
// which is what lets a standalone tsx script import it.)
import { loadBenchmarkSeries } from "../lib/benchmark";

/**
 * For institutional bulk-deal BUYs that were presumably held (no matching
 * bulk/block SELL by the same client+symbol before a given horizon), what was
 * the forward price return at 1-week / 1-month / 1-year?
 *
 * "Held through horizon H" is checked independently PER horizon, not once
 * globally against the longest horizon — a buy sold after 2 months still
 * counts toward the 1-week and 1-month buckets, just not 1-year. This trades
 * a small amount of definitional strictness for much better sample size,
 * especially at 1-year where most positions eventually see some large-holder
 * activity.
 *
 * Entry reference is the bulk deal's own disclosed trade price (not the
 * day's OHLC close) — that's what the institution actually paid, and is more
 * faithful than a same-day close that can differ meaningfully on a day with
 * a >0.5%-of-volume block trade. Forward price still comes from ohlc_daily,
 * offset by trading-day count from the first bar on/after deal_date.
 *
 * Round-trip filter: a client showing BOTH a buy and a sell within
 * ROUND_TRIP_WINDOW_DAYS of each other on the same symbol — regardless of
 * which came first — is excluded entirely, not just from one horizon. This
 * is aimed at HFT/arb-style firms (common among bulk-deal filers, since a
 * single day's 0.5%-of-volume trade easily comes from a market maker) that
 * turn a position over in days, not the genuine accumulation this analysis
 * is trying to isolate.
 *
 * Caveats (real, not hedging): "held" here means no DISCLOSED bulk/block
 * SELL by that client — it says nothing about ordinary market-trade exits,
 * which never appear in this dataset. Client-name string matching is exact;
 * minor formatting variants for the same legal entity would be missed.
 * ~41% of bulk-deal symbols have no OHLC coverage at all (mostly SME/microcap
 * listings outside any tracked index) and are excluded outright. The
 * round-trip window (5 calendar days) is a transparent, tunable threshold,
 * not a certain classifier — a genuine long-term holder who also trimmed a
 * small amount days after a big buy would be misclassified as a round-trip.
 *
 * Usage: PORTFOLIO_DB_PATH=./data/portfolio.db npx tsx scripts/analyze-bulk-deal-holds.ts
 */

const DB_PATH = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";

const HORIZONS = [
  { label: "1-week", tradingDays: 5 },
  { label: "1-month", tradingDays: 21 },
  { label: "1-year", tradingDays: 252 },
];

// Guard against a stale reference bar: some symbols' OHLC history starts
// years after their bulk-deal history (backfill depth varies by symbol).
// findIndex(">= deal_date") would otherwise silently pick the SYMBOL'S
// FIRST-EVER available bar as "day 0" when there's a multi-year coverage
// gap, comparing a 2023 disclosed price against an unrelated 2026 close.
// Affects ~2% of matched rows — reject rather than silently misattribute.
const MAX_REFERENCE_BAR_GAP_DAYS = 10;

// NIFTY 50 ETF, used as a same-window market benchmark — bulk-deal stocks
// skew toward small/microcaps, so a raw negative return needs a "vs. what".
// Imported from lib/benchmark.ts rather than re-declared, so the backtests and
// this analysis can't silently drift onto different yardsticks.

// A buy with a sell (either order) by the same client+symbol within this many
// calendar days is treated as an HFT/arb round trip, not a genuine hold —
// excluded entirely, not just from the horizons it would fail anyway.
const ROUND_TRIP_WINDOW_DAYS = 5;

interface BuyRow {
  deal_date: string;
  symbol: string;
  client_name: string;
  price: number | null;
}

interface SellRow {
  deal_date: string;
  symbol: string;
  client_name: string;
}

interface Bar {
  trade_date: string;
  close: number; // rupees
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/** True if any sell by this client+symbol falls within ROUND_TRIP_WINDOW_DAYS
 * of the buy date, in either direction (order can vary — a sell shortly
 * BEFORE the buy is just as much a round trip as one shortly after). */
function isRoundTrip(buyDate: string, sellDates: string[]): boolean {
  const buyTime = new Date(buyDate).getTime();
  return sellDates.some((sd) => Math.abs(new Date(sd).getTime() - buyTime) <= ROUND_TRIP_WINDOW_DAYS * 86_400_000);
}

function main() {
  const db = new Database(DB_PATH, { readonly: true });

  const buys = db
    .prepare(
      `SELECT deal_date, symbol, client_name, price FROM bulk_deals
       WHERE is_institution = 1 AND side = 'BUY' ORDER BY symbol, client_name, deal_date ASC`,
    )
    .all() as BuyRow[];

  const allSells = db
    .prepare(`SELECT deal_date, symbol, client_name FROM bulk_deals WHERE side = 'SELL'`)
    .all() as SellRow[];

  const sellsByKey = new Map<string, string[]>();
  for (const s of allSells) {
    const key = `${s.symbol}::${s.client_name}`;
    const arr = sellsByKey.get(key);
    if (arr) arr.push(s.deal_date);
    else sellsByKey.set(key, [s.deal_date]);
  }
  for (const arr of sellsByKey.values()) arr.sort();

  const barsCache = new Map<string, Bar[]>();
  function loadBars(symbol: string): Bar[] {
    const cached = barsCache.get(symbol);
    if (cached) return cached;
    const tokenRow = db
      .prepare(`SELECT instrument_token FROM index_universe WHERE symbol = ? LIMIT 1`)
      .get(symbol) as { instrument_token: number } | undefined;
    if (!tokenRow) {
      barsCache.set(symbol, []);
      return [];
    }
    const rows = db
      .prepare(`SELECT trade_date, close FROM ohlc_daily WHERE instrument_token = ? ORDER BY trade_date ASC`)
      .all(tokenRow.instrument_token) as { trade_date: string; close: number }[];
    const bars = rows.map((r) => ({ trade_date: r.trade_date, close: r.close / 100 }));
    barsCache.set(symbol, bars);
    return bars;
  }

  // Cleaned benchmark series rather than raw ohlc_daily closes. ohlc_daily is
  // not corporate-action adjusted and IVZINNIFTY split 1:10 on 2026-07-31, so a
  // raw load makes every horizon window crossing that date read as the Nifty 50
  // losing ~90%; there is also a thin-liquidity bad print on 2024-02-19.
  // loadBenchmarkSeries back-adjusts the split and drops the bad print, and
  // reports how many of each it touched. The returned values are normalized
  // index levels, which is all benchmarkReturn needs — it only takes ratios.
  const benchSeries = loadBenchmarkSeries(db, {
    fromDate: "1900-01-01",
    toDate: "2999-12-31",
    startingRupees: 100,
  });
  const benchBars: Bar[] = benchSeries
    ? benchSeries.points.map((p) => ({ trade_date: p.date, close: p.value_rupees }))
    : [];
  // Benchmark return over the SAME calendar window as a (idx0,targetIdx) pair
  // of a symbol's bars — looked up by date, since the benchmark's own bar
  // indices don't line up with any individual symbol's index positions.
  function benchmarkReturn(symbolBars: Bar[], idx0: number, targetIdx: number): number | null {
    if (benchBars.length === 0) return null;
    const startDate = symbolBars[idx0].trade_date;
    const endDate = symbolBars[targetIdx].trade_date;
    const startIdx = benchBars.findIndex((b) => b.trade_date >= startDate);
    const endIdx = benchBars.findIndex((b) => b.trade_date >= endDate);
    if (startIdx === -1 || endIdx === -1) return null;
    return (benchBars[endIdx].close / benchBars[startIdx].close - 1) * 100;
  }

  interface Event {
    symbol: string;
    client_name: string;
    deal_date: string;
    horizon: string;
    return_pct: number;
    benchmark_return_pct: number | null;
  }
  const events: Event[] = [];

  let excludedNoBars = 0;
  let excludedNoDay0 = 0;
  let excludedNoPrice = 0;
  let excludedStaleBar = 0;
  let excludedRoundTrip = 0;

  for (const buy of buys) {
    if (buy.price === null || buy.price <= 0) {
      excludedNoPrice++;
      continue;
    }
    const bars = loadBars(buy.symbol);
    if (bars.length === 0) {
      excludedNoBars++;
      continue;
    }
    const idx0 = bars.findIndex((b) => b.trade_date >= buy.deal_date);
    if (idx0 === -1) {
      excludedNoDay0++;
      continue;
    }
    const gapDays = (new Date(bars[idx0].trade_date).getTime() - new Date(buy.deal_date).getTime()) / 86_400_000;
    if (gapDays > MAX_REFERENCE_BAR_GAP_DAYS) {
      excludedStaleBar++;
      continue;
    }
    const sellDates = sellsByKey.get(`${buy.symbol}::${buy.client_name}`) ?? [];
    if (isRoundTrip(buy.deal_date, sellDates)) {
      excludedRoundTrip++;
      continue;
    }

    for (const h of HORIZONS) {
      const targetIdx = idx0 + h.tradingDays;
      if (targetIdx >= bars.length) continue; // horizon not reached yet in available history
      const targetDate = bars[targetIdx].trade_date;
      const soldBeforeHorizon = sellDates.some((sd) => sd > buy.deal_date && sd <= targetDate);
      if (soldBeforeHorizon) continue; // not "held" through this horizon
      const returnPct = (bars[targetIdx].close / buy.price - 1) * 100;
      const benchReturnPct = benchmarkReturn(bars, idx0, targetIdx);
      events.push({
        symbol: buy.symbol,
        client_name: buy.client_name,
        deal_date: buy.deal_date,
        horizon: h.label,
        return_pct: returnPct,
        benchmark_return_pct: benchReturnPct,
      });
    }
  }

  console.log(`Institutional BUY rows considered: ${buys.length}`);
  console.log(`Excluded — no disclosed price: ${excludedNoPrice}`);
  console.log(`Excluded — symbol not mapped to a tracked index / no OHLC at all: ${excludedNoBars}`);
  console.log(`Excluded — no OHLC bar on/after deal date: ${excludedNoDay0}`);
  console.log(`Excluded — stale reference bar (>${MAX_REFERENCE_BAR_GAP_DAYS}d gap to deal date): ${excludedStaleBar}`);
  console.log(`Excluded — round trip (sell within ${ROUND_TRIP_WINDOW_DAYS}d of buy, same client+symbol, either order): ${excludedRoundTrip}`);
  console.log(
    benchSeries
      ? `Benchmark: ${benchSeries.label}, ${benchSeries.n_bars} bars ${benchSeries.first_date}..${benchSeries.last_date} ` +
          `(${benchSeries.n_split_adjustments} corporate action(s) back-adjusted, ${benchSeries.n_outlier_bars_dropped} bad print(s) dropped)`
      : "Benchmark: unavailable — benchmark-relative columns will read as n/a",
  );
  console.log("");

  function report(label: string, rs: Event[]) {
    const returns = rs.map((e) => e.return_pct);
    const benchPairs = rs.filter((e) => e.benchmark_return_pct !== null);
    if (returns.length === 0) {
      console.log(`${label}: no data`);
      return;
    }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const winRate = (returns.filter((r) => r > 0).length / returns.length) * 100;
    const sorted = [...returns].sort((a, b) => a - b);
    const p10 = sorted[Math.floor(sorted.length * 0.1)];
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    const excess = benchPairs.map((e) => e.return_pct - (e.benchmark_return_pct as number));
    const excessMedian = benchPairs.length ? median(excess) : null;
    const beatMarketRate = benchPairs.length ? (excess.filter((x) => x > 0).length / excess.length) * 100 : null;
    console.log(
      `${label.padEnd(8)} (n=${returns.length}): mean=${mean.toFixed(2)}%  median=${median(returns).toFixed(2)}%  ` +
        `win_rate=${winRate.toFixed(1)}%  p10=${p10.toFixed(1)}%  p90=${p90.toFixed(1)}%  ` +
        `| vs NIFTY50: median_excess=${excessMedian !== null ? excessMedian.toFixed(2) + "%" : "n/a"}  beat_market_rate=${beatMarketRate !== null ? beatMarketRate.toFixed(1) + "%" : "n/a"}`,
    );
  }

  for (const h of HORIZONS) report(h.label, events.filter((e) => e.horizon === h.label));

  // Same computation but WITHOUT the per-horizon "held through" filter (still
  // excluding round trips — that's a data-quality step, not a "does holding
  // matter" variable), to isolate whether the eventual-hold status itself
  // carries any signal vs. just buying when institutions buy.
  console.log(`\n=== Same round-trip-filtered population, but ignoring the per-horizon hold check ===`);
  const eventsUnfiltered: Event[] = [];
  for (const buy of buys) {
    if (buy.price === null || buy.price <= 0) continue;
    const bars = loadBars(buy.symbol);
    if (bars.length === 0) continue;
    const idx0 = bars.findIndex((b) => b.trade_date >= buy.deal_date);
    if (idx0 === -1) continue;
    const gapDays = (new Date(bars[idx0].trade_date).getTime() - new Date(buy.deal_date).getTime()) / 86_400_000;
    if (gapDays > MAX_REFERENCE_BAR_GAP_DAYS) continue;
    const sellDates = sellsByKey.get(`${buy.symbol}::${buy.client_name}`) ?? [];
    if (isRoundTrip(buy.deal_date, sellDates)) continue;
    for (const h of HORIZONS) {
      const targetIdx = idx0 + h.tradingDays;
      if (targetIdx >= bars.length) continue;
      const returnPct = (bars[targetIdx].close / buy.price - 1) * 100;
      const benchReturnPct = benchmarkReturn(bars, idx0, targetIdx);
      eventsUnfiltered.push({
        symbol: buy.symbol,
        client_name: buy.client_name,
        deal_date: buy.deal_date,
        horizon: h.label,
        return_pct: returnPct,
        benchmark_return_pct: benchReturnPct,
      });
    }
  }
  for (const h of HORIZONS) report(h.label, eventsUnfiltered.filter((e) => e.horizon === h.label));

  db.close();
}

main();

