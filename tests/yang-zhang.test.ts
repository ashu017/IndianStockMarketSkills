import { describe, it, expect } from "vitest";
import { yangZhangVolatility, type OhlcBar } from "@/lib/indicators";

/**
 * Seeded PRNG (mulberry32) so the "random walk" tests are deterministic across
 * runs. Vitest doesn't ship a seedable RNG and Math.random() would make these
 * tests flaky. Reference: https://stackoverflow.com/a/47593316
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller: turn a uniform PRNG into standard-normal draws. */
function makeNormal(rnd: () => number): () => number {
  return () => {
    const u1 = Math.max(rnd(), 1e-12);
    const u2 = rnd();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
}

/** Close-to-close daily-log-return sample stdev, for comparison. */
function closeToCloseStdev(bars: OhlcBar[]): number {
  const rets: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    rets.push(Math.log(bars[i].close / bars[i - 1].close));
  }
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  let sq = 0;
  for (const r of rets) sq += (r - m) * (r - m);
  return Math.sqrt(sq / (rets.length - 1));
}

describe("yangZhangVolatility", () => {
  it("returns 0 for a constant OHLC series (no variance anywhere)", () => {
    const bars: OhlcBar[] = [];
    for (let i = 0; i < 20; i++) {
      bars.push({ open: 100, high: 100, low: 100, close: 100 });
    }
    const sigma = yangZhangVolatility(bars, 14);
    expect(sigma).not.toBeNull();
    expect(sigma).toBeCloseTo(0, 12);
  });

  /**
   * Simulate one bar via a discrete Brownian motion of M sub-steps starting
   * from `open`, total intraday log-return volatility `intradaySigma`. Records
   * high = max path, low = min path, close = final path. This produces H/L
   * that are consistent with the diffusion — a requirement for the Rogers-
   * Satchell / Yang-Zhang estimators to be unbiased. Naively picking H/L as
   * open±wiggle would leave RS underestimating σ or overestimating it.
   */
  function simulateIntradayBar(
    open: number,
    intradaySigma: number,
    substeps: number,
    norm: () => number,
  ): { open: number; high: number; low: number; close: number } {
    const stepSigma = intradaySigma / Math.sqrt(substeps);
    let cumLog = 0;
    let hiLog = 0;
    let loLog = 0;
    for (let s = 0; s < substeps; s++) {
      cumLog += norm() * stepSigma;
      if (cumLog > hiLog) hiLog = cumLog;
      if (cumLog < loLog) loLog = cumLog;
    }
    return {
      open,
      high: open * Math.exp(hiLog),
      low: open * Math.exp(loLog),
      close: open * Math.exp(cumLog),
    };
  }

  it("recovers close-to-close stdev within tolerance when there are no overnight gaps", () => {
    // Build a diffusion-consistent bar series. Each bar's OPEN equals the
    // previous bar's CLOSE (no gap) and its H/L come from a 200-sub-step
    // intraday Brownian motion with total daily sigma = 0.01. Under those
    // conditions:
    //   - overnight variance σ_o² = 0
    //   - open-to-close variance σ_c² ≈ 0.01² (unbiased over long enough N)
    //   - Rogers-Satchell σ_rs² ≈ 0.01² (unbiased by construction)
    // So YZ² ≈ 0·1 + k·σ² + (1−k)·σ² = σ², and CC should also ≈ σ².
    // Sample noise dominates: with 200 bars, sample-stdev SE ≈ 1/√(2·200)
    // ≈ 5%. Two dependent estimators from the same data should agree within
    // ~15% empirically; we test 20% to leave headroom.
    const rnd = mulberry32(42);
    const norm = makeNormal(rnd);
    const N_BARS = 200;
    const DAILY_SIGMA = 0.01;
    const SUBSTEPS = 200;
    const bars: OhlcBar[] = [];
    bars.push({ open: 100, high: 100, low: 100, close: 100 });
    let prev = 100;
    for (let i = 1; i < N_BARS + 1; i++) {
      const bar = simulateIntradayBar(prev, DAILY_SIGMA, SUBSTEPS, norm);
      bars.push(bar);
      prev = bar.close;
    }
    const sigmaYZ = yangZhangVolatility(bars, N_BARS);
    const sigmaCC = closeToCloseStdev(bars);
    expect(sigmaYZ).not.toBeNull();
    const rel = Math.abs(sigmaYZ! - sigmaCC) / sigmaCC;
    // Empirically ~2-8% on this seed; leaving generous margin at 20%.
    expect(rel).toBeLessThan(0.20);
  });

  it("is meaningfully higher than close-to-close stdev when bars have wide intraday range that CC misses (whipsaw + overnight gaps)", () => {
    // The scenario where YZ shines: bars with WIDE intraday range (big H-L)
    // but close ≈ open (whipsaw days), plus overnight gaps. Close-to-close
    // sees only the gap-driven close deltas; it can't see the intraday
    // whipsaw at all. YZ captures both:
    //   - overnight variance via σ_o²
    //   - the wide range via Rogers-Satchell σ_rs²  (drift-free, so whipsaw
    //     days that close near their open still contribute variance)
    // For a random-walk driftless simulation σ_rs ≈ σ_c, so we can't just
    // simulate a diffusion — we have to construct explicit whipsaw bars.
    const rnd = mulberry32(7);
    const norm = makeNormal(rnd);
    const N_BARS = 60;
    const GAP_SIGMA = 0.01; // 1% overnight jumps
    const INTRA_HALF_RANGE = 0.03; // ±3% intraday excursion
    const bars: OhlcBar[] = [];
    bars.push({ open: 100, high: 100, low: 100, close: 100 });
    let prev = 100;
    for (let i = 1; i < N_BARS + 1; i++) {
      const open = prev * Math.exp(norm() * GAP_SIGMA);
      // Whipsaw: high ~+3% above open, low ~-3% below open, close ≈ open.
      // Small close deviation so σ_c² > 0 (but tiny).
      const high = open * Math.exp(INTRA_HALF_RANGE);
      const low = open * Math.exp(-INTRA_HALF_RANGE);
      const close = open * Math.exp(norm() * 0.001); // near-zero intraday drift
      bars.push({ open, high, low, close });
      prev = close;
    }
    const sigmaYZ = yangZhangVolatility(bars, N_BARS);
    const sigmaCC = closeToCloseStdev(bars);
    expect(sigmaYZ).not.toBeNull();
    // CC ≈ σ_o (overnight only, since close ≈ open eliminates the intraday
    // component from close-to-close). YZ additionally credits σ_rs² from
    // the wide H-L range → YZ should be *much* larger. Empirically this
    // seed gives YZ/CC ≈ 2-3×; the 1.5× threshold is conservative.
    expect(sigmaYZ!).toBeGreaterThan(sigmaCC * 1.5);
  });

  it("returns null when fewer than window+1 bars supplied", () => {
    const bars: OhlcBar[] = [];
    for (let i = 0; i < 14; i++) {
      bars.push({ open: 100, high: 101, low: 99, close: 100 });
    }
    expect(yangZhangVolatility(bars, 14)).toBeNull();
  });

  it("returns null when any bar has high < low", () => {
    const bars: OhlcBar[] = [];
    for (let i = 0; i < 20; i++) {
      bars.push({ open: 100, high: 101, low: 99, close: 100 });
    }
    // Corrupt one bar so high < low.
    bars[10] = { open: 100, high: 98, low: 99, close: 100 };
    expect(yangZhangVolatility(bars, 14)).toBeNull();
  });
});
