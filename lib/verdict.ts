import type Database from "better-sqlite3";
import {
  sma,
  atr,
  donchianLow,
  volAdjMomentum,
  avgVolume,
  goldenCross,
  isDonchianBreakout,
  type OHLC,
} from "./indicators";

/**
 * Shared stock-evaluation engine. Same set of checks powers:
 *   - scripts/scan-nifty100-signals.ts (cron scanner)
 *   - app/api/verdict/[symbol]/route.ts (UI on-demand check)
 *   - telegram-server /check <sym> command (mobile check)
 *
 * All three surfaces render the same StockVerdict object. One truth, three views.
 *
 * The engine does NOT fetch data — callers must ensure fundamentals and
 * ohlc_daily rows exist before calling. See scripts/refresh-single-stock.ts
 * for on-demand refresh.
 */

export const FINANCIALS_SECTORS: ReadonlySet<string> = new Set([
  "Financial Services",
  "Banks",
  "Financials",
]);

// Quality thresholds — the current recipe (v1). Financials are exempted from
// D/E and sales-growth checks (deposits ≠ debt, interest income ≠ sales).
export const QUALITY_THRESHOLDS = {
  ROCE_MIN: 15, // %
  ROE_MIN: 15, // %
  DE_MAX: 1.0,
  SALES_GROWTH_3Y_MIN: 10, // %
  PROFIT_GROWTH_3Y_MIN: 10, // %
  PROMOTER_HOLDING_MIN: 40, // %
} as const;

// Technical thresholds
export const TECHNICAL_THRESHOLDS = {
  DONCHIAN_LOOKBACK: 20,
  VOL_SURGE_MIN: 1.5, // × 20-day avg
  ATR_PERIOD: 14,
  STOP_ATR_MULT: 2, // stop = entry − 2×ATR14 (or 20-day low, whichever is higher)
  TARGET_R_MULTIPLE: 3, // target = entry + 3×(entry − stop)
  MOMENTUM_LOOKBACK: 252,
  MOMENTUM_SKIP: 21,
} as const;

/** Structured pass/fail line — same shape for every check so the UI can render uniformly. */
export interface CheckResult {
  filter: string; // human-readable, e.g. "ROCE ≥ 15%"
  value: number | null; // stock's actual value
  displayValue: string; // pre-formatted display (e.g. "42.1%", "₹1,340")
  threshold: string; // "≥ 15%", "≤ 1.0", "exempt (financial)"
  ok: boolean; // pass or fail
  note?: string; // e.g. "financials-exempt", "insufficient history"
}

export type OverallVerdict =
  | "PASS" // all quality + all technical filters fire → tradeable buy signal
  | "BREAKOUT_PENDING" // quality passes, trend passes, but breakout+volume not fired today
  | "TREND_FAIL" // quality passes but stock is in a downtrend (fails Golden Cross)
  | "QUALITY_FAIL" // stock fails one or more fundamental filters
  | "DATA_MISSING"; // insufficient fundamentals or OHLC to evaluate

export interface StockVerdict {
  symbol: string;
  exchange: string;
  isin: string | null;
  sector: string | null;
  overall: OverallVerdict;
  overallReason: string; // one-sentence summary for the banner
  quality: CheckResult[];
  technical: CheckResult[];
  trade: {
    entry_paise: number;
    stop_paise: number;
    target_paise: number;
    atr14_paise: number;
    risk_pct: number;
    reward_pct: number;
    risk_reward: number;
  } | null;
  latestBarDate: string | null;
  fundamentalsAsOfDate: string | null;
  warnings: string[]; // e.g. "financials sector — D/E and sales-growth skipped"
}

// ---------- helpers ----------

function fmtPct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(1)}%`;
}

function fmtNum(v: number | null, digits = 2): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return v.toFixed(digits);
}

function fmtRs(paise: number | null): string {
  if (paise === null || !Number.isFinite(paise)) return "—";
  return `₹${(paise / 100).toFixed(2)}`;
}

// ---------- input row shapes (mirror DB schema) ----------

export interface CoalescedFundamentals {
  isin: string;
  asOfDate: string | null;
  pe: number | null;
  pb: number | null;
  roe: number | null;
  roce: number | null;
  debt_equity: number | null;
  sales_growth_3y: number | null;
  profit_growth_3y: number | null;
  div_yield: number | null;
  market_cap_paise: number | null;
  promoter_holding: number | null;
}

export interface OhlcBar {
  trade_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ---------- DB adapters ----------

/**
 * Read one merged fundamentals row per ISIN, coalescing across historical
 * as_of_date rows (newest non-null value wins per column).
 */
export function loadCoalescedFundamentals(
  db: Database.Database,
  isin: string,
): CoalescedFundamentals | null {
  const stmt = db.prepare(
    `SELECT
       @isin AS isin,
       (SELECT as_of_date        FROM fundamentals WHERE isin=@isin ORDER BY as_of_date DESC LIMIT 1) as asOfDate,
       (SELECT pe                FROM fundamentals WHERE isin=@isin AND pe                IS NOT NULL ORDER BY as_of_date DESC LIMIT 1) as pe,
       (SELECT pb                FROM fundamentals WHERE isin=@isin AND pb                IS NOT NULL ORDER BY as_of_date DESC LIMIT 1) as pb,
       (SELECT roe               FROM fundamentals WHERE isin=@isin AND roe               IS NOT NULL ORDER BY as_of_date DESC LIMIT 1) as roe,
       (SELECT roce              FROM fundamentals WHERE isin=@isin AND roce              IS NOT NULL ORDER BY as_of_date DESC LIMIT 1) as roce,
       (SELECT debt_equity       FROM fundamentals WHERE isin=@isin AND debt_equity       IS NOT NULL ORDER BY as_of_date DESC LIMIT 1) as debt_equity,
       (SELECT sales_growth_3y   FROM fundamentals WHERE isin=@isin AND sales_growth_3y   IS NOT NULL ORDER BY as_of_date DESC LIMIT 1) as sales_growth_3y,
       (SELECT profit_growth_3y  FROM fundamentals WHERE isin=@isin AND profit_growth_3y  IS NOT NULL ORDER BY as_of_date DESC LIMIT 1) as profit_growth_3y,
       (SELECT div_yield         FROM fundamentals WHERE isin=@isin AND div_yield         IS NOT NULL ORDER BY as_of_date DESC LIMIT 1) as div_yield,
       (SELECT market_cap        FROM fundamentals WHERE isin=@isin AND market_cap        IS NOT NULL ORDER BY as_of_date DESC LIMIT 1) as market_cap_paise,
       (SELECT promoter_holding  FROM fundamentals WHERE isin=@isin AND promoter_holding  IS NOT NULL ORDER BY as_of_date DESC LIMIT 1) as promoter_holding`,
  );
  const row = stmt.get({ isin }) as CoalescedFundamentals | undefined;
  if (!row || row.asOfDate === null) return null;
  return row;
}

/**
 * Load OHLC series for one instrument, oldest → newest.
 *
 * When `ohlc_intraday` has a row for the caller's IST-today (i.e. we ran the
 * live-quote fetcher recently), the latest bar's CLOSE is replaced with the
 * intraday LTP so technical indicators reflect the current session. If today's
 * bhavcopy hasn't landed yet, a new synthetic bar is appended for today with
 * open=high=low=close=ltp and volume=intraday-so-far. This lets the scanner
 * fire fresh signals mid-session instead of showing yesterday's values.
 */
export function loadOhlc(db: Database.Database, instrumentToken: number): OhlcBar[] {
  const bars = db
    .prepare(
      `SELECT trade_date, open, high, low, close, volume
       FROM ohlc_daily
       WHERE instrument_token = ?
       ORDER BY trade_date ASC`,
    )
    .all(instrumentToken) as OhlcBar[];

  // Attempt intraday overlay for IST-today.
  const istToday = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const intra = db
    .prepare(
      `SELECT ltp, day_volume, fetched_at FROM ohlc_intraday
       WHERE instrument_token = ? AND quote_date = ?`,
    )
    .get(instrumentToken, istToday) as
    | { ltp: number; day_volume: number | null; fetched_at: string }
    | undefined;
  if (!intra) return bars;

  const last = bars[bars.length - 1];
  if (last && last.trade_date === istToday) {
    // Bhavcopy for today ALREADY landed — trust it over intraday (bhavcopy is
    // exchange-authoritative). Only override if bhavcopy's row is older than the
    // intraday tick. In practice bhavcopy replaces after ~18:00 IST, so during
    // market hours the intraday row is always the fresher of the two.
    // Heuristic: if intraday's fetched_at is newer than the day's assumed EOD
    // fetch, take intraday. Cheap enough to always prefer intraday during hours.
    last.close = intra.ltp;
    if (intra.day_volume !== null) last.volume = intra.day_volume;
    // high/low: keep the max/min of the existing bar bounds and the new close,
    // since we don't have separate intraday high/low from this source
    if (intra.ltp > last.high) last.high = intra.ltp;
    if (intra.ltp < last.low) last.low = intra.ltp;
    return bars;
  }

  // Bhavcopy for today isn't in yet. Append a synthetic single-tick bar so the
  // scanner's "today" evaluations use live data.
  bars.push({
    trade_date: istToday,
    open: intra.ltp,
    high: intra.ltp,
    low: intra.ltp,
    close: intra.ltp,
    volume: intra.day_volume ?? 0,
  });
  return bars;
}

// ---------- individual check builders ----------

function checkGte(name: string, value: number | null, threshold: number, unit: "%" | "" = ""): CheckResult {
  const ok = value !== null && Number.isFinite(value) && value >= threshold;
  return {
    filter: `${name} ≥ ${threshold}${unit}`,
    value,
    displayValue: unit === "%" ? fmtPct(value) : fmtNum(value),
    threshold: `≥ ${threshold}${unit}`,
    ok,
    note: value === null ? "value missing" : undefined,
  };
}

function checkLte(name: string, value: number | null, threshold: number, unit: "%" | "" = ""): CheckResult {
  const ok = value !== null && Number.isFinite(value) && value <= threshold;
  return {
    filter: `${name} ≤ ${threshold}${unit}`,
    value,
    displayValue: unit === "%" ? fmtPct(value) : fmtNum(value),
    threshold: `≤ ${threshold}${unit}`,
    ok,
    note: value === null ? "value missing" : undefined,
  };
}

function checkExempt(name: string, value: number | null, thresholdStr: string, unit: "%" | "" = ""): CheckResult {
  return {
    filter: `${name} (financials-exempt)`,
    value,
    displayValue: unit === "%" ? fmtPct(value) : fmtNum(value),
    threshold: thresholdStr,
    ok: true,
    note: "exempted for banks/NBFCs",
  };
}

// ---------- main evaluator ----------

export interface EvaluateInput {
  symbol: string;
  exchange: string;
  isin: string | null;
  sector: string | null;
  fundamentals: CoalescedFundamentals | null;
  ohlc: OhlcBar[];
}

export function evaluate(input: EvaluateInput): StockVerdict {
  const { symbol, exchange, isin, sector, fundamentals, ohlc } = input;
  const isFin = sector != null && FINANCIALS_SECTORS.has(sector);
  const warnings: string[] = [];
  if (isFin) warnings.push("Financials sector — D/E and 3y sales-growth filters exempted (deposits ≠ debt; interest-income ≠ sales)");

  // ---- Quality checks (6 filters) ----
  const quality: CheckResult[] = [];
  if (fundamentals) {
    quality.push(checkGte("ROCE (3y avg)", fundamentals.roce, QUALITY_THRESHOLDS.ROCE_MIN, "%"));
    quality.push(checkGte("ROE (3y avg)", fundamentals.roe, QUALITY_THRESHOLDS.ROE_MIN, "%"));
    quality.push(
      isFin
        ? checkExempt("Debt / Equity", fundamentals.debt_equity, "exempt")
        : checkLte("Debt / Equity", fundamentals.debt_equity, QUALITY_THRESHOLDS.DE_MAX),
    );
    quality.push(
      isFin
        ? checkExempt("Sales growth 3y", fundamentals.sales_growth_3y, "exempt", "%")
        : checkGte("Sales growth 3y", fundamentals.sales_growth_3y, QUALITY_THRESHOLDS.SALES_GROWTH_3Y_MIN, "%"),
    );
    quality.push(checkGte("Profit growth 3y", fundamentals.profit_growth_3y, QUALITY_THRESHOLDS.PROFIT_GROWTH_3Y_MIN, "%"));
    quality.push(checkGte("Promoter holding", fundamentals.promoter_holding, QUALITY_THRESHOLDS.PROMOTER_HOLDING_MIN, "%"));
  } else {
    warnings.push("No fundamentals row in DB. Cannot evaluate quality gate.");
  }
  const qualityPass = fundamentals !== null && quality.every((c) => c.ok);
  const qualityFailReasons = fundamentals ? quality.filter((c) => !c.ok).map((c) => c.filter) : [];

  // ---- Technical checks (5 filters) ----
  const technical: CheckResult[] = [];
  let trade: StockVerdict["trade"] = null;
  let latestBarDate: string | null = null;

  if (ohlc.length === 0) {
    warnings.push("No OHLC data in DB. Cannot evaluate technical layer.");
  } else {
    latestBarDate = ohlc[ohlc.length - 1].trade_date;
    const closes = ohlc.map((r) => r.close);
    const lows = ohlc.map((r) => r.low);
    const volumes = ohlc.map((r) => r.volume);
    const bars: OHLC[] = ohlc.map((r) => ({
      open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
    }));

    const lastClose = closes[closes.length - 1] ?? 0;
    const sma50 = sma(closes, 50);
    const sma200 = sma(closes, 200);
    const gc = goldenCross(closes);
    const breakout = isDonchianBreakout(closes, TECHNICAL_THRESHOLDS.DONCHIAN_LOOKBACK);
    const avgVol20 = avgVolume(volumes, TECHNICAL_THRESHOLDS.DONCHIAN_LOOKBACK);
    const lastVol = volumes[volumes.length - 1] ?? 0;
    const volRatio = avgVol20 && avgVol20 > 0 ? lastVol / avgVol20 : null;
    const mom = volAdjMomentum(closes, TECHNICAL_THRESHOLDS.MOMENTUM_LOOKBACK, TECHNICAL_THRESHOLDS.MOMENTUM_SKIP);
    const atr14 = atr(bars, TECHNICAL_THRESHOLDS.ATR_PERIOD);
    const dLow20 = donchianLow(lows, TECHNICAL_THRESHOLDS.DONCHIAN_LOOKBACK);

    // T1: Close above 200-DMA
    technical.push({
      filter: "Close > 200-DMA",
      value: sma200,
      displayValue: `close ${fmtRs(lastClose)} vs 200DMA ${fmtRs(sma200)}`,
      threshold: `close > 200-DMA`,
      ok: sma200 !== null && lastClose > sma200,
      note: sma200 === null ? "need 200 bars of history" : undefined,
    });
    // T2: 50-DMA above 200-DMA
    technical.push({
      filter: "50-DMA > 200-DMA",
      value: sma50,
      displayValue: `50DMA ${fmtRs(sma50)} vs 200DMA ${fmtRs(sma200)}`,
      threshold: `50-DMA > 200-DMA`,
      ok: sma50 !== null && sma200 !== null && sma50 > sma200,
      note: sma50 === null || sma200 === null ? "insufficient history" : undefined,
    });
    // T3: today is a fresh 20-day close high (Donchian breakout)
    technical.push({
      filter: `Today > max close (${TECHNICAL_THRESHOLDS.DONCHIAN_LOOKBACK}d)`,
      value: null,
      displayValue: breakout === true ? "yes" : breakout === false ? "no" : "—",
      threshold: `close > prior ${TECHNICAL_THRESHOLDS.DONCHIAN_LOOKBACK}d high`,
      ok: breakout === true,
      note: breakout === null ? `need ${TECHNICAL_THRESHOLDS.DONCHIAN_LOOKBACK + 1} bars` : undefined,
    });
    // T4: Volume surge
    technical.push({
      filter: `Volume ≥ ${TECHNICAL_THRESHOLDS.VOL_SURGE_MIN}× 20d avg`,
      value: volRatio,
      displayValue: volRatio !== null ? `${volRatio.toFixed(2)}× (today ${lastVol.toLocaleString()} vs avg ${avgVol20?.toFixed(0)})` : "—",
      threshold: `≥ ${TECHNICAL_THRESHOLDS.VOL_SURGE_MIN}×`,
      ok: volRatio !== null && volRatio >= TECHNICAL_THRESHOLDS.VOL_SURGE_MIN,
      note: avgVol20 === null ? "need 20 bars for avg" : undefined,
    });
    // T5: Momentum (informational, not gating — but shown so user sees ranking context)
    technical.push({
      filter: `Vol-adj 12-1 momentum (informational)`,
      value: mom,
      displayValue: mom !== null ? mom.toFixed(2) : "—",
      threshold: `higher is better`,
      ok: mom !== null && mom > 0,
      note: mom === null ? "need 252 bars" : "not a gate; used by scanner for top-30 ranking",
    });

    // If all 4 gating technicals pass (excluding T5), compute the trade box.
    const gatingTechnicalsPass = technical.slice(0, 4).every((c) => c.ok);
    if (gatingTechnicalsPass && atr14 !== null && dLow20 !== null && lastClose > 0) {
      const stopFromAtr = Math.round(lastClose - TECHNICAL_THRESHOLDS.STOP_ATR_MULT * atr14);
      const stop = Math.max(stopFromAtr, dLow20);
      if (stop < lastClose) {
        const risk = lastClose - stop;
        const target = Math.round(lastClose + TECHNICAL_THRESHOLDS.TARGET_R_MULTIPLE * risk);
        trade = {
          entry_paise: lastClose,
          stop_paise: stop,
          target_paise: target,
          atr14_paise: Math.round(atr14),
          risk_pct: (risk / lastClose) * 100,
          reward_pct: ((target - lastClose) / lastClose) * 100,
          risk_reward: TECHNICAL_THRESHOLDS.TARGET_R_MULTIPLE,
        };
      }
    }
  }

  // ---- Overall verdict ----
  let overall: OverallVerdict;
  let overallReason: string;
  if (fundamentals === null && ohlc.length === 0) {
    overall = "DATA_MISSING";
    overallReason = "No fundamentals or OHLC data — cannot evaluate.";
  } else if (fundamentals === null) {
    overall = "DATA_MISSING";
    overallReason = "Fundamentals missing — cannot verify quality gate.";
  } else if (ohlc.length === 0) {
    overall = "DATA_MISSING";
    overallReason = "OHLC data missing — cannot verify technical layer.";
  } else if (!qualityPass) {
    overall = "QUALITY_FAIL";
    overallReason = `Fails quality gate on: ${qualityFailReasons.join(", ")}`;
  } else if (!technical[0]?.ok || !technical[1]?.ok) {
    overall = "TREND_FAIL";
    overallReason = "Quality passes but stock is in a downtrend (Golden Cross fails).";
  } else if (trade === null) {
    overall = "BREAKOUT_PENDING";
    const missing: string[] = [];
    if (!technical[2].ok) missing.push("no 20d breakout today");
    if (!technical[3].ok) missing.push("volume surge missing");
    overallReason = `Quality + trend pass. Waiting on: ${missing.join(", ") || "entry trigger"}.`;
  } else {
    overall = "PASS";
    overallReason = `Full BUY setup active. Entry ${fmtRs(trade.entry_paise)}, Stop ${fmtRs(trade.stop_paise)} (−${trade.risk_pct.toFixed(1)}%), Target ${fmtRs(trade.target_paise)} (+${trade.reward_pct.toFixed(1)}%), R:R ${trade.risk_reward}:1.`;
  }

  return {
    symbol,
    exchange,
    isin,
    sector,
    overall,
    overallReason,
    quality,
    technical,
    trade,
    latestBarDate,
    fundamentalsAsOfDate: fundamentals?.asOfDate ?? null,
    warnings,
  };
}

/**
 * Convenience — load coalesced fundamentals and OHLC from the DB and evaluate.
 * Callers pass instrument_token separately (from index_universe or the
 * fetch-single-stock refresh). Symbol/exchange/isin/sector are for output only.
 */
export function evaluateFromDb(
  db: Database.Database,
  args: {
    symbol: string;
    exchange: string;
    isin: string | null;
    sector: string | null;
    instrument_token: number;
  },
): StockVerdict {
  const fundamentals = args.isin ? loadCoalescedFundamentals(db, args.isin) : null;
  const ohlc = loadOhlc(db, args.instrument_token);
  return evaluate({
    symbol: args.symbol,
    exchange: args.exchange,
    isin: args.isin,
    sector: args.sector,
    fundamentals,
    ohlc,
  });
}
