/**
 * Technical indicators for the Nifty 100 signal scanner. All functions are pure,
 * take number arrays / OHLC arrays in chronological order (oldest → newest), and
 * return null when the input series is shorter than the required lookback (no
 * silent zero-fill that would produce false signals).
 *
 * Prices are treated as plain numbers here — the caller decides units (paise or
 * rupees). Ratios and % values (RSI, momentum score) are dimensionless.
 */

export interface OHLC {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Simple moving average over the last n values. Null if series.length < n. */
export function sma(series: number[], n: number): number | null {
  if (n <= 0 || series.length < n) return null;
  let sum = 0;
  for (let i = series.length - n; i < series.length; i++) sum += series[i];
  return sum / n;
}

/** Highest close in the last n bars, inclusive of the latest bar. */
export function donchianHigh(closes: number[], n: number): number | null {
  if (n <= 0 || closes.length < n) return null;
  let hi = -Infinity;
  for (let i = closes.length - n; i < closes.length; i++) {
    if (closes[i] > hi) hi = closes[i];
  }
  return hi;
}

/** Lowest low in the last n bars (raw low, not close). Used for stop fallback. */
export function donchianLow(lows: number[], n: number): number | null {
  if (n <= 0 || lows.length < n) return null;
  let lo = Infinity;
  for (let i = lows.length - n; i < lows.length; i++) {
    if (lows[i] < lo) lo = lows[i];
  }
  return lo;
}

/**
 * ATR(n) using Wilder's smoothing on true range: TR = max(H-L, |H-prevC|, |L-prevC|).
 * Warm-up = simple average of first n TR values; subsequent bars use
 * ATR_i = (ATR_{i-1} * (n-1) + TR_i) / n. Returns the ATR at the LATEST bar.
 * Null if bars.length < n + 1 (need one prior close to compute the first TR).
 */
export function atr(bars: OHLC[], n = 14): number | null {
  if (n <= 0 || bars.length < n + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const prevClose = bars[i - 1].close;
    const tr = Math.max(
      b.high - b.low,
      Math.abs(b.high - prevClose),
      Math.abs(b.low - prevClose),
    );
    trs.push(tr);
  }
  // Wilder warm-up: simple average of first n TRs.
  let atrVal = 0;
  for (let i = 0; i < n; i++) atrVal += trs[i];
  atrVal /= n;
  // Then smooth over the remaining bars.
  for (let i = n; i < trs.length; i++) {
    atrVal = (atrVal * (n - 1) + trs[i]) / n;
  }
  return atrVal;
}

/**
 * NSE-style vol-adjusted 12-1 momentum score.
 *
 * Definition: (return over the window t-tPast to t-tSkip) divided by the
 * standard deviation of daily log-returns over the same window.
 * Default parameters (tPast=252, tSkip=21) reproduce the "12-1" academic
 * momentum construction: 12 months ending 1 month ago. Skipping the most
 * recent month is the standard mean-reversion correction (Jegadeesh-Titman 1993).
 *
 * Null if closes.length <= tPast (not enough history).
 */
export function volAdjMomentum(
  closes: number[],
  tPast = 252,
  tSkip = 21,
): number | null {
  if (tPast <= tSkip) throw new Error("tPast must be > tSkip");
  if (closes.length <= tPast) return null;

  const end = closes.length - 1 - tSkip; // inclusive
  const start = closes.length - 1 - tPast; // inclusive
  if (start < 0 || end <= start) return null;

  const priceStart = closes[start];
  const priceEnd = closes[end];
  if (priceStart <= 0 || priceEnd <= 0) return null;
  const totalReturn = priceEnd / priceStart - 1;

  // Log-return stdev over the same [start, end] window.
  const logReturns: number[] = [];
  for (let i = start + 1; i <= end; i++) {
    if (closes[i - 1] <= 0 || closes[i] <= 0) continue;
    logReturns.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (logReturns.length < 2) return null;
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  let sqSum = 0;
  for (const r of logReturns) sqSum += (r - mean) * (r - mean);
  const stdev = Math.sqrt(sqSum / (logReturns.length - 1));
  if (stdev === 0) return null;
  return totalReturn / stdev;
}

/** Simple average of the last n volumes. Null if series.length < n. */
export function avgVolume(volumes: number[], n = 20): number | null {
  return sma(volumes, n);
}

/**
 * Minimal OHLC shape for Yang-Zhang volatility. Any object with these four
 * fields works — the full `OHLC` interface above (which also has `volume`) is
 * a superset and can be passed directly.
 */
export interface OhlcBar {
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * Yang-Zhang OHLC volatility estimator (Yang & Zhang 2000).
 *
 * More efficient than close-to-close stdev because it uses the full O/H/L/C for
 * every bar — captures overnight jumps AND intraday range. That's exactly what
 * momentum-vs-vol scoring needs on gappy Indian equities where a single
 * event-driven overnight move can dwarf a week of intraday drift.
 *
 * Requires `window + 1` bars (bar 0 is the anchor for the first overnight
 * return; bars 1..N are the window). Returns the RAW daily sigma (not
 * annualized) so it drops into `volAdjMomentum` as a direct denominator.
 *
 * Returns null when:
 *   - fewer than window+1 bars supplied
 *   - window < 2 (need at least 2 data points for a sample stdev)
 *   - any bar has a non-positive price
 *   - any bar has high < low (malformed)
 *
 *   σ_o² = sample-variance of ln(open_i / close_{i-1})
 *   σ_c² = sample-variance of ln(close_i / open_i)
 *   σ_rs² = mean of [ ln(H/C)·ln(H/O) + ln(L/C)·ln(L/O) ]  (Rogers-Satchell, drift-free)
 *   k     = 0.34 / (1.34 + (N+1)/(N-1))
 *   σ_YZ² = σ_o² + k·σ_c² + (1-k)·σ_rs²
 */
export function yangZhangVolatility(
  bars: OhlcBar[],
  window: number,
): number | null {
  if (window < 2) return null;
  if (bars.length < window + 1) return null;
  // Take the last window+1 bars — bar 0 is the "anchor" for the first overnight.
  const slice = bars.slice(bars.length - (window + 1));
  // Validate all bars first (positive prices, high >= low).
  for (const b of slice) {
    if (
      !Number.isFinite(b.open) ||
      !Number.isFinite(b.high) ||
      !Number.isFinite(b.low) ||
      !Number.isFinite(b.close)
    ) {
      return null;
    }
    if (b.open <= 0 || b.high <= 0 || b.low <= 0 || b.close <= 0) return null;
    if (b.high < b.low) return null;
  }
  const N = window;
  const overnight: number[] = []; // ln(open_i / close_{i-1})
  const openToClose: number[] = []; // ln(close_i / open_i)
  let rsSum = 0; // Σ Rogers-Satchell terms
  for (let i = 1; i <= N; i++) {
    const prev = slice[i - 1];
    const b = slice[i];
    overnight.push(Math.log(b.open / prev.close));
    openToClose.push(Math.log(b.close / b.open));
    const hc = Math.log(b.high / b.close);
    const ho = Math.log(b.high / b.open);
    const lc = Math.log(b.low / b.close);
    const lo = Math.log(b.low / b.open);
    rsSum += hc * ho + lc * lo;
  }
  const sampleVar = (xs: number[]): number => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    let sq = 0;
    for (const x of xs) sq += (x - m) * (x - m);
    return sq / (xs.length - 1);
  };
  const sigmaO2 = sampleVar(overnight);
  const sigmaC2 = sampleVar(openToClose);
  const sigmaRS2 = rsSum / N;
  const k = 0.34 / (1.34 + (N + 1) / (N - 1));
  const yz2 = sigmaO2 + k * sigmaC2 + (1 - k) * sigmaRS2;
  if (yz2 < 0 || !Number.isFinite(yz2)) return null;
  return Math.sqrt(yz2);
}

/**
 * Same shape as `volAdjMomentum` but uses Yang-Zhang OHLC volatility as the
 * denominator instead of close-to-close stdev. If OHLC fields are missing or
 * the YZ call returns null, falls back to `volAdjMomentum` on the close series.
 *
 * The volatility is estimated over the trailing `volWindow` bars (default 14),
 * which is short enough to reflect the current regime but long enough to be
 * numerically stable. The MOMENTUM return itself is still measured over the
 * `[t - tPast, t - tSkip]` window — only the denominator changes.
 */
export function volAdjMomentumYZ(
  bars: OhlcBar[],
  tPast = 252,
  tSkip = 21,
  volWindow = 14,
): number | null {
  if (tPast <= tSkip) throw new Error("tPast must be > tSkip");
  if (!Array.isArray(bars) || bars.length === 0) return null;
  // Validate OHLC shape on the tail (cheap; if the shape is off, fall back).
  const closes: number[] = new Array(bars.length);
  let shapeOk = true;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (
      !b ||
      typeof b.open !== "number" ||
      typeof b.high !== "number" ||
      typeof b.low !== "number" ||
      typeof b.close !== "number"
    ) {
      shapeOk = false;
      break;
    }
    closes[i] = b.close;
  }
  if (!shapeOk) {
    const c = bars.map((b) => (b as { close?: number })?.close ?? NaN);
    return volAdjMomentum(c, tPast, tSkip);
  }
  if (closes.length <= tPast) return null;
  const end = closes.length - 1 - tSkip;
  const start = closes.length - 1 - tPast;
  if (start < 0 || end <= start) return null;
  const priceStart = closes[start];
  const priceEnd = closes[end];
  if (priceStart <= 0 || priceEnd <= 0) return null;
  const totalReturn = priceEnd / priceStart - 1;
  const sigma = yangZhangVolatility(bars, volWindow);
  if (sigma === null || sigma === 0) {
    return volAdjMomentum(closes, tPast, tSkip);
  }
  return totalReturn / sigma;
}

/**
 * Golden Cross regime check: last close > 200-SMA AND 50-SMA > 200-SMA.
 * Both conditions must hold; either failure returns false. Null when
 * insufficient history to compute the 200-SMA.
 */
export function goldenCross(closes: number[]): boolean | null {
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  if (sma50 === null || sma200 === null) return null;
  const last = closes[closes.length - 1];
  return last > sma200 && sma50 > sma200;
}

/**
 * Convenience: 20-day Donchian breakout on today's bar. True when today's close
 * strictly exceeds the max close of the prior n bars (exclusive of today).
 * Using strictly-greater avoids no-op re-signals on flat consolidations.
 */
export function isDonchianBreakout(closes: number[], n = 20): boolean | null {
  if (closes.length < n + 1) return null;
  const prior = closes.slice(-1 - n, -1);
  let hi = -Infinity;
  for (const c of prior) if (c > hi) hi = c;
  return closes[closes.length - 1] > hi;
}

/**
 * Typical intraday cumulative-volume curve for NSE cash-equity segment.
 * The market runs 09:15–15:30 IST (375 minutes). Volume is U-shaped: heavy at
 * the open, thin midday, heavy into the close. Numbers below are rough anchors
 * distilled from published Indian-equity intraday studies + Zerodha aggregate
 * charts — good enough to normalize day-volume-so-far to a full-day equivalent.
 *
 * Returns the fraction (0.0–1.0) of an average day's volume expected to have
 * accumulated by a given IST time-of-day. Anchored points; linear-interpolated
 * between them. Callers pass the current Date (UTC); we convert to IST here.
 *
 * Before 09:15 or after 15:30, returns 0 or 1 respectively.
 */
const IST_INTRADAY_ANCHORS: { hhmm: number; frac: number }[] = [
  { hhmm: 9 * 60 + 15, frac: 0.00 },   // market open
  { hhmm: 10 * 60 + 0,  frac: 0.20 },  // ~20% of day is done in the first 45 min
  { hhmm: 11 * 60 + 0,  frac: 0.33 },
  { hhmm: 12 * 60 + 0,  frac: 0.42 },
  { hhmm: 13 * 60 + 0,  frac: 0.50 },
  { hhmm: 14 * 60 + 0,  frac: 0.60 },
  { hhmm: 15 * 60 + 0,  frac: 0.74 },
  { hhmm: 15 * 60 + 15, frac: 0.88 },  // "auction-preparation" push
  { hhmm: 15 * 60 + 30, frac: 1.00 },  // close
];

/** Get IST minutes-since-midnight from a UTC Date. */
function istMinutesFromUtc(d: Date): number {
  const utcMs = d.getTime();
  const istMs = utcMs + 5.5 * 3600_000;
  const ist = new Date(istMs);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

export function intradayVolumeFraction(now: Date = new Date()): number {
  const t = istMinutesFromUtc(now);
  if (t <= IST_INTRADAY_ANCHORS[0].hhmm) return 0;
  if (t >= IST_INTRADAY_ANCHORS[IST_INTRADAY_ANCHORS.length - 1].hhmm) return 1;
  for (let i = 1; i < IST_INTRADAY_ANCHORS.length; i++) {
    const a = IST_INTRADAY_ANCHORS[i - 1];
    const b = IST_INTRADAY_ANCHORS[i];
    if (t >= a.hhmm && t <= b.hhmm) {
      const span = b.hhmm - a.hhmm;
      if (span === 0) return b.frac;
      const w = (t - a.hhmm) / span;
      return a.frac + w * (b.frac - a.frac);
    }
  }
  return 1;
}

/**
 * True iff the current IST time is within market hours (09:15–15:30 IST).
 * Used to decide whether to apply intraday extrapolation to the volume filter.
 * Outside market hours the day_volume in ohlc_intraday is the full session's
 * volume already, so no scaling is needed.
 */
export function isDuringMarketHours(now: Date = new Date()): boolean {
  const t = istMinutesFromUtc(now);
  return t >= 9 * 60 + 15 && t <= 15 * 60 + 30;
}

