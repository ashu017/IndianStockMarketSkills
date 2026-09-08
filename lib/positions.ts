import type Database from "better-sqlite3";
import { CURRENT_EXIT_RULE, resolveExitRule, type ExitRule, type ExitRuleId } from "./exit-rules";

/**
 * Simulated-position tracking. Every BUY signal the scanner emits opens a
 * paper position; subsequent scans check whether it hit stop/target/time-exit
 * and update state accordingly. The Telegram digest lists Active positions so
 * the user can trace each trade's fate over time.
 *
 * This tracker is UNSIZED — one row per signal, no share count and no cash. The
 * sized twin is lib/paper.ts. Both read their exit rules from lib/exit-rules.ts
 * so the digest and the paper account can't describe different trades; the only
 * behavioural difference is that a scale-out rung here records the fact and the
 * price of the partial but has no quantity to split, so the position keeps
 * running (with the stop at entry) until stop, target or the time cap.
 *
 * Rules resolve PER ROW from open_positions.exit_rule, stamped at open — a rule
 * promotion must not re-plan positions already running on the old one. Ordering
 * within a bar matches lib/paper.ts's replayTrade(): stop, then rungs, then the
 * post-rung breakeven re-check, then target, then breakeven/trail ratchets, then
 * the time cap.
 */

export interface OpenPositionRow {
  symbol: string;
  exchange: string;
  entry_scan_date: string;
  entry_scan_time: string;
  side: "BUY" | "SELL";
  entry_paise: number;
  initial_stop_paise: number;
  current_stop_paise: number;
  target_paise: number;
  atr14_paise: number | null;
  status: "open" | "target_hit" | "stopped" | "time_exit" | "manual_closed";
  exit_date: string | null;
  exit_paise: number | null;
  exit_reason: string | null;
  bars_held: number;
  exit_rule: string;
  partial_exit_date: string | null;
  partial_exit_paise: number | null;
}

export interface PositionUpdateResult {
  opened: number;
  updated: number;
  stopped: number;
  target_hit: number;
  time_exit: number;
  breakeven_moved: number;
  /** Positions whose scale-out rung filled on this replay. */
  scaled_out: number;
}

interface Bar {
  trade_date: string;
  low: number;
  high: number;
  close: number;
}

function loadBarsSince(
  db: Database.Database,
  instrumentToken: number,
  fromDate: string,
): Bar[] {
  return db
    .prepare(
      `SELECT trade_date, low, high, close
       FROM ohlc_daily
       WHERE instrument_token = ? AND trade_date >= ?
       ORDER BY trade_date ASC`,
    )
    .all(instrumentToken, fromDate) as Bar[];
}

function tokenForSymbol(db: Database.Database, symbol: string, exchange: string): number | null {
  const r = db
    .prepare(
      `SELECT instrument_token FROM index_universe WHERE symbol = ? AND exchange = ? LIMIT 1`,
    )
    .get(symbol, exchange) as { instrument_token: number } | undefined;
  return r?.instrument_token ?? null;
}

function donchianLow(bars: Bar[], lookback: number): number | null {
  if (bars.length < lookback) return null;
  let lo = Infinity;
  for (let i = bars.length - lookback; i < bars.length; i++) if (bars[i].low < lo) lo = bars[i].low;
  return Number.isFinite(lo) ? lo : null;
}

/**
 * Open a new position for a fresh BUY signal. No-op if one already exists for
 * this (symbol, exchange, entry_scan_date, side).
 */
export function recordSignalAsPosition(
  db: Database.Database,
  s: {
    symbol: string;
    exchange: string;
    scan_date: string;
    scan_time: string;
    side: "BUY";
    entry_paise: number;
    stop_paise: number;
    target_paise: number;
    atr14_paise: number | null;
    /** Rule to manage this position under. Defaults to the current live rule;
     *  tests and replays of historical signals can pin an older one. */
    exit_rule?: ExitRuleId;
  },
): boolean {
  const res = db
    .prepare(
      `INSERT INTO open_positions(
         symbol, exchange, entry_scan_date, entry_scan_time, side,
         entry_paise, initial_stop_paise, current_stop_paise, target_paise, atr14_paise,
         status, bars_held, exit_rule
       )
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 0, ?)
       ON CONFLICT(symbol, exchange, entry_scan_date, side) DO NOTHING`,
    )
    .run(
      s.symbol, s.exchange, s.scan_date, s.scan_time, s.side,
      s.entry_paise, s.stop_paise, s.stop_paise, s.target_paise, s.atr14_paise,
      s.exit_rule ?? CURRENT_EXIT_RULE,
    );
  return res.changes > 0;
}

/** Outcome of replaying one position's bars. Pure — the caller does the writes. */
interface PositionReplayOutcome {
  currentStop: number;
  breakevenMoved: boolean;
  /** Bars elapsed since entry, capped at the exit bar when one fired. */
  barsHeld: number;
  /** First filled rung, if any. Unsized, so only the fact and the price. */
  partial: { date: string; pricePaise: number } | null;
  exit: {
    status: "stopped" | "target_hit" | "time_exit";
    date: string;
    pricePaise: number;
    reason: string;
  } | null;
}

/**
 * Walk every bar since entry and derive the position's state under `rule`.
 *
 * Replays from the INITIAL stop, not the stored current one: this runs on every
 * scan, so seeding from an already-ratcheted stop would test bars that predate
 * the ratchet against it and book a fabricated scratch on a date the stop was
 * never there.
 */
function replayPosition(
  p: OpenPositionRow,
  bars: Bar[],
  barsAfter: Bar[],
  rule: ExitRule,
): PositionReplayOutcome {
  let currentStop = p.initial_stop_paise;
  let breakevenMoved = false;
  const risk = p.entry_paise - p.initial_stop_paise; // positive
  const level = (r: number) => p.entry_paise + r * risk;

  let partial: PositionReplayOutcome["partial"] = null;
  let nextRung = 0;

  for (let i = 0; i < barsAfter.length; i++) {
    const b = barsAfter[i];
    const barsHeld = i + 1;

    // Stop first — conservative on a gap-down.
    if (b.low <= currentStop) {
      return {
        currentStop, breakevenMoved, barsHeld, partial,
        exit: {
          status: "stopped", date: b.trade_date, pricePaise: currentStop,
          reason: `low ${b.low} pierced stop ${currentStop} on ${b.trade_date}`,
        },
      };
    }

    // Scale-out rungs, before the target check so a bar clearing both records
    // the rung on the way through rather than skipping it.
    let filledARung = false;
    while (nextRung < rule.scaleOuts.length && b.high >= level(rule.scaleOuts[nextRung].r)) {
      const rung = rule.scaleOuts[nextRung];
      nextRung++;
      filledARung = true;
      // Only the first rung's price is recorded — there is no quantity here, so
      // later rungs add no information a sized tracker would need.
      if (partial === null) {
        partial = { date: b.trade_date, pricePaise: Math.round(level(rung.r)) };
      }
    }

    if (filledARung && rule.breakevenAfterPartial && currentStop < p.entry_paise) {
      currentStop = p.entry_paise;
      breakevenMoved = true;
      // Re-check THIS bar against the raised stop, so a bar that ran up through
      // the rung and back below entry doesn't carry to the next bar for free.
      if (b.low <= currentStop) {
        return {
          currentStop, breakevenMoved, barsHeld, partial,
          exit: {
            status: "stopped", date: b.trade_date, pricePaise: currentStop,
            reason: `low ${b.low} pierced the post-scale-out breakeven stop ${currentStop} on ${b.trade_date}`,
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
        },
      };
    }

    // Ratchets use the CLOSE so a wick can't trigger a false breakeven.
    if (rule.breakevenRMultiple !== null && b.close >= level(rule.breakevenRMultiple) && currentStop < p.entry_paise) {
      currentStop = p.entry_paise;
      breakevenMoved = true;
    }
    if (rule.trailRMultiple !== null && b.close >= level(rule.trailRMultiple)) {
      const upTo = bars.filter((x) => x.trade_date <= b.trade_date);
      const trail = donchianLow(upTo, rule.trailLookback);
      if (trail !== null && trail > currentStop) currentStop = trail;
    }

    // Time cap per bar, so it fires on the bar it's due rather than on whatever
    // the latest bar happens to be when the scanner next runs.
    if (barsHeld >= rule.timeExitBars) {
      return {
        currentStop, breakevenMoved, barsHeld, partial,
        exit: {
          status: "time_exit", date: b.trade_date, pricePaise: b.close,
          reason: `${rule.timeExitBars} trading days elapsed`,
        },
      };
    }
  }

  return { currentStop, breakevenMoved, barsHeld: barsAfter.length, partial, exit: null };
}

/**
 * Advance every open position by evaluating recent bars against its stop and
 * target, and adjusting current_stop for breakeven-move / trailing behavior.
 * Idempotent — safe to run multiple times per scan (uses today's latest bar).
 */
export function updateOpenPositions(db: Database.Database): PositionUpdateResult {
  const result: PositionUpdateResult = {
    opened: 0, updated: 0, stopped: 0, target_hit: 0, time_exit: 0, breakeven_moved: 0,
    scaled_out: 0,
  };

  const rows = db
    .prepare(`SELECT * FROM open_positions WHERE status = 'open'`)
    .all() as OpenPositionRow[];
  if (rows.length === 0) return result;

  const updateStop = db.prepare(
    `UPDATE open_positions SET current_stop_paise = ?, bars_held = ?,
                               partial_exit_date = ?, partial_exit_paise = ?
     WHERE symbol = ? AND exchange = ? AND entry_scan_date = ? AND side = ?`,
  );
  const closePosition = db.prepare(
    `UPDATE open_positions SET status = ?, exit_date = ?, exit_paise = ?, exit_reason = ?, bars_held = ?,
                               partial_exit_date = ?, partial_exit_paise = ?
     WHERE symbol = ? AND exchange = ? AND entry_scan_date = ? AND side = ?`,
  );

  const tx = db.transaction(() => {
    for (const p of rows) {
      const token = tokenForSymbol(db, p.symbol, p.exchange);
      if (token === null) continue; // universe row missing; skip silently
      // Bars since entry, plus the lookback window the trailing stop needs.
      const bars = loadBarsSince(db, token, p.entry_scan_date);
      // Bars *since* entry — strictly after the entry date, which has its own
      // bar in ohlc_daily.
      const barsAfter = bars.filter((b) => b.trade_date > p.entry_scan_date);

      // Managed under the rule it was OPENED on, not today's.
      const rule = resolveExitRule(p.exit_rule);
      const r = replayPosition(p, bars, barsAfter, rule);
      if (r.partial) result.scaled_out++;

      if (r.exit) {
        closePosition.run(
          r.exit.status, r.exit.date, r.exit.pricePaise, r.exit.reason, r.barsHeld,
          r.partial?.date ?? null, r.partial?.pricePaise ?? null,
          p.symbol, p.exchange, p.entry_scan_date, p.side,
        );
        result[r.exit.status]++;
        continue;
      }

      // Persist stop movement, bars_held and any rung fill even when still open.
      if (
        r.currentStop !== p.current_stop_paise ||
        r.barsHeld !== p.bars_held ||
        (r.partial?.date ?? null) !== p.partial_exit_date
      ) {
        updateStop.run(
          r.currentStop, r.barsHeld,
          r.partial?.date ?? null, r.partial?.pricePaise ?? null,
          p.symbol, p.exchange, p.entry_scan_date, p.side,
        );
        result.updated++;
        if (r.breakevenMoved) result.breakeven_moved++;
      }
    }
  });
  tx();
  return result;
}

/**
 * Fetch every open position enriched with its current unrealized state.
 * Used by the Telegram digest and the UI.
 */
export interface ActivePosition {
  symbol: string;
  exchange: string;
  entry_date: string;
  entry_paise: number;
  current_stop_paise: number;
  target_paise: number;
  bars_held: number;
  latest_close_paise: number | null;
  unrealized_pct: number | null;
  moved_to_breakeven: boolean;
  /** A scale-out rung has filled — the digest flags these as part-booked. */
  scaled_out: boolean;
  partial_exit_paise: number | null;
}
export function loadActivePositions(db: Database.Database): ActivePosition[] {
  const rows = db
    .prepare(
      `SELECT symbol, exchange, entry_scan_date, entry_paise, initial_stop_paise,
              current_stop_paise, target_paise, bars_held,
              partial_exit_date, partial_exit_paise
       FROM open_positions WHERE status = 'open'
       ORDER BY entry_scan_date ASC`,
    )
    .all() as {
    symbol: string; exchange: string; entry_scan_date: string; entry_paise: number;
    initial_stop_paise: number; current_stop_paise: number; target_paise: number; bars_held: number;
    partial_exit_date: string | null; partial_exit_paise: number | null;
  }[];
  return rows.map((r) => {
    const token = tokenForSymbol(db, r.symbol, r.exchange);
    let latest: number | null = null;
    if (token !== null) {
      const q = db
        .prepare(`SELECT close FROM ohlc_daily WHERE instrument_token=? ORDER BY trade_date DESC LIMIT 1`)
        .get(token) as { close: number } | undefined;
      if (q) latest = q.close;
    }
    const unrealized_pct = latest !== null ? ((latest - r.entry_paise) / r.entry_paise) * 100 : null;
    return {
      symbol: r.symbol,
      exchange: r.exchange,
      entry_date: r.entry_scan_date,
      entry_paise: r.entry_paise,
      current_stop_paise: r.current_stop_paise,
      target_paise: r.target_paise,
      bars_held: r.bars_held,
      latest_close_paise: latest,
      unrealized_pct,
      moved_to_breakeven: r.current_stop_paise >= r.entry_paise,
      scaled_out: r.partial_exit_date !== null,
      partial_exit_paise: r.partial_exit_paise,
    };
  });
}

