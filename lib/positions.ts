import type Database from "better-sqlite3";

/**
 * Simulated-position tracking. Every BUY signal the scanner emits opens a
 * paper position; subsequent scans check whether it hit stop/target/time-exit
 * and update state accordingly. The Telegram digest lists Active positions so
 * the user can trace each trade's fate over time.
 *
 * Rules (mirror the strategy exit spec):
 *   Stop hit         — today's LOW  ≤ current_stop_paise → status='stopped', exit at current_stop
 *   Target hit       — today's HIGH ≥ target_paise       → status='target_hit', exit at target
 *   Move to breakeven — at +1R unrealized (max(close, high) since entry),
 *                       current_stop is raised to entry_paise (never lowered)
 *   Trail at +2R     — current_stop advances to the trailing 20-day low
 *                       (only above breakeven; never lowered)
 *   Time exit        — 60 trading days since entry → status='time_exit', exit at latest close
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
}

export interface PositionUpdateResult {
  opened: number;
  updated: number;
  stopped: number;
  target_hit: number;
  time_exit: number;
  breakeven_moved: number;
}

const TIME_EXIT_BARS = 60;
const BREAKEVEN_R_MULTIPLE = 1; // move stop to breakeven at +1R
const TRAIL_R_MULTIPLE = 2; // trail with 20-day low above +2R

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

function donchianLow20(bars: Bar[]): number | null {
  if (bars.length < 20) return null;
  let lo = Infinity;
  for (let i = bars.length - 20; i < bars.length; i++) if (bars[i].low < lo) lo = bars[i].low;
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
  },
): boolean {
  const res = db
    .prepare(
      `INSERT INTO open_positions(
         symbol, exchange, entry_scan_date, entry_scan_time, side,
         entry_paise, initial_stop_paise, current_stop_paise, target_paise, atr14_paise,
         status, bars_held
       )
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 0)
       ON CONFLICT(symbol, exchange, entry_scan_date, side) DO NOTHING`,
    )
    .run(
      s.symbol, s.exchange, s.scan_date, s.scan_time, s.side,
      s.entry_paise, s.stop_paise, s.stop_paise, s.target_paise, s.atr14_paise,
    );
  return res.changes > 0;
}

/**
 * Advance every open position by evaluating recent bars against its stop and
 * target, and adjusting current_stop for breakeven-move / trailing behavior.
 * Idempotent — safe to run multiple times per scan (uses today's latest bar).
 */
export function updateOpenPositions(db: Database.Database): PositionUpdateResult {
  const result: PositionUpdateResult = {
    opened: 0, updated: 0, stopped: 0, target_hit: 0, time_exit: 0, breakeven_moved: 0,
  };

  const rows = db
    .prepare(`SELECT * FROM open_positions WHERE status = 'open'`)
    .all() as OpenPositionRow[];
  if (rows.length === 0) return result;

  const updateStop = db.prepare(
    `UPDATE open_positions SET current_stop_paise = ?, bars_held = ? WHERE symbol = ? AND exchange = ? AND entry_scan_date = ? AND side = ?`,
  );
  const closePosition = db.prepare(
    `UPDATE open_positions SET status = ?, exit_date = ?, exit_paise = ?, exit_reason = ?, bars_held = ?
     WHERE symbol = ? AND exchange = ? AND entry_scan_date = ? AND side = ?`,
  );

  const tx = db.transaction(() => {
    for (const p of rows) {
      const token = tokenForSymbol(db, p.symbol, p.exchange);
      if (token === null) continue; // universe row missing; skip silently
      // Bars since entry (exclusive). Load a 20-bar lookback window for
      // trailing-stop computation too.
      const bars = loadBarsSince(db, token, p.entry_scan_date);
      // Bars *since* entry — strictly after entry date. Screener bars share the
      // entry_scan_date row too; we consider "bars_held" = count where
      // trade_date > entry_scan_date.
      const barsAfter = bars.filter((b) => b.trade_date > p.entry_scan_date);
      const barsHeld = barsAfter.length;

      // Walk each bar chronologically. First trigger wins.
      let closed = false;
      let currentStop = p.current_stop_paise;
      let breakevenMoved = false;
      const risk = p.entry_paise - p.initial_stop_paise; // positive
      const oneR = p.entry_paise + BREAKEVEN_R_MULTIPLE * risk;
      const twoR = p.entry_paise + TRAIL_R_MULTIPLE * risk;

      for (const b of barsAfter) {
        // Stop / target check (stop first — conservative in a gap-down)
        if (b.low <= currentStop) {
          closePosition.run(
            "stopped", b.trade_date, currentStop, `low ${b.low} pierced stop ${currentStop} on ${b.trade_date}`,
            barsHeld, p.symbol, p.exchange, p.entry_scan_date, p.side,
          );
          result.stopped++;
          closed = true;
          break;
        }
        if (b.high >= p.target_paise) {
          closePosition.run(
            "target_hit", b.trade_date, p.target_paise, `high ${b.high} reached target ${p.target_paise} on ${b.trade_date}`,
            barsHeld, p.symbol, p.exchange, p.entry_scan_date, p.side,
          );
          result.target_hit++;
          closed = true;
          break;
        }
        // Not exited — update stop if we crossed +1R (breakeven) or +2R (trail).
        // Use close so we don't false-breakeven on a wick.
        if (b.close >= oneR && currentStop < p.entry_paise) {
          currentStop = p.entry_paise;
          breakevenMoved = true;
        }
        if (b.close >= twoR) {
          // Compute trailing 20-day low as of THIS bar.
          const upTo = bars.filter((x) => x.trade_date <= b.trade_date);
          const trail = donchianLow20(upTo);
          if (trail !== null && trail > currentStop) currentStop = trail;
        }
      }

      if (!closed) {
        // Time exit?
        if (barsHeld >= TIME_EXIT_BARS) {
          const latestClose = barsAfter[barsAfter.length - 1]?.close ?? p.entry_paise;
          const latestDate = barsAfter[barsAfter.length - 1]?.trade_date ?? p.entry_scan_date;
          closePosition.run(
            "time_exit", latestDate, latestClose, `${TIME_EXIT_BARS} trading days elapsed`,
            barsHeld, p.symbol, p.exchange, p.entry_scan_date, p.side,
          );
          result.time_exit++;
          continue;
        }
        // Persist stop movement + bars_held even when no exit.
        if (currentStop !== p.current_stop_paise || barsHeld !== p.bars_held) {
          updateStop.run(currentStop, barsHeld, p.symbol, p.exchange, p.entry_scan_date, p.side);
          result.updated++;
          if (breakevenMoved) result.breakeven_moved++;
        }
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
}
export function loadActivePositions(db: Database.Database): ActivePosition[] {
  const rows = db
    .prepare(
      `SELECT symbol, exchange, entry_scan_date, entry_paise, initial_stop_paise,
              current_stop_paise, target_paise, bars_held
       FROM open_positions WHERE status = 'open'
       ORDER BY entry_scan_date ASC`,
    )
    .all() as {
    symbol: string; exchange: string; entry_scan_date: string; entry_paise: number;
    initial_stop_paise: number; current_stop_paise: number; target_paise: number; bars_held: number;
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
    };
  });
}
