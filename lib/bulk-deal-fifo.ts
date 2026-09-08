import type Database from "better-sqlite3";

/**
 * FIFO-reconstructs each institutional bulk-deal client's actual realized
 * trades (buy lot matched against later sell, same client+symbol), then
 * classifies each CLIENT (not each trade) as HFT/market-maker-like or not,
 * based on their OVERALL median holding period across every realized trade
 * they show up in. Firms below the threshold are excluded entirely — this is
 * a firm-level filter, not a per-trade one: a genuine long-term holder who
 * also happens to flip one position quickly still counts as non-HFT, while a
 * firm whose typical pattern is same-day turnover (market makers, prop/arb
 * shops) is dropped even for their occasional longer-held position.
 *
 * See scripts/analyze-bulk-deal-fifo.ts for the original single-shot script
 * this was extracted from; that script now just calls this and prints the
 * result. This lib version exists so the same computation can back a live
 * strategy-page panel (app/api/bulk-deals/institutional-holds/route.ts).
 *
 * Known, unaddressed caveats (same as the originating script):
 *   - No corporate-action adjustment on buy/sell price pairs.
 *   - A sell with no prior disclosed buy lot (ordinary-market-acquired
 *     shares, IPO allotment, pledge release, etc.) is excluded from P&L.
 *   - A buy still open at end-of-data is unrealized, reported separately.
 *   - is_institution is the keyword heuristic from scripts/ingest-bulk-deals.ts,
 *     not a verified legal classification.
 */

const DEFAULT_HFT_HOLDING_DAYS_THRESHOLD = 5;
const DEFAULT_MIN_TRADES_FOR_FIRM_LEADERBOARD = 5;

interface Deal {
  deal_date: string;
  symbol: string;
  client_name: string;
  side: "BUY" | "SELL";
  quantity: number | null;
  price: number | null;
}

interface Lot {
  buy_date: string;
  buy_price: number;
  qty_remaining: number;
}

export interface RealizedTrade {
  symbol: string;
  client_name: string;
  buy_date: string;
  buy_price: number;
  sell_date: string;
  sell_price: number;
  qty: number;
  return_pct: number;
  holding_days: number;
}

export interface OpenLot {
  symbol: string;
  buy_date: string;
  buy_price: number;
  qty: number;
}

export interface FirmStats {
  client_name: string;
  n: number;
  total_qty: number;
  qty_weighted_return_pct: number;
  win_rate_pct: number;
  median_return_pct: number;
  median_holding_days: number;
}

export interface OpenLotWithClient extends OpenLot {
  client_name: string;
}

export interface HoldingBucketStats {
  label: string;
  n: number;
  mean_return_pct: number;
  median_return_pct: number;
  win_rate_pct: number;
}

export interface BulkDealFifoResult {
  hft_holding_days_threshold: number;
  // Freshness of the underlying table, so a silently-broken daily refresh
  // (scripts/cron/refresh-bulk-deals.sh) shows up as visibly stale data
  // instead of quietly serving last week's numbers as if they were current.
  data_through: string | null; // latest deal_date present
  last_fetched_at: string | null; // when the refresh job last wrote a row
  total_institutional_buy_rows: number;
  realized_trade_count_all_firms: number;
  hft_firms_excluded_count: number;
  hft_realized_trades_excluded_count: number;
  non_hft_realized_trade_count: number;
  unmatched_sell_events: number;
  unmatched_sell_qty: number;
  open_lots_count: number;
  open_lots_qty: number;
  // Open (never disclosed-sold) lots belonging to non-HFT clients only —
  // most-recent buy date first, paginated (the full list runs into the
  // thousands). A client with zero realized trades has no evidence either
  // way and defaults to non-HFT (can't classify from nothing).
  non_hft_open_lots_total: number;
  non_hft_open_lots_page: number;
  non_hft_open_lots_page_size: number;
  non_hft_open_lots: OpenLotWithClient[];
  overall: {
    mean_return_pct: number;
    median_return_pct: number;
    qty_weighted_return_pct: number;
    win_rate_pct: number;
    median_holding_days: number;
    mean_holding_days: number;
  } | null;
  holding_buckets: HoldingBucketStats[];
  top_active_firms: FirmStats[];
  best_firms: FirmStats[];
  worst_firms: FirmStats[];
  caveats: string[];
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/** FIFO-match one (symbol, client) group's chronological BUY/SELL events.
 * Same-day buys are applied before same-day sells (see module header). Shared
 * by computeBulkDealFifoAnalysis (all clients) and getClientTrades (one). */
function fifoMatchGroup(events: Deal[]): {
  realized: RealizedTrade[];
  unmatchedSellQty: number;
  unmatchedSellEvents: number;
  openLots: Lot[];
} {
  const sorted = [...events].sort((a, b) => {
    if (a.deal_date !== b.deal_date) return a.deal_date < b.deal_date ? -1 : 1;
    if (a.side === b.side) return 0;
    return a.side === "BUY" ? -1 : 1;
  });

  const queue: Lot[] = [];
  const realized: RealizedTrade[] = [];
  let unmatchedSellQty = 0;
  let unmatchedSellEvents = 0;

  for (const ev of sorted) {
    const qty = ev.quantity as number;
    const price = ev.price as number;
    if (ev.side === "BUY") {
      queue.push({ buy_date: ev.deal_date, buy_price: price, qty_remaining: qty });
      continue;
    }
    let remaining = qty;
    while (remaining > 0 && queue.length > 0) {
      const lot = queue[0];
      const matched = Math.min(lot.qty_remaining, remaining);
      const holdingDays = (new Date(ev.deal_date).getTime() - new Date(lot.buy_date).getTime()) / 86_400_000;
      realized.push({
        symbol: ev.symbol,
        client_name: ev.client_name,
        buy_date: lot.buy_date,
        buy_price: lot.buy_price,
        sell_date: ev.deal_date,
        sell_price: price,
        qty: matched,
        return_pct: (price / lot.buy_price - 1) * 100,
        holding_days: holdingDays,
      });
      lot.qty_remaining -= matched;
      remaining -= matched;
      if (lot.qty_remaining === 0) queue.shift();
    }
    if (remaining > 0) {
      unmatchedSellQty += remaining;
      unmatchedSellEvents++;
    }
  }

  return { realized, unmatchedSellQty, unmatchedSellEvents, openLots: queue };
}

function firmStatsFor(client_name: string, trades: RealizedTrade[]): FirmStats {
  const qty = trades.reduce((a, t) => a + t.qty, 0);
  const rs = trades.map((t) => t.return_pct);
  return {
    client_name,
    n: trades.length,
    total_qty: qty,
    qty_weighted_return_pct: trades.reduce((a, t) => a + t.return_pct * t.qty, 0) / qty,
    win_rate_pct: (rs.filter((r) => r > 0).length / rs.length) * 100,
    median_return_pct: median(rs),
    median_holding_days: median(trades.map((t) => t.holding_days)),
  };
}

const DEFAULT_OPEN_LOTS_PAGE_SIZE = 25;

export function computeBulkDealFifoAnalysis(
  db: Database.Database,
  opts: {
    hftHoldingDaysThreshold?: number;
    minTradesForFirmLeaderboard?: number;
    openLotsPage?: number;
    openLotsPageSize?: number;
  } = {},
): BulkDealFifoResult {
  const hftThreshold = opts.hftHoldingDaysThreshold ?? DEFAULT_HFT_HOLDING_DAYS_THRESHOLD;
  const minTradesForLeaderboard = opts.minTradesForFirmLeaderboard ?? DEFAULT_MIN_TRADES_FOR_FIRM_LEADERBOARD;
  const openLotsPageSize = opts.openLotsPageSize ?? DEFAULT_OPEN_LOTS_PAGE_SIZE;
  const openLotsPage = Math.max(1, opts.openLotsPage ?? 1);

  const deals = db
    .prepare(
      `SELECT deal_date, symbol, client_name, side, quantity, price FROM bulk_deals
       WHERE is_institution = 1 AND quantity IS NOT NULL AND quantity > 0 AND price IS NOT NULL AND price > 0
       ORDER BY symbol, client_name, deal_date ASC`,
    )
    .all() as Deal[];

  const totalBuyRows = deals.filter((d) => d.side === "BUY").length;

  const freshness = db
    .prepare("SELECT MAX(deal_date) AS data_through, MAX(fetched_at) AS last_fetched_at FROM bulk_deals")
    .get() as { data_through: string | null; last_fetched_at: string | null };

  const byKey = new Map<string, Deal[]>();
  for (const d of deals) {
    const key = `${d.symbol}::${d.client_name}`;
    const arr = byKey.get(key);
    if (arr) arr.push(d);
    else byKey.set(key, [d]);
  }

  const realizedAll: RealizedTrade[] = [];
  const openLotsAll: OpenLotWithClient[] = [];
  let unmatchedSellQty = 0;
  let unmatchedSellEvents = 0;
  let openLotsCount = 0;
  let openLotsQty = 0;

  for (const [, events] of byKey) {
    const { realized, unmatchedSellQty: u, unmatchedSellEvents: ue, openLots } = fifoMatchGroup(events);
    realizedAll.push(...realized);
    unmatchedSellQty += u;
    unmatchedSellEvents += ue;
    const groupSymbol = events[0].symbol;
    const groupClient = events[0].client_name;
    for (const lot of openLots) {
      openLotsCount++;
      openLotsQty += lot.qty_remaining;
      openLotsAll.push({ client_name: groupClient, symbol: groupSymbol, buy_date: lot.buy_date, buy_price: lot.buy_price, qty: lot.qty_remaining });
    }
  }

  // Classify each CLIENT by their overall median holding period across every
  // realized trade — not per-trade — then drop HFT-classified firms wholesale.
  const byFirmAll = new Map<string, RealizedTrade[]>();
  for (const t of realizedAll) {
    const arr = byFirmAll.get(t.client_name);
    if (arr) arr.push(t);
    else byFirmAll.set(t.client_name, [t]);
  }
  const hftFirms = new Set<string>();
  for (const [client_name, trades] of byFirmAll) {
    const medHold = median(trades.map((t) => t.holding_days));
    if (medHold <= hftThreshold) hftFirms.add(client_name);
  }

  const realized = realizedAll.filter((t) => !hftFirms.has(t.client_name));
  const hftRealizedExcluded = realizedAll.length - realized.length;

  const nonHftOpenLotsSorted = openLotsAll
    .filter((l) => !hftFirms.has(l.client_name))
    .sort((a, b) => (a.buy_date < b.buy_date ? 1 : a.buy_date > b.buy_date ? -1 : 0));
  const openLotsPageStart = (openLotsPage - 1) * openLotsPageSize;
  const nonHftOpenLotsPage = nonHftOpenLotsSorted.slice(openLotsPageStart, openLotsPageStart + openLotsPageSize);

  const caveats = [
    `A client is classified HFT/market-maker-like (and fully excluded) when its median holding period across ALL its realized bulk-deal trades is <= ${hftThreshold} day(s) — a firm-level pattern, not a per-trade one.`,
    "A sell with no prior disclosed bulk-deal buy lot for that client+symbol is excluded from realized P&L, not fabricated.",
    "A buy still open (never disclosed-sold) at the end of the dataset is unrealized and reported separately, not counted in realized stats.",
    "No corporate-action (split/bonus) adjustment — a buy/sell pair spanning one would show a distorted return.",
    "is_institution is a keyword heuristic on client_name, not a verified legal classification.",
  ];

  if (realized.length === 0) {
    return {
      hft_holding_days_threshold: hftThreshold,
      data_through: freshness.data_through,
      last_fetched_at: freshness.last_fetched_at,
      total_institutional_buy_rows: totalBuyRows,
      realized_trade_count_all_firms: realizedAll.length,
      hft_firms_excluded_count: hftFirms.size,
      hft_realized_trades_excluded_count: hftRealizedExcluded,
      non_hft_realized_trade_count: 0,
      unmatched_sell_events: unmatchedSellEvents,
      unmatched_sell_qty: unmatchedSellQty,
      open_lots_count: openLotsCount,
      open_lots_qty: openLotsQty,
      non_hft_open_lots_total: nonHftOpenLotsSorted.length,
      non_hft_open_lots_page: openLotsPage,
      non_hft_open_lots_page_size: openLotsPageSize,
      non_hft_open_lots: nonHftOpenLotsPage,
      overall: null,
      holding_buckets: [],
      top_active_firms: [],
      best_firms: [],
      worst_firms: [],
      caveats,
    };
  }

  const returns = realized.map((t) => t.return_pct);
  const totalQty = realized.reduce((a, t) => a + t.qty, 0);
  const holdingDaysArr = realized.map((t) => t.holding_days);

  const overall = {
    mean_return_pct: returns.reduce((a, b) => a + b, 0) / returns.length,
    median_return_pct: median(returns),
    qty_weighted_return_pct: realized.reduce((a, t) => a + t.return_pct * t.qty, 0) / totalQty,
    win_rate_pct: (returns.filter((r) => r > 0).length / returns.length) * 100,
    median_holding_days: median(holdingDaysArr),
    mean_holding_days: holdingDaysArr.reduce((a, b) => a + b, 0) / holdingDaysArr.length,
  };

  const holdingBuckets: HoldingBucketStats[] = [];
  for (const [label, group] of [
    ["<=5 day holds", realized.filter((t) => t.holding_days <= 5)],
    [">5 day holds", realized.filter((t) => t.holding_days > 5)],
  ] as [string, RealizedTrade[]][]) {
    if (group.length === 0) continue;
    const rs = group.map((t) => t.return_pct);
    holdingBuckets.push({
      label,
      n: group.length,
      mean_return_pct: rs.reduce((a, b) => a + b, 0) / rs.length,
      median_return_pct: median(rs),
      win_rate_pct: (rs.filter((r) => r > 0).length / rs.length) * 100,
    });
  }

  const byFirm = new Map<string, RealizedTrade[]>();
  for (const t of realized) {
    const arr = byFirm.get(t.client_name);
    if (arr) arr.push(t);
    else byFirm.set(t.client_name, [t]);
  }
  const firmStats = [...byFirm.entries()].map(([name, trades]) => firmStatsFor(name, trades));
  const eligible = firmStats.filter((f) => f.n >= minTradesForLeaderboard);

  return {
    hft_holding_days_threshold: hftThreshold,
    data_through: freshness.data_through,
    last_fetched_at: freshness.last_fetched_at,
    total_institutional_buy_rows: totalBuyRows,
    realized_trade_count_all_firms: realizedAll.length,
    hft_firms_excluded_count: hftFirms.size,
    hft_realized_trades_excluded_count: hftRealizedExcluded,
    non_hft_realized_trade_count: realized.length,
    unmatched_sell_events: unmatchedSellEvents,
    unmatched_sell_qty: unmatchedSellQty,
    open_lots_count: openLotsCount,
    open_lots_qty: openLotsQty,
    non_hft_open_lots_total: nonHftOpenLotsSorted.length,
    non_hft_open_lots_page: openLotsPage,
    non_hft_open_lots_page_size: openLotsPageSize,
    non_hft_open_lots: nonHftOpenLotsPage,
    overall,
    holding_buckets: holdingBuckets,
    top_active_firms: [...firmStats].sort((a, b) => b.n - a.n).slice(0, 20),
    best_firms: [...eligible].sort((a, b) => b.qty_weighted_return_pct - a.qty_weighted_return_pct).slice(0, 15),
    worst_firms: [...eligible].sort((a, b) => a.qty_weighted_return_pct - b.qty_weighted_return_pct).slice(0, 15),
    caveats,
  };
}

export interface ClientDetail {
  client_name: string;
  is_hft: boolean;
  hft_holding_days_threshold: number;
  realized_trades: RealizedTrade[]; // most recent sell first
  open_lots: OpenLot[];
  summary: FirmStats | null;
}

/**
 * Every realized trade and open lot for ONE client, across all symbols —
 * the drill-down behind clicking a client name in the strategy page's firm
 * tables. Re-runs FIFO matching scoped to just this client's own deals
 * (cheap — one client's row count is tiny next to the whole table), so it
 * stays consistent with computeBulkDealFifoAnalysis without recomputing the
 * whole dataset. `is_hft` reflects the same firm-level classification used
 * there, in case this is reached for a client outside the non-HFT leaderboards.
 */
export function getClientTrades(
  db: Database.Database,
  clientName: string,
  opts: { hftHoldingDaysThreshold?: number } = {},
): ClientDetail {
  const hftThreshold = opts.hftHoldingDaysThreshold ?? DEFAULT_HFT_HOLDING_DAYS_THRESHOLD;

  const deals = db
    .prepare(
      `SELECT deal_date, symbol, client_name, side, quantity, price FROM bulk_deals
       WHERE is_institution = 1 AND client_name = ? AND quantity IS NOT NULL AND quantity > 0 AND price IS NOT NULL AND price > 0
       ORDER BY symbol, deal_date ASC`,
    )
    .all(clientName) as Deal[];

  const bySymbol = new Map<string, Deal[]>();
  for (const d of deals) {
    const arr = bySymbol.get(d.symbol);
    if (arr) arr.push(d);
    else bySymbol.set(d.symbol, [d]);
  }

  const realized: RealizedTrade[] = [];
  const openLots: OpenLot[] = [];
  for (const [symbol, events] of bySymbol) {
    const { realized: r, openLots: lots } = fifoMatchGroup(events);
    realized.push(...r);
    for (const lot of lots) openLots.push({ symbol, buy_date: lot.buy_date, buy_price: lot.buy_price, qty: lot.qty_remaining });
  }

  const medHold = realized.length > 0 ? median(realized.map((t) => t.holding_days)) : null;

  return {
    client_name: clientName,
    is_hft: medHold !== null && medHold <= hftThreshold,
    hft_holding_days_threshold: hftThreshold,
    realized_trades: [...realized].sort((a, b) => (a.sell_date < b.sell_date ? 1 : a.sell_date > b.sell_date ? -1 : 0)),
    open_lots: openLots.sort((a, b) => (a.buy_date < b.buy_date ? 1 : a.buy_date > b.buy_date ? -1 : 0)),
    summary: realized.length > 0 ? firmStatsFor(clientName, realized) : null,
  };
}

