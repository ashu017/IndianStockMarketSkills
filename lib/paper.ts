import type Database from "better-sqlite3";
import { computeDrawdown } from "./metrics";
import {
  CURRENT_EXIT_RULE,
  resolveExitRule,
  rungQty,
  type ExitRule,
  type ExitRuleId,
} from "./exit-rules";

/**
 * Paper trading library. Manages the simulated portfolio:
 *   - Position sizing (1% risk per trade, cap concurrent + capital-per-position)
 *   - Opening trades from scanner-emitted signals
 *   - Advancing open trades on each cron fire (stop hits, scale-out rungs,
 *     target hits, breakeven-move, trail, time exit)
 *   - Manual close from the UI
 *   - Daily equity-curve snapshot for the /paper page
 *
 * The recipe mirrors lib/positions.ts's exit rules exactly; both now resolve
 * those rules from lib/exit-rules.ts rather than each keeping private copies of
 * the constants. What's new here relative to that tracker is:
 *   - Money accounting: cash is deducted on open, restored (with realized P&L)
 *     on close — and now also partially restored when a scale-out rung fills
 *   - Position size in whole shares, computed from account equity + risk %
 *   - Concurrent-position + max-capital-per-position caps enforced at open time
 *
 * PARTIAL POSITIONS. Under v2_scaleout a trade sells half at 1.5R and runs the
 * rest. `qty` stays the original size (it's what risk was computed against);
 * `qty_open` is what's still held and is what equity, unrealized P&L and the
 * final exit must use. `realized_pnl_paise` on a closed trade is the SUM of both
 * legs, so closed-trade stats need no special-casing — but a trade that has
 * banked a rung and is still open holds realized P&L in `partial_pnl_paise`,
 * which summarize() and snapshotAccountHistory() add in explicitly.
 */

const DEFAULT_USER_ID = "local";
// Matches db/schema.sql's paper_trades.strategy DEFAULT and lib/strategies.ts's
// registry key for the one recipe that has ever opened a trade in this app.
export const DEFAULT_STRATEGY = "quality_trend_momentum_breakout";

/**
 * Sizing knobs a NEW account is seeded with. The authoritative values for a live
 * account are the paper_account row's — this is only what ensureAccount() writes,
 * mirroring db/schema.sql's DEFAULTs, exposed as one named source so the strategy
 * page's prose can interpolate it instead of restating the numbers.
 *
 * They interact: size = min(riskPctPerTrade / stopDistance, maxPositionPct) of
 * equity, so riskPctPerTrade normally sets the size and maxPositionPct only bites
 * on stops closer than riskPctPerTrade/maxPositionPct (4% of price at these
 * values). Aggregate risk at a full book = maxConcurrentTrades × riskPctPerTrade.
 */
export const DEFAULT_SIZING = {
  riskPctPerTrade: 0.5,
  maxConcurrentTrades: 10,
  maxPositionPct: 12.5,
} as const;

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
  strategy: string;
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
  exit_rule: string;
  /** Shares still held. NULL on rows written before the column existed — always
   *  read it through openQty() rather than directly. */
  qty_open: number | null;
  partial_qty: number;
  partial_exit_date: string | null;
  partial_exit_paise: number | null;
  partial_pnl_paise: number;
}

export interface OpenTradeWithMark extends PaperTradeRow {
  latest_close_paise: number | null;
  /** Marked on the shares still held, NOT the original size. */
  unrealized_pnl_paise: number | null;
  unrealized_pct: number | null;
  moved_to_breakeven: boolean;
  /** True once a scale-out rung has filled — the position is part-booked. */
  scaled_out: boolean;
}

/** Shares still held, tolerating rows that predate qty_open. */
export function openQty(t: Pick<PaperTradeRow, "qty" | "qty_open">): number {
  return t.qty_open ?? t.qty;
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
  // This INSERT names the sizing columns explicitly, so schema DEFAULTs don't
  // apply — bind DEFAULT_SIZING rather than restating literals that could drift.
  db.prepare(
    `INSERT INTO paper_account(user_id, starting_cash_paise, current_cash_paise, equity_paise,
                                risk_pct_per_trade, max_concurrent_trades, max_position_pct,
                                created_at, last_updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    userId, startingCashPaise, startingCashPaise, startingCashPaise,
    DEFAULT_SIZING.riskPctPerTrade, DEFAULT_SIZING.maxConcurrentTrades,
    DEFAULT_SIZING.maxPositionPct, now, now,
  );
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
  // Which strategy recipe is opening this trade (lib/strategies.ts registry
  // key). Defaults to the one recipe that has ever traded in this app, so
  // existing callers (scan-nifty100-signals.ts) don't need to change.
  strategy?: string;
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
  // Exit rule to manage this trade under. Defaults to CURRENT_EXIT_RULE, which
  // is what the scanner wants; tests pass it explicitly to pin a specific rule's
  // behaviour rather than silently re-pointing when the current rule changes.
  exit_rule?: ExitRuleId;
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
    `INSERT INTO paper_trades(user_id, strategy, symbol, exchange, entry_signal_scan_date,
                              entry_date, entry_time, entry_paise, qty, capital_committed_paise,
                              initial_stop_paise, current_stop_paise, target_paise, atr14_paise,
                              status, bars_held, exit_rule, qty_open)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 0, ?, ?)`,
  );
  const info = insert.run(
    userId, s.strategy ?? DEFAULT_STRATEGY, s.symbol, s.exchange, s.entry_signal_scan_date,
    s.scan_date, s.scan_time, s.entry_paise, size.qty, size.capital_committed_paise,
    s.stop_paise, s.stop_paise, s.target_paise, s.atr14_paise,
    s.exit_rule ?? CURRENT_EXIT_RULE, size.qty,
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
      `SELECT id, symbol, exchange, entry_paise, initial_stop_paise, current_stop_paise, qty,
              qty_open, partial_pnl_paise, bars_held
       FROM paper_trades WHERE user_id=? AND status='open'`,
    )
    .all(userId) as {
    id: number; symbol: string; exchange: string; entry_paise: number;
    initial_stop_paise: number; current_stop_paise: number; qty: number;
    qty_open: number | null; partial_pnl_paise: number; bars_held: number;
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
  // Rotate out only what's still held. A part-booked position already sold its
  // rung (and already credited that cash), so realized P&L must add the booked
  // leg back in while proceeds cover the remaining shares only.
  const remaining = openQty(worst.row);
  const realized = (exitPrice - worst.row.entry_paise) * remaining + worst.row.partial_pnl_paise;
  const proceeds = exitPrice * remaining;
  const now = nowIso();
  // mom_ratio is informational only under the new logic. Preserve the old
  // shape: ratio when worst > 0, else signed delta.
  const ratio = worstMom > 0 ? inMom / worstMom : inMom - worstMom;
  const reason = `rotated_out for ${s.symbol} (mom ${inMom.toFixed(3)} vs ${worstMom.toFixed(3)}, ratio ${worstMom > 0 ? ratio.toFixed(2) + "x" : "+" + ratio.toFixed(3)})`;
  db.prepare(
    `UPDATE paper_trades SET status='rotated_out', exit_date=date('now','+5 hours','+30 minutes'),
                             exit_time=?, exit_paise=?, exit_reason=?, realized_pnl_paise=?,
                             qty_open=0, bars_held=bars_held
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

/** Lowest low of the last `lookback` bars — the trailing stop's level. Null
 *  until there are enough bars to compute one. */
function donchianLow(bars: Bar[], lookback: number): number | null {
  if (bars.length < lookback) return null;
  let lo = Infinity;
  for (let i = bars.length - lookback; i < bars.length; i++) if (bars[i].low < lo) lo = bars[i].low;
  return Number.isFinite(lo) ? lo : null;
}

export interface UpdateResult {
  updated: number;
  stopped: number;
  target_hit: number;
  time_exit: number;
  breakeven_moved: number;
  /** Trades whose scale-out rung filled on this replay (open or since closed). */
  scaled_out: number;
}

/** Outcome of replaying one trade's bars. Pure — the caller does the writes, so
 *  the replay itself can be unit-tested and stays free of DB ordering concerns. */
interface ReplayOutcome {
  /** Stop as of the last bar walked. */
  currentStop: number;
  breakevenMoved: boolean;
  /** Bars elapsed since entry, capped at the exit bar when one fired. */
  barsHeld: number;
  /** Filled rung, if any. */
  partial: { date: string; pricePaise: number; qty: number; pnlPaise: number } | null;
  /** Set when the position fully closed during the walk. */
  exit: {
    status: "stopped" | "target_hit" | "time_exit";
    date: string;
    pricePaise: number;
    reason: string;
    /** Shares sold on this final leg (original qty minus any partial). */
    qty: number;
  } | null;
}

/**
 * Walk every bar since entry and derive the position's current state under
 * `rule`. Ordering is identical to lib/backtest.ts's simulateExit() — stop,
 * then rungs, then the post-rung breakeven re-check, then target, then
 * breakeven/trail ratchets, then the time cap — so a live trade and its
 * backtested twin resolve the same way.
 *
 * Replays from the INITIAL stop, not the stored current stop. This runs on every
 * cron fire, so it must restart from the state entry began with. Seeding with
 * current_stop_paise applied an already-ratcheted stop to bars that predate the
 * ratchet: a trade whose stop moved to breakeven on day 6 would, on the next
 * run, be tested against the breakeven stop from day 1 and exit at the earliest
 * day whose low dipped below entry — booking a fabricated scratch on a date the
 * stop was never there. Re-deriving chronologically is what makes it idempotent.
 */
function replayTrade(
  p: PaperTradeRow,
  bars: Bar[],
  barsAfter: Bar[],
  rule: ExitRule,
): ReplayOutcome {
  let currentStop = p.initial_stop_paise;
  let breakevenMoved = false;
  const risk = p.entry_paise - p.initial_stop_paise;
  const level = (r: number) => p.entry_paise + r * risk;

  // Whole-share bookkeeping: `remaining` is what's still held, and the partial
  // leg's P&L is banked as it fills.
  let remaining = p.qty;
  let partial: ReplayOutcome["partial"] = null;
  let nextRung = 0;

  for (let i = 0; i < barsAfter.length; i++) {
    const b = barsAfter[i];
    const barsHeld = i + 1;

    // Stop first — conservative on a gap-down, and on a bar that touches both
    // the stop and a profit level there's no intraday sequence to appeal to.
    if (b.low <= currentStop) {
      return {
        currentStop, breakevenMoved, barsHeld, partial,
        exit: {
          status: "stopped", date: b.trade_date, pricePaise: currentStop,
          reason: `low ${b.low} pierced stop ${currentStop} on ${b.trade_date}`,
          qty: remaining,
        },
      };
    }

    // Scale-out rungs, before the target check so a bar clearing both fills the
    // rung on the way through rather than skipping it.
    let filledARung = false;
    while (nextRung < rule.scaleOuts.length && b.high >= level(rule.scaleOuts[nextRung].r)) {
      const rung = rule.scaleOuts[nextRung];
      const rungPrice = Math.round(level(rung.r));
      const sellQty = rungQty(p.qty, rung.fraction);
      nextRung++;

      // A position too small to split exits IN FULL at the rung. Skipping the
      // rung instead would leave it running with no breakeven protection, which
      // is worse than either rule intends; see rungQty()'s note.
      if (sellQty <= 0 || sellQty >= remaining) {
        return {
          currentStop, breakevenMoved, barsHeld, partial,
          exit: {
            status: "target_hit", date: b.trade_date, pricePaise: rungPrice,
            reason: `high ${b.high} reached the ${rung.r}R scale-out level ${rungPrice} on ${b.trade_date}; position too small to split (qty ${p.qty}) so exited in full`,
            qty: remaining,
          },
        };
      }

      remaining -= sellQty;
      filledARung = true;
      if (partial === null) {
        partial = {
          date: b.trade_date,
          pricePaise: rungPrice,
          qty: sellQty,
          pnlPaise: (rungPrice - p.entry_paise) * sellQty,
        };
      } else {
        partial.qty += sellQty;
        partial.pnlPaise += (rungPrice - p.entry_paise) * sellQty;
      }
    }

    if (filledARung && rule.breakevenAfterPartial && currentStop < p.entry_paise) {
      currentStop = p.entry_paise;
      breakevenMoved = true;
      // Re-check THIS bar against the raised stop. Without it, a bar that ran up
      // through the rung and back below entry would bank the rung and carry the
      // remainder to the next bar for free — flattering the exact mechanic that
      // produces the win-rate gain.
      if (b.low <= currentStop) {
        return {
          currentStop, breakevenMoved, barsHeld, partial,
          exit: {
            status: "stopped", date: b.trade_date, pricePaise: currentStop,
            reason: `low ${b.low} pierced the post-scale-out breakeven stop ${currentStop} on ${b.trade_date}`,
            qty: remaining,
          },
        };
      }
    }

    if (b.high >= p.target_paise) {
      return {
        currentStop, breakevenMoved, barsHeld, partial,
        exit: {
          status: "target_hit", date: b.trade_date, pricePaise: p.target_paise,
          reason: `high ${b.high} reached target ${p.target_paise} on ${b.trade_date}`,
          qty: remaining,
        },
      };
    }

    if (rule.breakevenRMultiple !== null && b.close >= level(rule.breakevenRMultiple) && currentStop < p.entry_paise) {
      currentStop = p.entry_paise;
      breakevenMoved = true;
    }
    if (rule.trailRMultiple !== null && b.close >= level(rule.trailRMultiple)) {
      const upTo = bars.filter((x) => x.trade_date <= b.trade_date);
      const trail = donchianLow(upTo, rule.trailLookback);
      if (trail !== null && trail > currentStop) currentStop = trail;
    }

    // Time cap checked per bar, so it fires on the bar it's due rather than at
    // whatever the latest bar happens to be when the cron next runs.
    if (barsHeld >= rule.timeExitBars) {
      return {
        currentStop, breakevenMoved, barsHeld, partial,
        exit: {
          status: "time_exit", date: b.trade_date, pricePaise: b.close,
          reason: `${rule.timeExitBars} trading days elapsed`,
          qty: remaining,
        },
      };
    }
  }

  return { currentStop, breakevenMoved, barsHeld: barsAfter.length, partial, exit: null };
}

export function updateOpenPaperTrades(db: Database.Database, userId = DEFAULT_USER_ID): UpdateResult {
  const result: UpdateResult = {
    updated: 0, stopped: 0, target_hit: 0, time_exit: 0, breakeven_moved: 0, scaled_out: 0,
  };
  const rows = db
    .prepare(`SELECT * FROM paper_trades WHERE user_id=? AND status='open'`)
    .all(userId) as PaperTradeRow[];
  if (rows.length === 0) return result;

  const updateOpen = db.prepare(
    `UPDATE paper_trades SET current_stop_paise=?, bars_held=?, qty_open=?,
                              partial_qty=?, partial_exit_date=?, partial_exit_paise=?,
                              partial_pnl_paise=?
     WHERE id=?`,
  );
  const closeTrade = db.prepare(
    `UPDATE paper_trades SET status=?, exit_date=?, exit_time=?, exit_paise=?, exit_reason=?,
                              realized_pnl_paise=?, bars_held=?, qty_open=0,
                              partial_qty=?, partial_exit_date=?, partial_exit_paise=?,
                              partial_pnl_paise=?
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
      // Each trade is managed under the rule it was OPENED on, not today's —
      // see lib/exit-rules.ts for why promoting a rule must not re-plan
      // positions already running.
      const rule = resolveExitRule(p.exit_rule);
      const r = replayTrade(p, bars, barsAfter, rule);

      const partialQty = r.partial?.qty ?? 0;
      const partialPnl = r.partial?.pnlPaise ?? 0;
      if (r.partial) result.scaled_out++;

      // Partial proceeds already returned to cash on an earlier run, versus what
      // the replay now says were booked in total. Only ever credit the delta —
      // the replay re-derives the partial from scratch every fire, so crediting
      // the gross figure would double-count on the second run. Reconstructed from
      // (pnl + entry × qty) rather than the stored rung price so a multi-rung
      // ladder filling at several prices still nets out exactly.
      const bookedBefore = p.partial_pnl_paise + p.entry_paise * p.partial_qty;
      const bookedNow = partialPnl + p.entry_paise * partialQty;
      const partialProceedsDelta = Math.max(0, bookedNow - bookedBefore);

      if (r.exit) {
        // Realized P&L is the sum of both legs, so closed-trade stats need no
        // knowledge of the split.
        const finalPnl = (r.exit.pricePaise - p.entry_paise) * r.exit.qty;
        const proceeds = r.exit.pricePaise * r.exit.qty + partialProceedsDelta;
        closeTrade.run(
          r.exit.status, r.exit.date, nowIso(), r.exit.pricePaise, r.exit.reason,
          partialPnl + finalPnl, r.barsHeld,
          partialQty, r.partial?.date ?? null, r.partial?.pricePaise ?? null, partialPnl,
          p.id,
        );
        restoreCash.run(proceeds, nowIso(), userId);
        result[r.exit.status]++;
        continue;
      }

      const remaining = p.qty - partialQty;
      const changed =
        r.currentStop !== p.current_stop_paise ||
        r.barsHeld !== p.bars_held ||
        remaining !== openQty(p) ||
        partialQty !== p.partial_qty;
      if (changed) {
        updateOpen.run(
          r.currentStop, r.barsHeld, remaining,
          partialQty, r.partial?.date ?? null, r.partial?.pricePaise ?? null, partialPnl,
          p.id,
        );
        // A newly filled rung returns its proceeds to cash immediately — those
        // shares are sold.
        if (partialProceedsDelta > 0) restoreCash.run(partialProceedsDelta, nowIso(), userId);
        result.updated++;
        if (r.breakevenMoved) result.breakeven_moved++;
      }
    }
  });
  tx();

  // Recompute equity = cash + Σ(LTP × shares still held). Update paper_account.
  recomputeEquity(db, userId);
  return result;
}

// ---------- Recompute account equity ----------

export function recomputeEquity(db: Database.Database, userId = DEFAULT_USER_ID): void {
  const acc = getAccount(db, userId);
  if (!acc) return;
  // qty_open, not qty: a part-booked position's sold shares are already back in
  // cash, so marking the original size would double-count them.
  const openTrades = db
    .prepare(
      `SELECT symbol, exchange, qty, qty_open FROM paper_trades WHERE user_id=? AND status='open'`,
    )
    .all(userId) as { symbol: string; exchange: string; qty: number; qty_open: number | null }[];
  let openValue = 0;
  for (const t of openTrades) {
    const token = tokenForSymbol(db, t.symbol, t.exchange);
    if (token === null) continue;
    const ltp = latestClosePaise(db, token);
    if (ltp === null) continue;
    openValue += ltp * openQty(t);
  }
  const equity = acc.current_cash_paise + openValue;
  db.prepare(`UPDATE paper_account SET equity_paise=?, last_updated_at=? WHERE user_id=?`)
    .run(equity, nowIso(), userId);
}

// ---------- Fetch open trades with mark-to-market ----------

export function loadActivePaperTrades(
  db: Database.Database,
  userId = DEFAULT_USER_ID,
  strategy?: string,
): OpenTradeWithMark[] {
  const rows = (
    strategy
      ? db
          .prepare(
            `SELECT * FROM paper_trades WHERE user_id=? AND strategy=? AND status='open' ORDER BY entry_date ASC`,
          )
          .all(userId, strategy)
      : db
          .prepare(`SELECT * FROM paper_trades WHERE user_id=? AND status='open' ORDER BY entry_date ASC`)
          .all(userId)
  ) as PaperTradeRow[];
  return rows.map((r) => {
    const token = tokenForSymbol(db, r.symbol, r.exchange);
    const latest = token !== null ? latestClosePaise(db, token) : null;
    // Marked on the shares STILL HELD. A part-booked position's sold half is
    // realized P&L (partial_pnl_paise), not unrealized — counting it here would
    // report it twice.
    const unrealized = latest !== null ? (latest - r.entry_paise) * openQty(r) : null;
    const unrealPct = latest !== null ? ((latest - r.entry_paise) / r.entry_paise) * 100 : null;
    return {
      ...r,
      latest_close_paise: latest,
      unrealized_pnl_paise: unrealized,
      unrealized_pct: unrealPct,
      moved_to_breakeven: r.current_stop_paise >= r.entry_paise,
      scaled_out: r.partial_qty > 0,
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
  // Only the shares still held are sold here; anything already scaled out was
  // realized (and its cash returned) when the rung filled. realized_pnl_paise is
  // the whole trade's P&L, so it carries the partial leg too.
  const remaining = openQty(t);
  const realized = (exitPrice - t.entry_paise) * remaining + t.partial_pnl_paise;
  const proceeds = exitPrice * remaining;
  const now = nowIso();
  db.prepare(
    `UPDATE paper_trades SET status='manual_closed', exit_date=date('now','+5 hours','+30 minutes'),
                             exit_time=?, exit_paise=?, exit_reason=?, realized_pnl_paise=?,
                             qty_open=0
     WHERE id=?`,
  ).run(now, exitPrice, reason, realized, tradeId);
  db.prepare(
    `UPDATE paper_account SET current_cash_paise = current_cash_paise + ?, last_updated_at=?
     WHERE user_id=?`,
  ).run(proceeds, now, userId);
  recomputeEquity(db, userId);
  return { closed: true, realized_pnl_paise: realized };
}

/**
 * P&L already booked on the scale-out leg of trades that are STILL OPEN.
 *
 * `realized_pnl_paise` is only written on close, so a v2 trade that has sold
 * half at 1.5R and is running the rest has real, banked profit that no
 * `status != 'open'` sum can see. It must be counted as realized — and must NOT
 * also show up in unrealized, which is why loadActivePaperTrades marks on
 * openQty(). Closed trades are excluded here because their realized_pnl_paise
 * already includes the partial leg.
 */
function openPartialRealized(
  db: Database.Database,
  userId: string,
  strategy?: string,
): number {
  const row = (
    strategy
      ? db.prepare(
          `SELECT COALESCE(SUM(partial_pnl_paise), 0) AS s FROM paper_trades
           WHERE user_id=? AND strategy=? AND status='open'`,
        ).get(userId, strategy)
      : db.prepare(
          `SELECT COALESCE(SUM(partial_pnl_paise), 0) AS s FROM paper_trades
           WHERE user_id=? AND status='open'`,
        ).get(userId)
  ) as { s: number };
  return row.s;
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
  const realized =
    (db.prepare(
      `SELECT COALESCE(SUM(realized_pnl_paise), 0) AS s FROM paper_trades
       WHERE user_id=? AND status != 'open'`,
    ).get(userId) as { s: number }).s + openPartialRealized(db, userId);

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
  /** Calendar days spent underwater during the worst drawdown (peak until the
   *  peak was regained, or until today if still below it). */
  max_drawdown_duration_days: number | null;
  max_drawdown_recovered: boolean | null;
}

export function summarize(
  db: Database.Database,
  userId = DEFAULT_USER_ID,
  strategy?: string,
): PaperSummary | null {
  // NOTE: paper_account is one shared cash pool per user_id, not per strategy —
  // there's no per-strategy capital allocation yet. When `strategy` is passed,
  // the trade-level fields below (realized/unrealized P&L, win rate, avg R,
  // best/worst) are correctly scoped to that strategy, but starting_cash_paise,
  // current_cash_paise, equity_paise, total_return_pct, and max_drawdown_pct
  // remain ACCOUNT-WIDE (today this is a distinction without a difference,
  // since exactly one strategy has ever opened a trade). Callers rendering a
  // per-strategy page should treat those account-level fields as "whole
  // account" context, not "this strategy's own equity curve" — the UI should
  // label them accordingly rather than implying strategy-scoped capital.
  const acc = getAccount(db, userId);
  if (!acc) return null;
  const trades = loadActivePaperTrades(db, userId, strategy);
  const unrealized = trades.reduce((s, t) => s + (t.unrealized_pnl_paise ?? 0), 0);

  const closed = (
    strategy
      ? db.prepare(
          `SELECT COUNT(*) AS n, COALESCE(SUM(realized_pnl_paise),0) AS s,
                  SUM(CASE WHEN realized_pnl_paise > 0 THEN 1 ELSE 0 END) AS wins,
                  MIN(realized_pnl_paise) AS worst, MAX(realized_pnl_paise) AS best
           FROM paper_trades WHERE user_id=? AND strategy=? AND status != 'open'`,
        ).get(userId, strategy)
      : db.prepare(
          `SELECT COUNT(*) AS n, COALESCE(SUM(realized_pnl_paise),0) AS s,
                  SUM(CASE WHEN realized_pnl_paise > 0 THEN 1 ELSE 0 END) AS wins,
                  MIN(realized_pnl_paise) AS worst, MAX(realized_pnl_paise) AS best
           FROM paper_trades WHERE user_id=? AND status != 'open'`,
        ).get(userId)
  ) as { n: number; s: number; wins: number | null; worst: number | null; best: number | null };

  // Average R = mean of (realized / initial-risk-per-trade). Skip trades where risk was zero.
  const rows = (
    strategy
      ? db.prepare(
          `SELECT realized_pnl_paise, qty, entry_paise, initial_stop_paise
           FROM paper_trades WHERE user_id=? AND strategy=? AND status != 'open' AND realized_pnl_paise IS NOT NULL`,
        ).all(userId, strategy)
      : db.prepare(
          `SELECT realized_pnl_paise, qty, entry_paise, initial_stop_paise
           FROM paper_trades WHERE user_id=? AND status != 'open' AND realized_pnl_paise IS NOT NULL`,
        ).all(userId)
  ) as { realized_pnl_paise: number; qty: number; entry_paise: number; initial_stop_paise: number }[];
  let sumR = 0, nR = 0;
  for (const r of rows) {
    const perShareRisk = r.entry_paise - r.initial_stop_paise;
    if (perShareRisk <= 0 || r.qty <= 0) continue;
    const totalRisk = perShareRisk * r.qty;
    sumR += r.realized_pnl_paise / totalRisk;
    nR++;
  }
  const avgR = nR > 0 ? sumR / nR : null;

  // Max drawdown: peak-to-trough on equity_paise from paper_account_history.
  // Delegated to lib/metrics.ts's computeDrawdown so the paper account and the
  // backtest engines report drawdown from one implementation rather than three.
  const hist = db.prepare(
    `SELECT snapshot_date, equity_paise FROM paper_account_history
     WHERE user_id=? ORDER BY snapshot_date ASC`,
  ).all(userId) as { snapshot_date: string; equity_paise: number }[];
  const dd = computeDrawdown(hist.map((h) => ({ date: h.snapshot_date, value: h.equity_paise })));

  return {
    starting_cash_paise: acc.starting_cash_paise,
    current_cash_paise: acc.current_cash_paise,
    equity_paise: acc.equity_paise,
    total_return_pct: acc.starting_cash_paise > 0
      ? ((acc.equity_paise - acc.starting_cash_paise) / acc.starting_cash_paise) * 100
      : 0,
    // Banked P&L = closed trades + the sold half of any still-open v2 trade.
    realized_pnl_paise: closed.s + openPartialRealized(db, userId, strategy),
    unrealized_pnl_paise: unrealized,
    open_count: trades.length,
    closed_count: closed.n,
    win_rate_pct: closed.n > 0 ? ((closed.wins ?? 0) / closed.n) * 100 : null,
    avg_r_multiple: avgR,
    best_trade_paise: closed.best,
    worst_trade_paise: closed.worst,
    max_drawdown_pct: hist.length >= 2 ? dd.max_drawdown_pct : null,
    max_drawdown_duration_days: hist.length >= 2 ? dd.max_drawdown_duration_days : null,
    max_drawdown_recovered: hist.length >= 2 ? dd.recovered : null,
  };
}

