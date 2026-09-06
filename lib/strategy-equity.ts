import "server-only";
import { getDb } from "./db/connection";
import { getAccount } from "./paper";

/**
 * Reconstructs a strategy-scoped daily portfolio-value series from
 * paper_trades — there is no per-strategy equity snapshot table (see the
 * shared-cash-pool note in lib/paper.ts's summarize()); paper_account_history
 * is whole-account only. Value(d) = account's starting capital (this
 * strategy's baseline, per lib/strategies.ts's computeCagrPct convention) +
 * cumulative realized P&L up to d + unrealized P&L of positions open on d,
 * marked at that day's close.
 *
 * Also produces a short "projection" — a naive continuation of the trailing
 * average daily growth rate. This is explicitly NOT a forecast; the UI must
 * label it as illustrative extrapolation, not a prediction (no forecasting
 * model exists anywhere in this codebase to do better).
 */

export interface EquityPoint {
  date: string;
  value_rupees: number;
}

export interface StrategyEquityHistory {
  history: EquityPoint[]; // actual, chronological
  projection: EquityPoint[]; // starts at the same value as history's last point
  starting_value_rupees: number;
  caveats: string[];
}

interface TradeRow {
  symbol: string;
  exchange: string;
  entry_date: string;
  qty: number;
  entry_paise: number;
  exit_date: string | null;
  realized_pnl_paise: number | null;
}

const PROJECTION_DAYS = 90;

export async function loadStrategyEquityHistory(
  strategyId: string,
  userId = "local",
): Promise<StrategyEquityHistory | null> {
  const db = getDb();
  const acc = getAccount(db, userId);
  if (!acc) return null;

  const trades = db
    .prepare(
      `SELECT symbol, exchange, entry_date, qty, entry_paise, exit_date, realized_pnl_paise
       FROM paper_trades WHERE user_id=? AND strategy=? ORDER BY entry_date ASC`,
    )
    .all(userId, strategyId) as TradeRow[];

  const startingValueRupees = acc.starting_cash_paise / 100;

  if (trades.length === 0) {
    return {
      history: [],
      projection: [],
      starting_value_rupees: startingValueRupees,
      caveats: ["No trades yet for this strategy — nothing to chart."],
    };
  }

  const firstEntryDate = trades[0].entry_date;

  // Trading calendar: every distinct date any OHLC bar exists for, from the
  // first entry onward. Using the whole table (not just this strategy's
  // symbols) avoids gaps on days where a traded symbol happened to be halted.
  const calendarRows = db
    .prepare(`SELECT DISTINCT trade_date FROM ohlc_daily WHERE trade_date >= ? ORDER BY trade_date ASC`)
    .all(firstEntryDate) as { trade_date: string }[];
  const calendar = calendarRows.map((r) => r.trade_date);
  // Always include today so the line reaches "now" even if today's bhavcopy
  // hasn't landed yet (matches the last trade's own idea of "today").
  const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  if (calendar.length === 0 || calendar[calendar.length - 1] < today) calendar.push(today);

  // Per-symbol close-price series (paise), keyed by date, for every symbol
  // this strategy has ever traded.
  const symbols = [...new Set(trades.map((t) => `${t.symbol}::${t.exchange}`))];
  const closesBySymbol = new Map<string, Map<string, number>>();
  for (const key of symbols) {
    const [symbol, exchange] = key.split("::");
    const tokenRow = db
      .prepare(`SELECT instrument_token FROM index_universe WHERE symbol=? AND exchange=? LIMIT 1`)
      .get(symbol, exchange) as { instrument_token: number } | undefined;
    if (!tokenRow) continue;
    const rows = db
      .prepare(`SELECT trade_date, close FROM ohlc_daily WHERE instrument_token=? ORDER BY trade_date ASC`)
      .all(tokenRow.instrument_token) as { trade_date: string; close: number }[];
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.trade_date, r.close);
    closesBySymbol.set(key, m);
  }

  // Forward-fill helper: last known close on or before `date` for a symbol.
  const lastKnownClose = (key: string, date: string): number | null => {
    const m = closesBySymbol.get(key);
    if (!m) return null;
    if (m.has(date)) return m.get(date)!;
    // Series are date-ordered on insert (Map preserves insertion order here
    // since rows were queried ASC), so scan backward from the end is cheap
    // for the common case (recent date); fall back to a full scan otherwise.
    let best: number | null = null;
    let bestDate = "";
    for (const [d, c] of m) {
      if (d <= date && d > bestDate) {
        best = c;
        bestDate = d;
      }
    }
    return best;
  };

  const history: EquityPoint[] = [];
  let missingPriceDays = 0;
  for (const d of calendar) {
    let cumulativeRealizedPaise = 0;
    let unrealizedPaise = 0;
    for (const t of trades) {
      if (t.entry_date > d) continue; // not yet opened
      const closed = t.exit_date !== null && t.exit_date <= d;
      if (closed) {
        cumulativeRealizedPaise += t.realized_pnl_paise ?? 0;
      } else {
        const key = `${t.symbol}::${t.exchange}`;
        const close = lastKnownClose(key, d);
        if (close === null) {
          missingPriceDays++;
          continue;
        }
        unrealizedPaise += (close - t.entry_paise) * t.qty;
      }
    }
    const valuePaise = acc.starting_cash_paise + cumulativeRealizedPaise + unrealizedPaise;
    history.push({ date: d, value_rupees: valuePaise / 100 });
  }

  // Naive projection: continue at the trailing average daily growth rate
  // implied by the reconstructed curve (first point -> last point), simple
  // compounding forward. This is an extrapolation, not a model — no
  // volatility, no mean reversion, no regime awareness. Explicitly labeled
  // as such in the UI and in caveats below.
  const projection: EquityPoint[] = [];
  if (history.length >= 2) {
    const first = history[0].value_rupees;
    const last = history[history.length - 1].value_rupees;
    const spanDays = Math.max(
      1,
      (new Date(history[history.length - 1].date).getTime() - new Date(history[0].date).getTime()) / 86_400_000,
    );
    const dailyRate = first > 0 && last > 0 ? Math.pow(last / first, 1 / spanDays) - 1 : 0;
    let cursor = last;
    const lastDate = new Date(history[history.length - 1].date);
    projection.push({ date: history[history.length - 1].date, value_rupees: cursor }); // connects the two lines
    for (let i = 1; i <= PROJECTION_DAYS; i++) {
      cursor = cursor * (1 + dailyRate);
      const d = new Date(lastDate.getTime() + i * 86_400_000);
      projection.push({ date: d.toISOString().slice(0, 10), value_rupees: cursor });
    }
  }

  const caveats = [
    "Value is reconstructed from this strategy's own trades against the account's starting capital — not a separately-funded account (see the shared-cash-pool note on the stat tiles above).",
    "The dashed projection is a naive continuation of the trailing average daily growth rate — not a forecast. It ignores volatility, drawdowns, and regime changes, and should not be used to estimate future returns.",
  ];
  if (missingPriceDays > 0) {
    caveats.push(
      `${missingPriceDays} day(s) had no available close price for an open position and were valued at that position's last known price instead.`,
    );
  }

  return {
    history,
    projection,
    starting_value_rupees: startingValueRupees,
    caveats,
  };
}
