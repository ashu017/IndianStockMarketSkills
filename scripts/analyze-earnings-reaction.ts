import Database from "better-sqlite3";

/**
 * Event study: does the size of a quarter's YoY/QoQ profit growth predict
 * the stock's price reaction around the results announcement?
 *
 * Timing (load-bearing): results are filed AFTER market close (every sampled
 * filing across the pilot was 15:30+ IST), so the announcement DATE's own
 * close is the correct "pre-reaction" reference price — the market hasn't
 * seen the news yet when that close printed. The immediate reaction is the
 * NEXT trading day; drift windows extend N trading days further.
 *
 * Usage: PORTFOLIO_DB_PATH=./data/portfolio.db npx tsx scripts/analyze-earnings-reaction.ts
 */

const DB_PATH = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";
const DRIFT_WINDOWS = [5, 10, 20]; // trading days after the immediate-reaction day

interface QRow {
  symbol: string;
  exchange: string;
  quarter_end_date: string;
  net_profit_cr: number | null;
  announcement_at: string | null;
}

interface Bar {
  trade_date: string;
  open: number;
  close: number;
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return quantile(s, 0.5);
}

async function main() {
  const db = new Database(DB_PATH, { readonly: true });

  const rows = db
    .prepare(
      `SELECT symbol, exchange, quarter_end_date, net_profit_cr, announcement_at
       FROM quarterly_results WHERE announcement_at IS NOT NULL ORDER BY symbol, quarter_end_date ASC`,
    )
    .all() as QRow[];

  console.error(`Loaded ${rows.length} quarter-observations with a matched announcement date.`);

  // Group by symbol to compute YoY (4 quarters back) / QoQ (1 quarter back) growth.
  const bySymbol = new Map<string, QRow[]>();
  for (const r of rows) {
    const arr = bySymbol.get(r.symbol);
    if (arr) arr.push(r);
    else bySymbol.set(r.symbol, [r]);
  }

  interface Event {
    symbol: string;
    quarter_end_date: string;
    announcement_at: string;
    yoy_growth_pct: number | null;
    qoq_growth_pct: number | null;
    immediate_reaction_pct: number | null;
    drift_pct: Record<number, number | null>;
  }
  const events: Event[] = [];

  // Cache bars per (symbol, exchange) — loaded once per symbol, reused across its quarters.
  const barsCache = new Map<string, Bar[]>();
  function loadBars(symbol: string, exchange: string): Bar[] {
    const key = `${symbol}::${exchange}`;
    const cached = barsCache.get(key);
    if (cached) return cached;
    const tokenRow = db
      .prepare(`SELECT instrument_token FROM index_universe WHERE symbol=? AND exchange=? LIMIT 1`)
      .get(symbol, exchange) as { instrument_token: number } | undefined;
    if (!tokenRow) {
      barsCache.set(key, []);
      return [];
    }
    const bars = db
      .prepare(`SELECT trade_date, open, close FROM ohlc_daily WHERE instrument_token=? ORDER BY trade_date ASC`)
      .all(tokenRow.instrument_token) as Bar[];
    barsCache.set(key, bars);
    return bars;
  }

  for (const [symbol, list] of bySymbol) {
    const exchange = list[0].exchange;
    const bars = loadBars(symbol, exchange);
    if (bars.length === 0) continue;

    for (let i = 0; i < list.length; i++) {
      const q = list[i];
      if (q.net_profit_cr === null || !q.announcement_at) continue;

      const yoyPrior = list[i - 4];
      const qoqPrior = list[i - 1];
      const yoyGrowth =
        yoyPrior && yoyPrior.net_profit_cr && yoyPrior.net_profit_cr !== 0
          ? ((q.net_profit_cr - yoyPrior.net_profit_cr) / Math.abs(yoyPrior.net_profit_cr)) * 100
          : null;
      const qoqGrowth =
        qoqPrior && qoqPrior.net_profit_cr && qoqPrior.net_profit_cr !== 0
          ? ((q.net_profit_cr - qoqPrior.net_profit_cr) / Math.abs(qoqPrior.net_profit_cr)) * 100
          : null;

      // Announcement date's own close = pre-reaction reference (news wasn't
      // out yet when that bar printed, since filings are all after-close).
      const announceDate = q.announcement_at.slice(0, 10);
      const refIdx = bars.findIndex((b) => b.trade_date >= announceDate);
      if (refIdx === -1) continue;
      // If the bar found is AFTER the announce date (announce date wasn't a
      // trading day — shouldn't happen for after-close same-day filings, but
      // guard anyway), treat that bar itself as day 0 rather than day 1.
      const day0Idx = bars[refIdx].trade_date === announceDate ? refIdx : refIdx - 1;
      if (day0Idx < 0 || day0Idx + 1 >= bars.length) continue;

      const refClose = bars[day0Idx].close;
      const nextDay = bars[day0Idx + 1];
      const immediateReaction = refClose > 0 ? (nextDay.close / refClose - 1) * 100 : null;

      const drift: Record<number, number | null> = {};
      for (const w of DRIFT_WINDOWS) {
        const idx = day0Idx + 1 + w;
        drift[w] = idx < bars.length && refClose > 0 ? (bars[idx].close / refClose - 1) * 100 : null;
      }

      events.push({
        symbol,
        quarter_end_date: q.quarter_end_date,
        announcement_at: q.announcement_at,
        yoy_growth_pct: yoyGrowth,
        qoq_growth_pct: qoqGrowth,
        immediate_reaction_pct: immediateReaction,
        drift_pct: drift,
      });
    }
  }

  console.error(`Built ${events.length} priceable events.`);

  // "immediate" = next trading day close vs announcement-day close.
  // 5/10/20 = trading days after that (5 ≈ 1 calendar week).
  type ReactionKind = "immediate" | 5 | 10 | 20;
  function getReaction(e: Event, kind: ReactionKind): number | null {
    return kind === "immediate" ? e.immediate_reaction_pct : e.drift_pct[kind];
  }

  function bucketReport(metricKey: "yoy_growth_pct" | "qoq_growth_pct", label: string, reactionKind: ReactionKind, reactionLabel: string) {
    const withMetric = events.filter((e) => e[metricKey] !== null && getReaction(e, reactionKind) !== null);
    console.log(`\n=== Bucket sort by ${label} → ${reactionLabel} (n=${withMetric.length} events) ===`);
    if (withMetric.length < 10) {
      console.log("Too few observations to bucket meaningfully.");
      return;
    }
    const sorted = [...withMetric].sort((a, b) => (a[metricKey] as number) - (b[metricKey] as number));
    const nBuckets = withMetric.length >= 40 ? 5 : 3;
    const bucketSize = Math.floor(sorted.length / nBuckets);
    for (let b = 0; b < nBuckets; b++) {
      const start = b * bucketSize;
      const end = b === nBuckets - 1 ? sorted.length : start + bucketSize;
      const slice = sorted.slice(start, end);
      const metricVals = slice.map((e) => e[metricKey] as number);
      const reactions = slice.map((e) => getReaction(e, reactionKind) as number);
      const driftVals: Record<number, number[]> = {};
      for (const w of DRIFT_WINDOWS) driftVals[w] = slice.map((e) => e.drift_pct[w]).filter((v): v is number => v !== null);
      const driftStr = DRIFT_WINDOWS.map(
        (w) => `+${w}d=${driftVals[w].length ? median(driftVals[w]).toFixed(2) : "—"}%`,
      ).join(" ");
      console.log(
        `Bucket ${b + 1}/${nBuckets} (n=${slice.length}): ${label} median=${median(metricVals).toFixed(1)}%  |  ${reactionLabel} median=${median(reactions).toFixed(2)}%, mean=${(reactions.reduce((a, x) => a + x, 0) / reactions.length).toFixed(2)}%  |  all windows: immediate=${median(slice.map((e) => e.immediate_reaction_pct).filter((v): v is number => v !== null)).toFixed(2)}% ${driftStr}`,
      );
    }
  }

  const REACTION_KIND: ReactionKind = 5;
  const REACTION_LABEL = "1-week (5 trading day) return";
  bucketReport("yoy_growth_pct", "YoY net profit growth", REACTION_KIND, REACTION_LABEL);
  bucketReport("qoq_growth_pct", "QoQ net profit growth", REACTION_KIND, REACTION_LABEL);

  // Simple correlation check (Pearson) between growth metric and immediate reaction.
  function pearson(xs: number[], ys: number[]): number {
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, dx2 = 0, dy2 = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - mx, dy = ys[i] - my;
      num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
    }
    return num / Math.sqrt(dx2 * dy2);
  }
  console.log(`\n=== Correlation with reaction, by window ===`);
  for (const [kind, kindLabel] of [["immediate", "next-day"], [5, "1-week"], [10, "2-week"], [20, "1-month"]] as [ReactionKind, string][]) {
    const yoyPairs = events.filter((e) => e.yoy_growth_pct !== null && getReaction(e, kind) !== null);
    const qoqPairs = events.filter((e) => e.qoq_growth_pct !== null && getReaction(e, kind) !== null);
    const yoyR = pearson(yoyPairs.map((e) => e.yoy_growth_pct as number), yoyPairs.map((e) => getReaction(e, kind) as number));
    const qoqR = pearson(qoqPairs.map((e) => e.qoq_growth_pct as number), qoqPairs.map((e) => getReaction(e, kind) as number));
    console.log(`${kindLabel.padEnd(9)} — YoY r=${yoyR.toFixed(3)} (n=${yoyPairs.length})  |  QoQ r=${qoqR.toFixed(3)} (n=${qoqPairs.length})`);
  }

  console.log(`\n=== Overall, by window ===`);
  for (const [kind, kindLabel] of [["immediate", "next-day"], [5, "1-week"], [10, "2-week"], [20, "1-month"]] as [ReactionKind, string][]) {
    const allReactions = events.map((e) => getReaction(e, kind)).filter((v): v is number => v !== null);
    console.log(
      `${kindLabel.padEnd(9)} (n=${allReactions.length}): median=${median(allReactions).toFixed(2)}%, mean=${(allReactions.reduce((a, b) => a + b, 0) / allReactions.length).toFixed(2)}%, %positive=${((allReactions.filter((r) => r > 0).length / allReactions.length) * 100).toFixed(1)}%`,
    );
  }
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
