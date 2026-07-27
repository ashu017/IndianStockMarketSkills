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
