import type Database from "better-sqlite3";

/**
 * Paper trading library. Manages the simulated portfolio:
 *   - Position sizing (1% risk per trade, cap concurrent + capital-per-position)
 *   - Opening trades from scanner-emitted signals
 *   - Advancing open trades on each cron fire (stop hits, target hits, breakeven-move, trail, time exit)
 *   - Manual close from the UI
 *   - Daily equity-curve snapshot for the /paper page
 *
 * The recipe mirrors lib/positions.ts's exit rules exactly. What's new here is:
 *   - Money accounting: cash is deducted on open, restored (with realized P&L) on close
 *   - Position size in whole shares, computed from account equity + risk %
 *   - Concurrent-position + max-capital-per-position caps enforced at open time
 */

const DEFAULT_USER_ID = "local";
const TIME_EXIT_BARS = 60;
const BREAKEVEN_R_MULTIPLE = 1;
const TRAIL_R_MULTIPLE = 2;

// Rotation defaults. When the concurrent cap is hit, an incoming signal can
// evict the weakest-momentum eligible open position via a merged-ranking pass
// (qlib's TopkDropoutStrategy pattern). Guardrails still protect fresh trades
// and any position that has locked in a breakeven stop.
const ROTATION_MIN_BARS_HELD = 5;       // incumbents younger than 5 bars are protected

// ---------- Types ----------

export interface PaperAccountRow {
  user_id: string;
  starting_cash_paise: number;
  current_cash_paise: number;
  equity_paise: number;
  risk_pct_per_trade: number;
  max_concurrent_trades: number;
  max_position_pct: number;
  created_at: string;
  last_updated_at: string;
}

export interface PaperTradeRow {
  id: number;
  user_id: string;
  symbol: string;
  exchange: string;
  entry_signal_scan_date: string | null;
  entry_date: string;
  entry_time: string;
  entry_paise: number;
  qty: number;
  capital_committed_paise: number;
  initial_stop_paise: number;
  current_stop_paise: number;
  target_paise: number;
  atr14_paise: number | null;
  status: "open" | "target_hit" | "stopped" | "time_exit" | "manual_closed";
  exit_date: string | null;
  exit_time: string | null;
  exit_paise: number | null;
  exit_reason: string | null;
  realized_pnl_paise: number | null;
  bars_held: number;
}

export interface OpenTradeWithMark extends PaperTradeRow {
  latest_close_paise: number | null;
  unrealized_pnl_paise: number | null;
  unrealized_pct: number | null;
  moved_to_breakeven: boolean;
}

// ---------- Helpers ----------

function nowIso(): string {
  return new Date().toISOString();
}

function istDate(now = Date.now()): string {
  return new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);
}

function tokenForSymbol(db: Database.Database, symbol: string, exchange: string): number | null {
  const r = db
    .prepare(
      `SELECT instrument_token FROM index_universe WHERE symbol=? AND exchange=? LIMIT 1`,
    )
    .get(symbol, exchange) as { instrument_token: number } | undefined;
  return r?.instrument_token ?? null;
}

function latestClosePaise(db: Database.Database, instrumentToken: number): number | null {
  // Prefer today's intraday if present; else the freshest EOD bar.
  const istToday = istDate();
  const intra = db
    .prepare(`SELECT ltp FROM ohlc_intraday WHERE instrument_token=? AND quote_date=? LIMIT 1`)
    .get(instrumentToken, istToday) as { ltp: number } | undefined;
  if (intra) return intra.ltp;
  const eod = db
    .prepare(`SELECT close FROM ohlc_daily WHERE instrument_token=? ORDER BY trade_date DESC LIMIT 1`)
    .get(instrumentToken) as { close: number } | undefined;
  return eod?.close ?? null;
}

// ---------- Account init & read ----------

export function ensureAccount(
  db: Database.Database,
  userId = DEFAULT_USER_ID,
  startingCashPaise = 30000000, // ₹3,00,000 default
): PaperAccountRow {
  const existing = db
    .prepare(`SELECT * FROM paper_account WHERE user_id=?`)
    .get(userId) as PaperAccountRow | undefined;
  if (existing) return existing;
  const now = nowIso();
  db.prepare(
    `INSERT INTO paper_account(user_id, starting_cash_paise, current_cash_paise, equity_paise,
                                risk_pct_per_trade, max_concurrent_trades, max_position_pct,
                                created_at, last_updated_at)
     VALUES(?, ?, ?, ?, 1.0, 5, 25.0, ?, ?)`,
  ).run(userId, startingCashPaise, startingCashPaise, startingCashPaise, now, now);
  return db.prepare(`SELECT * FROM paper_account WHERE user_id=?`).get(userId) as PaperAccountRow;
}

export function getAccount(db: Database.Database, userId = DEFAULT_USER_ID): PaperAccountRow | null {
  return (db.prepare(`SELECT * FROM paper_account WHERE user_id=?`).get(userId) as PaperAccountRow | undefined) ?? null;
}

// ---------- Position sizing ----------

export interface SizingInputs {
  equity_paise: number;
  entry_paise: number;
  stop_paise: number;
  risk_pct: number; // e.g. 1.0 for 1%
  max_position_pct: number; // e.g. 25.0
}

export interface SizingResult {
  qty: number;
  capital_committed_paise: number;
  risk_paise: number;
  reason?: string; // set when qty=0
}

/**
 * Compute whole-share position size. Bounded by:
 *   - Risk cap: qty ≤ floor((risk_pct% × equity) / (entry − stop))
 *   - Capital cap: qty ≤ floor(max_position_pct% × equity / entry)
 * Returns qty=0 with a reason when either cap yields <1 share.
 */
export function computeQty(input: SizingInputs): SizingResult {
  const perShareRisk = input.entry_paise - input.stop_paise;
  if (perShareRisk <= 0) {
    return { qty: 0, capital_committed_paise: 0, risk_paise: 0, reason: "stop_not_below_entry" };
  }
  const riskBudget = Math.floor((input.risk_pct / 100) * input.equity_paise);
  const qtyByRisk = Math.floor(riskBudget / perShareRisk);
  const capitalBudget = Math.floor((input.max_position_pct / 100) * input.equity_paise);
  const qtyByCapital = Math.floor(capitalBudget / input.entry_paise);
  const qty = Math.min(qtyByRisk, qtyByCapital);
  if (qty <= 0) {
    return {
      qty: 0,
      capital_committed_paise: 0,
      risk_paise: 0,
      reason: qtyByRisk <= 0 ? "risk_budget_too_small" : "capital_cap_below_one_share",
    };
  }
  return {
    qty,
    capital_committed_paise: qty * input.entry_paise,
    risk_paise: qty * perShareRisk,
  };
}

// ---------- Open a new paper trade from a scanner signal ----------

export interface OpenTradeInput {
  user_id?: string;
  symbol: string;
  exchange: string;
  entry_signal_scan_date: string | null;
  scan_date: string; // IST YYYY-MM-DD
  scan_time: string; // ISO UTC
  entry_paise: number;
  stop_paise: number;
  target_paise: number;
  atr14_paise: number | null;
  // Momentum score for the incoming signal. Required for rotation to trigger;
  // if omitted, rotation is disabled for this call and the concurrent cap
  // becomes a hard reject as before.
  mom_score?: number | null;
  // Current momentum scores of open paper positions, keyed by symbol. Only
  // symbols in this map are considered for eviction; anything missing is
  // treated as "unknown momentum" and left alone.
  open_mom_scores?: Map<string, number>;
}

export interface RotationEvent {
  out_trade_id: number;
  out_symbol: string;
  out_mom_score: number;
  in_symbol: string;
  in_mom_score: number;
  mom_ratio: number;
  exit_price_paise: number;
  realized_pnl_paise: number;
}

export interface OpenTradeResult {
  opened: boolean;
  trade_id?: number;
  qty?: number;
  capital_committed_paise?: number;
  reason?: string;
  rotation?: RotationEvent;
}

export function openPaperTrade(db: Database.Database, s: OpenTradeInput): OpenTradeResult {
  const userId = s.user_id ?? DEFAULT_USER_ID;
  const account = ensureAccount(db, userId);

  // Skip if already open for this stock (any status='open' matching symbol/exchange).
  const existingOpen = db
    .prepare(
      `SELECT id FROM paper_trades WHERE user_id=? AND symbol=? AND exchange=? AND status='open'`,
    )
    .get(userId, s.symbol, s.exchange) as { id: number } | undefined;
  if (existingOpen) return { opened: false, reason: "already_open" };

  // Concurrent-cap check — with rotation escape hatch.
  const openCount = (db
    .prepare(`SELECT COUNT(*) AS n FROM paper_trades WHERE user_id=? AND status='open'`)
    .get(userId) as { n: number }).n;
  let rotation: RotationEvent | undefined;
  if (openCount >= account.max_concurrent_trades) {
    rotation = maybeRotateOut(db, userId, s);
    if (!rotation) {
      return { opened: false, reason: `concurrent_cap (${openCount}/${account.max_concurrent_trades})` };
    }
  }

  // After a rotation, cash has been restored — re-read the account so sizing
  // sees the updated cash figure. Equity is unchanged (position value replaced
  // 1:1 by cash) so a fresh recompute isn't required here.
  const acc = rotation ? (getAccount(db, userId) ?? account) : account;

  // Compute size against current equity (not just cash — matches how real portfolio sizing works)
  const size = computeQty({
    equity_paise: acc.equity_paise,
    entry_paise: s.entry_paise,
    stop_paise: s.stop_paise,
    risk_pct: acc.risk_pct_per_trade,
    max_position_pct: acc.max_position_pct,
  });
  if (size.qty <= 0) return { opened: false, reason: size.reason ?? "qty_zero" };

  // Cash-availability check — even if equity allows the size, cash might not
  if (size.capital_committed_paise > acc.current_cash_paise) {
    return { opened: false, reason: `insufficient_cash (${(acc.current_cash_paise/100).toFixed(0)} < ${(size.capital_committed_paise/100).toFixed(0)})` };
  }

  const insert = db.prepare(
    `INSERT INTO paper_trades(user_id, symbol, exchange, entry_signal_scan_date,
                              entry_date, entry_time, entry_paise, qty, capital_committed_paise,
                              initial_stop_paise, current_stop_paise, target_paise, atr14_paise,
                              status, bars_held)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 0)`,
  );
  const info = insert.run(
    userId, s.symbol, s.exchange, s.entry_signal_scan_date,
    s.scan_date, s.scan_time, s.entry_paise, size.qty, size.capital_committed_paise,
    s.stop_paise, s.stop_paise, s.target_paise, s.atr14_paise,
  );

  // Deduct from cash. Equity stays constant (we replaced cash with an equal-value position at entry).
  db.prepare(
    `UPDATE paper_account SET current_cash_paise = current_cash_paise - ?, last_updated_at = ? WHERE user_id = ?`,
  ).run(size.capital_committed_paise, nowIso(), userId);

  return {
    opened: true,
    trade_id: info.lastInsertRowid as number,
    qty: size.qty,
    capital_committed_paise: size.capital_committed_paise,
    rotation,
  };
}

/**
 * When the concurrent cap is hit, decide whether the incoming signal should
 * displace an existing position using qlib's TopkDropoutStrategy pattern:
 * merge eligible incumbents + the candidate, rank DESC by mom_score, keep the
 * top-N (N = eligible count). If the candidate lands in the top-N while an
 * incumbent is dropped, evict that incumbent (always the weakest eligible one
 * by construction). Guardrails:
 *   - Incumbent must have bars_held ≥ ROTATION_MIN_BARS_HELD (grace period)
 *   - Incumbent must NOT have moved to breakeven (protect working trades)
 *   - Incumbent must have a known mom_score in open_mom_scores
 * Returns the RotationEvent (with the eviction already committed to DB and
 * cash restored) so the caller can proceed with the open. Returns undefined
 * when no eligible incumbent exists or the candidate doesn't outrank any.
 */
function maybeRotateOut(
  db: Database.Database,
  userId: string,
  s: OpenTradeInput,
): RotationEvent | undefined {
  if (s.mom_score === undefined || s.mom_score === null || !Number.isFinite(s.mom_score)) return undefined;
  if (!s.open_mom_scores || s.open_mom_scores.size === 0) return undefined;

  const open = db
    .prepare(
      `SELECT id, symbol, exchange, entry_paise, initial_stop_paise, current_stop_paise, qty, bars_held
       FROM paper_trades WHERE user_id=? AND status='open'`,
    )
    .all(userId) as {
    id: number; symbol: string; exchange: string; entry_paise: number;
    initial_stop_paise: number; current_stop_paise: number; qty: number; bars_held: number;
  }[];

  // Build the eligible set. Exclude any incumbent whose mom_score is unknown,
  // at breakeven, or still inside the bar-held grace period.
  type Eligible = { row: typeof open[number]; mom: number };
  const eligible: Eligible[] = [];
  for (const r of open) {
    if (r.bars_held < ROTATION_MIN_BARS_HELD) continue;
    if (r.current_stop_paise >= r.entry_paise) continue;
    const mom = s.open_mom_scores.get(r.symbol);
    if (mom === undefined || !Number.isFinite(mom)) continue;
    eligible.push({ row: r, mom });
  }
  if (eligible.length === 0) return undefined;

  const inMom = s.mom_score;

  // Merged-ranking eviction (qlib TopkDropoutStrategy):
  //   merged = eligible incumbents ∪ { candidate }, sort DESC by mom_score,
  //   keep top-N where N = eligible.length. If the candidate is in the top-N
  //   AND at least one incumbent is displaced, the displaced incumbent is by
  //   construction the weakest eligible one.
  const N = eligible.length;
  type Merged = { isCandidate: boolean; mom: number; el?: Eligible };
  const merged: Merged[] = eligible.map((e) => ({ isCandidate: false, mom: e.mom, el: e }));
  merged.push({ isCandidate: true, mom: inMom });
  // Sort DESC by mom_score. Ties: keep candidate BELOW incumbents (stable
  // preference for the status quo — if the candidate merely ties the weakest,
  // no rotation).
  merged.sort((a, b) => {
    if (b.mom !== a.mom) return b.mom - a.mom;
    // Candidate loses ties: incumbent (isCandidate=false) sorts first.
    return Number(a.isCandidate) - Number(b.isCandidate);
  });
  const topN = merged.slice(0, N);
  const candidateInTop = topN.some((m) => m.isCandidate);
  if (!candidateInTop) return undefined;
  // Whichever eligible incumbent fell out of the top-N is the eviction target.
  // Since the candidate consumed one slot and the sort is DESC, that must be
  // the weakest eligible incumbent.
  eligible.sort((a, b) => a.mom - b.mom);
  const worst = eligible[0];
  const worstMom = worst.mom;

  // Close the incumbent at LTP (fallback to entry when no bar is available).
  const token = tokenForSymbol(db, worst.row.symbol, worst.row.exchange);
  const ltp = token !== null ? latestClosePaise(db, token) : null;
  const exitPrice = ltp ?? worst.row.entry_paise;
  const realized = (exitPrice - worst.row.entry_paise) * worst.row.qty;
  const proceeds = exitPrice * worst.row.qty;
  const now = nowIso();
  // mom_ratio is informational only under the new logic. Preserve the old
  // shape: ratio when worst > 0, else signed delta.
  const ratio = worstMom > 0 ? inMom / worstMom : inMom - worstMom;
  const reason = `rotated_out for ${s.symbol} (mom ${inMom.toFixed(3)} vs ${worstMom.toFixed(3)}, ratio ${worstMom > 0 ? ratio.toFixed(2) + "x" : "+" + ratio.toFixed(3)})`;
  db.prepare(
    `UPDATE paper_trades SET status='rotated_out', exit_date=date('now','+5 hours','+30 minutes'),
                             exit_time=?, exit_paise=?, exit_reason=?, realized_pnl_paise=?, bars_held=bars_held
     WHERE id=?`,
  ).run(now, exitPrice, reason, realized, worst.row.id);
  db.prepare(
    `UPDATE paper_account SET current_cash_paise = current_cash_paise + ?, last_updated_at=?
     WHERE user_id=?`,
  ).run(proceeds, now, userId);

  return {
    out_trade_id: worst.row.id,
    out_symbol: worst.row.symbol,
    out_mom_score: worstMom,
    in_symbol: s.symbol,
    in_mom_score: inMom,
    mom_ratio: ratio,
    exit_price_paise: exitPrice,
    realized_pnl_paise: realized,
  };
}

// ---------- Advance every open trade against latest bars ----------

interface Bar { trade_date: string; low: number; high: number; close: number; }

function loadBarsSince(db: Database.Database, token: number, fromDate: string): Bar[] {
  return db
    .prepare(
      `SELECT trade_date, low, high, close FROM ohlc_daily
       WHERE instrument_token=? AND trade_date >= ? ORDER BY trade_date ASC`,
    )
    .all(token, fromDate) as Bar[];
}

function donchianLow20(bars: Bar[]): number | null {
  if (bars.length < 20) return null;
  let lo = Infinity;
  for (let i = bars.length - 20; i < bars.length; i++) if (bars[i].low < lo) lo = bars[i].low;
  return Number.isFinite(lo) ? lo : null;
}

export interface UpdateResult {
  updated: number;
  stopped: number;
  target_hit: number;
  time_exit: number;
  breakeven_moved: number;
}

export function updateOpenPaperTrades(db: Database.Database, userId = DEFAULT_USER_ID): UpdateResult {
  const result: UpdateResult = { updated: 0, stopped: 0, target_hit: 0, time_exit: 0, breakeven_moved: 0 };
  const rows = db
    .prepare(`SELECT * FROM paper_trades WHERE user_id=? AND status='open'`)
    .all(userId) as PaperTradeRow[];
  if (rows.length === 0) return result;

  const updateStop = db.prepare(
    `UPDATE paper_trades SET current_stop_paise=?, bars_held=? WHERE id=?`,
  );
  const closeTrade = db.prepare(
    `UPDATE paper_trades SET status=?, exit_date=?, exit_time=?, exit_paise=?, exit_reason=?,
                              realized_pnl_paise=?, bars_held=?
     WHERE id=?`,
  );
  const restoreCash = db.prepare(
    `UPDATE paper_account SET current_cash_paise = current_cash_paise + ?, last_updated_at = ?
     WHERE user_id = ?`,
  );

  const tx = db.transaction(() => {
    for (const p of rows) {
      const token = tokenForSymbol(db, p.symbol, p.exchange);
      if (token === null) continue;

      const bars = loadBarsSince(db, token, p.entry_date);
      const barsAfter = bars.filter((b) => b.trade_date > p.entry_date);
      const barsHeld = barsAfter.length;

      let closed = false;
      let currentStop = p.current_stop_paise;
      let breakevenMoved = false;
      const risk = p.entry_paise - p.initial_stop_paise;
      const oneR = p.entry_paise + BREAKEVEN_R_MULTIPLE * risk;
      const twoR = p.entry_paise + TRAIL_R_MULTIPLE * risk;

      for (const b of barsAfter) {
        // Stop first (conservative in a gap-down)
        if (b.low <= currentStop) {
          const exitPrice = currentStop;
          const realized = (exitPrice - p.entry_paise) * p.qty;
          const proceeds = exitPrice * p.qty; // return the position value to cash
          closeTrade.run(
            "stopped", b.trade_date, nowIso(), exitPrice,
            `low ${b.low} pierced stop ${currentStop} on ${b.trade_date}`,
            realized, barsHeld, p.id,
          );
          restoreCash.run(proceeds, nowIso(), userId);
          result.stopped++;
          closed = true;
          break;
        }
        if (b.high >= p.target_paise) {
          const exitPrice = p.target_paise;
          const realized = (exitPrice - p.entry_paise) * p.qty;
          const proceeds = exitPrice * p.qty;
          closeTrade.run(
            "target_hit", b.trade_date, nowIso(), exitPrice,
            `high ${b.high} reached target ${p.target_paise} on ${b.trade_date}`,
            realized, barsHeld, p.id,
          );
          restoreCash.run(proceeds, nowIso(), userId);
          result.target_hit++;
          closed = true;
          break;
        }
        // Breakeven-move at +1R
        if (b.close >= oneR && currentStop < p.entry_paise) {
          currentStop = p.entry_paise;
          breakevenMoved = true;
        }
        // Trail at +2R via 20-day low
        if (b.close >= twoR) {
          const upTo = bars.filter((x) => x.trade_date <= b.trade_date);
          const trail = donchianLow20(upTo);
          if (trail !== null && trail > currentStop) currentStop = trail;
        }
      }

      if (!closed) {
        if (barsHeld >= TIME_EXIT_BARS) {
          const last = barsAfter[barsAfter.length - 1];
          const exitPrice = last?.close ?? p.entry_paise;
          const exitDate = last?.trade_date ?? p.entry_date;
          const realized = (exitPrice - p.entry_paise) * p.qty;
          const proceeds = exitPrice * p.qty;
          closeTrade.run(
            "time_exit", exitDate, nowIso(), exitPrice,
            `${TIME_EXIT_BARS} trading days elapsed`,
            realized, barsHeld, p.id,
          );
          restoreCash.run(proceeds, nowIso(), userId);
          result.time_exit++;
          continue;
        }
        if (currentStop !== p.current_stop_paise || barsHeld !== p.bars_held) {
          updateStop.run(currentStop, barsHeld, p.id);
          result.updated++;
          if (breakevenMoved) result.breakeven_moved++;
        }
      }
    }
  });
  tx();

  // Recompute equity = cash + Σ(LTP × qty over open trades). Update paper_account.
  recomputeEquity(db, userId);
  return result;
}

// ---------- Recompute account equity ----------

export function recomputeEquity(db: Database.Database, userId = DEFAULT_USER_ID): void {
  const acc = getAccount(db, userId);
  if (!acc) return;
  const openTrades = db
    .prepare(`SELECT symbol, exchange, qty FROM paper_trades WHERE user_id=? AND status='open'`)
    .all(userId) as { symbol: string; exchange: string; qty: number }[];
  let openValue = 0;
  for (const t of openTrades) {
    const token = tokenForSymbol(db, t.symbol, t.exchange);
    if (token === null) continue;
    const ltp = latestClosePaise(db, token);
    if (ltp === null) continue;
    openValue += ltp * t.qty;
  }
  const equity = acc.current_cash_paise + openValue;
  db.prepare(`UPDATE paper_account SET equity_paise=?, last_updated_at=? WHERE user_id=?`)
    .run(equity, nowIso(), userId);
}

// ---------- Fetch open trades with mark-to-market ----------

export function loadActivePaperTrades(db: Database.Database, userId = DEFAULT_USER_ID): OpenTradeWithMark[] {
  const rows = db
    .prepare(`SELECT * FROM paper_trades WHERE user_id=? AND status='open' ORDER BY entry_date ASC`)
    .all(userId) as PaperTradeRow[];
  return rows.map((r) => {
    const token = tokenForSymbol(db, r.symbol, r.exchange);
    const latest = token !== null ? latestClosePaise(db, token) : null;
    const unrealized = latest !== null ? (latest - r.entry_paise) * r.qty : null;
    const unrealPct = latest !== null ? ((latest - r.entry_paise) / r.entry_paise) * 100 : null;
    return {
      ...r,
      latest_close_paise: latest,
      unrealized_pnl_paise: unrealized,
      unrealized_pct: unrealPct,
      moved_to_breakeven: r.current_stop_paise >= r.entry_paise,
    };
  });
}

// ---------- Manual close ----------

export function closePaperTradeManual(
  db: Database.Database,
  tradeId: number,
  reason = "manual close via UI",
  userId = DEFAULT_USER_ID,
): { closed: boolean; realized_pnl_paise?: number; message?: string } {
  const t = db.prepare(`SELECT * FROM paper_trades WHERE id=? AND user_id=? AND status='open'`)
    .get(tradeId, userId) as PaperTradeRow | undefined;
  if (!t) return { closed: false, message: "trade not found or already closed" };
  const token = tokenForSymbol(db, t.symbol, t.exchange);
  const exitPrice = token !== null ? (latestClosePaise(db, token) ?? t.entry_paise) : t.entry_paise;
  const realized = (exitPrice - t.entry_paise) * t.qty;
  const proceeds = exitPrice * t.qty;
  const now = nowIso();
  db.prepare(
    `UPDATE paper_trades SET status='manual_closed', exit_date=date('now','+5 hours','+30 minutes'),
                             exit_time=?, exit_paise=?, exit_reason=?, realized_pnl_paise=?
     WHERE id=?`,
  ).run(now, exitPrice, reason, realized, tradeId);
  db.prepare(
    `UPDATE paper_account SET current_cash_paise = current_cash_paise + ?, last_updated_at=?
     WHERE user_id=?`,
  ).run(proceeds, now, userId);
  recomputeEquity(db, userId);
  return { closed: true, realized_pnl_paise: realized };
}

// ---------- Daily equity snapshot ----------

export function snapshotAccountHistory(db: Database.Database, userId = DEFAULT_USER_ID): void {
  const acc = getAccount(db, userId);
  if (!acc) return;
  const today = istDate();
  const trades = loadActivePaperTrades(db, userId);
  const winners = trades.filter((t) => (t.unrealized_pnl_paise ?? 0) > 0).length;
  const losers = trades.filter((t) => (t.unrealized_pnl_paise ?? 0) < 0).length;
  const unrealized = trades.reduce((s, t) => s + (t.unrealized_pnl_paise ?? 0), 0);
  const realized = (db.prepare(
    `SELECT COALESCE(SUM(realized_pnl_paise), 0) AS s FROM paper_trades
     WHERE user_id=? AND status != 'open'`,
  ).get(userId) as { s: number }).s;

  db.prepare(
    `INSERT INTO paper_account_history(user_id, snapshot_date, cash_paise, unrealized_pnl_paise,
                                        realized_pnl_paise, equity_paise, open_position_count,
                                        winners, losers)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, snapshot_date) DO UPDATE SET
       cash_paise=excluded.cash_paise,
       unrealized_pnl_paise=excluded.unrealized_pnl_paise,
       realized_pnl_paise=excluded.realized_pnl_paise,
       equity_paise=excluded.equity_paise,
       open_position_count=excluded.open_position_count,
       winners=excluded.winners,
       losers=excluded.losers`,
  ).run(
    userId, today, acc.current_cash_paise, unrealized, realized, acc.equity_paise,
    trades.length, winners, losers,
  );
}

// ---------- Summary metrics for UI ----------

export interface PaperSummary {
  starting_cash_paise: number;
  current_cash_paise: number;
  equity_paise: number;
  total_return_pct: number;
  realized_pnl_paise: number;
  unrealized_pnl_paise: number;
  open_count: number;
  closed_count: number;
  win_rate_pct: number | null;
  avg_r_multiple: number | null;
  best_trade_paise: number | null;
  worst_trade_paise: number | null;
  max_drawdown_pct: number | null;
}

export function summarize(db: Database.Database, userId = DEFAULT_USER_ID): PaperSummary | null {
  const acc = getAccount(db, userId);
  if (!acc) return null;
  const trades = loadActivePaperTrades(db, userId);
  const unrealized = trades.reduce((s, t) => s + (t.unrealized_pnl_paise ?? 0), 0);

  const closed = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(realized_pnl_paise),0) AS s,
            SUM(CASE WHEN realized_pnl_paise > 0 THEN 1 ELSE 0 END) AS wins,
            MIN(realized_pnl_paise) AS worst, MAX(realized_pnl_paise) AS best
     FROM paper_trades WHERE user_id=? AND status != 'open'`,
  ).get(userId) as { n: number; s: number; wins: number | null; worst: number | null; best: number | null };

  // Average R = mean of (realized / initial-risk-per-trade). Skip trades where risk was zero.
  const rows = db.prepare(
    `SELECT realized_pnl_paise, qty, entry_paise, initial_stop_paise
     FROM paper_trades WHERE user_id=? AND status != 'open' AND realized_pnl_paise IS NOT NULL`,
  ).all(userId) as { realized_pnl_paise: number; qty: number; entry_paise: number; initial_stop_paise: number }[];
  let sumR = 0, nR = 0;
  for (const r of rows) {
    const perShareRisk = r.entry_paise - r.initial_stop_paise;
    if (perShareRisk <= 0 || r.qty <= 0) continue;
    const totalRisk = perShareRisk * r.qty;
    sumR += r.realized_pnl_paise / totalRisk;
    nR++;
  }
  const avgR = nR > 0 ? sumR / nR : null;

  // Max drawdown: peak-to-trough on equity_paise from paper_account_history
  const hist = db.prepare(
    `SELECT equity_paise FROM paper_account_history WHERE user_id=? ORDER BY snapshot_date ASC`,
  ).all(userId) as { equity_paise: number }[];
  let peak = -Infinity, maxDd = 0;
  for (const h of hist) {
    if (h.equity_paise > peak) peak = h.equity_paise;
    if (peak > 0) {
      const dd = (peak - h.equity_paise) / peak * 100;
      if (dd > maxDd) maxDd = dd;
    }
  }

  return {
    starting_cash_paise: acc.starting_cash_paise,
    current_cash_paise: acc.current_cash_paise,
    equity_paise: acc.equity_paise,
    total_return_pct: acc.starting_cash_paise > 0
      ? ((acc.equity_paise - acc.starting_cash_paise) / acc.starting_cash_paise) * 100
      : 0,
    realized_pnl_paise: closed.s,
    unrealized_pnl_paise: unrealized,
    open_count: trades.length,
    closed_count: closed.n,
    win_rate_pct: closed.n > 0 ? ((closed.wins ?? 0) / closed.n) * 100 : null,
    avg_r_multiple: avgR,
    best_trade_paise: closed.best,
    worst_trade_paise: closed.worst,
    max_drawdown_pct: hist.length >= 2 ? maxDd : null,
  };
}
