import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { BENCHMARK_SYMBOL, loadBenchmarkSeries, compareToBenchmark } from "@/lib/benchmark";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync("db/schema.sql", "utf8"));
  return db;
}

const TOKEN = 6199553;

function seedUniverse(db: Database.Database) {
  db.prepare(
    `INSERT INTO index_universe
       (index_name, symbol, exchange, isin, tradingsymbol, instrument_token, as_of_date)
     VALUES ('NIFTY 50', ?, 'NSE', 'INF205K01LO7', ?, ?, '2024-01-01')`,
  ).run(BENCHMARK_SYMBOL, BENCHMARK_SYMBOL, TOKEN);
}

/** Insert closes on consecutive days starting at `start`. */
function seedBars(db: Database.Database, start: string, closes: number[], token = TOKEN) {
  const stmt = db.prepare(
    `INSERT INTO ohlc_daily
       (instrument_token, trade_date, open, high, low, close, volume, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, 1000, '2024-01-01T00:00:00Z')`,
  );
  const t0 = new Date(`${start}T00:00:00Z`).getTime();
  closes.forEach((c, i) => {
    const d = new Date(t0 + i * 86_400_000).toISOString().slice(0, 10);
    stmt.run(token, d, c, c, c, c);
  });
}

describe("loadBenchmarkSeries", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("returns null when the benchmark instrument isn't tracked", () => {
    expect(
      loadBenchmarkSeries(db, { fromDate: "2024-01-01", toDate: "2024-12-31", startingRupees: 100_000 }),
    ).toBeNull();
  });

  it("returns null with fewer than two bars in the window", () => {
    seedUniverse(db);
    seedBars(db, "2024-01-01", [100]);
    expect(
      loadBenchmarkSeries(db, { fromDate: "2024-01-01", toDate: "2024-12-31", startingRupees: 100_000 }),
    ).toBeNull();
  });

  it("normalizes to the requested starting capital", () => {
    seedUniverse(db);
    seedBars(db, "2024-01-01", [200, 210, 220, 230]);
    const s = loadBenchmarkSeries(db, {
      fromDate: "2024-01-01",
      toDate: "2024-12-31",
      startingRupees: 100_000,
    })!;
    expect(s.points[0].value_rupees).toBe(100_000);
    expect(s.points[3].value_rupees).toBeCloseTo(115_000, 6);
    expect(s.n_split_adjustments).toBe(0);
    expect(s.n_outlier_bars_dropped).toBe(0);
  });

  it("back-adjusts a 1:10 split so the series stays continuous", () => {
    // The real defect: IVZINNIFTY split 1:10 on 2026-07-31 and ohlc_daily is
    // unadjusted, so the raw series shows the Nifty 50 losing 90% in one day.
    seedUniverse(db);
    seedBars(db, "2026-07-27", [277813, 278651, 27650, 28058, 28097]);
    const s = loadBenchmarkSeries(db, {
      fromDate: "2026-07-01",
      toDate: "2026-08-31",
      startingRupees: 100_000,
    })!;
    expect(s.n_split_adjustments).toBe(1);
    // Total return must now be a plausible small number, not -90%.
    const totalPct = (s.points[s.points.length - 1].value_rupees / s.points[0].value_rupees - 1) * 100;
    expect(totalPct).toBeGreaterThan(0);
    expect(totalPct).toBeLessThan(5);
    // No adjacent day may move more than the split threshold post-adjustment.
    for (let i = 1; i < s.points.length; i++) {
      const r = Math.abs(s.points[i].value_rupees / s.points[i - 1].value_rupees - 1);
      expect(r).toBeLessThan(0.25);
    }
  });

  it("drops a spike-and-revert bad print", () => {
    // The real defect: a close of 284800 on 20 shares traded on 2024-02-19,
    // snapping back the next day.
    seedUniverse(db);
    seedBars(db, "2024-02-14", [242370, 244782, 284800, 247149, 246400]);
    const s = loadBenchmarkSeries(db, {
      fromDate: "2024-02-01",
      toDate: "2024-02-29",
      startingRupees: 100_000,
    })!;
    expect(s.n_outlier_bars_dropped).toBe(1);
    expect(s.n_bars).toBe(4);
    // seedBars lays the closes on consecutive calendar days, so the 284800
    // spike is the third one — that bar is gone, its neighbours are kept.
    expect(s.points.some((p) => p.date === "2024-02-16")).toBe(false);
    expect(s.points.some((p) => p.date === "2024-02-15")).toBe(true);
    expect(s.points.some((p) => p.date === "2024-02-17")).toBe(true);
    // No surviving point carries the spike's level.
    expect(s.points.every((p) => p.value_rupees / s.points[0].value_rupees < 1.08)).toBe(true);
  });

  it("keeps a genuine crash that does not revert", () => {
    // March 2020 shape: a big drop that keeps falling is real, not a bad print.
    seedUniverse(db);
    seedBars(db, "2024-03-01", [100, 100, 87, 80, 78, 79]);
    const s = loadBenchmarkSeries(db, {
      fromDate: "2024-03-01",
      toDate: "2024-03-31",
      startingRupees: 100_000,
    })!;
    expect(s.n_outlier_bars_dropped).toBe(0);
    expect(s.n_bars).toBe(6);
  });

  it("reports coverage against the wider universe's trading dates", () => {
    seedUniverse(db);
    // Benchmark trades 3 of 5 dates; another instrument covers all 5.
    seedBars(db, "2024-01-01", [100, 101, 102, 103, 104], 999);
    seedBars(db, "2024-01-01", [100, 101, 102]);
    const s = loadBenchmarkSeries(db, {
      fromDate: "2024-01-01",
      toDate: "2024-01-05",
      startingRupees: 100_000,
    })!;
    expect(s.n_bars).toBe(3);
    expect(s.coverage_pct).toBeCloseTo(60, 6);
  });
});

describe("compareToBenchmark", () => {
  it("returns null for a curve too short to compare", () => {
    const db = freshDb();
    seedUniverse(db);
    seedBars(db, "2024-01-01", [100, 101, 102]);
    expect(compareToBenchmark(db, [{ date: "2024-01-01", value_rupees: 100_000 }])).toBeNull();
  });

  it("derives the window and base from the strategy curve", () => {
    const db = freshDb();
    seedUniverse(db);
    seedBars(db, "2024-01-01", [100, 110, 120, 130]);
    const curve = [
      { date: "2024-01-01", value_rupees: 50_000 },
      { date: "2024-01-02", value_rupees: 55_000 },
      { date: "2024-01-03", value_rupees: 60_000 },
    ];
    const res = compareToBenchmark(db, curve)!;
    // Benchmark starts at the curve's own starting capital, and stops at the
    // curve's last date (the 4th bar is outside the window).
    expect(res.points[0].value_rupees).toBe(50_000);
    expect(res.points.length).toBe(3);
    expect(res.comparison.symbol).toBe(BENCHMARK_SYMBOL);
    // Strategy +20% vs benchmark +20% over the same dates.
    expect(res.comparison.relative!.excess_total_return_pct).toBeCloseTo(0, 6);
    expect(res.comparison.relative!.overlapping_periods).toBe(2);
  });
});
