import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { test, expect } from "vitest";
import { writeAnalysis, type AnalysisPayload } from "@/lib/ingest/analysis-writer";

function db() {
  const d = new Database(":memory:");
  d.exec(readFileSync("db/schema.sql", "utf8"));
  return d;
}

const payload: AnalysisPayload = {
  isin: "INE467B01029",
  asOfDate: "2026-07-21",
  fundamentals: {
    pe: 15.2, pb: null, roe: 51.8, roce: 63.0, debt_equity: 0.09,
    sales_growth_3y: 8.0, profit_growth_3y: 10.0, div_yield: 2.84,
    market_cap: 814737 * 1e7 * 100, promoter_holding: 71.8,
    source: "screener.in", source_url: "https://www.screener.in/company/TCS/",
    fetch_status: "ok",
  },
  extra: [{ metric_key: "opm", value_num: 24.5, unit: "%" }],
  peers: [
    { peer_symbol: "INFY", peer_company: "Infosys", pe: 14.7, roe: 40.0, roce: 39.9, sales_growth: 13.4 },
  ],
  analysis: {
    narrative: "High-quality IT compounder.", verdict: "HOLD", confidence: "High",
    model_version: "test", prompt_version: "v1",
  },
};

test("writes all four tables and is idempotent", () => {
  const d = db();
  writeAnalysis(d, payload);
  writeAnalysis(d, payload);
  expect((d.prepare("SELECT COUNT(*) c FROM fundamentals").get() as any).c).toBe(1);
  expect((d.prepare("SELECT COUNT(*) c FROM fundamentals_extra").get() as any).c).toBe(1);
  expect((d.prepare("SELECT COUNT(*) c FROM peers").get() as any).c).toBe(1);
  const a = d.prepare("SELECT * FROM analysis WHERE isin=?").get("INE467B01029") as any;
  expect(a.verdict).toBe("HOLD");
  expect(a.confidence).toBe("High");
});

test("fetch_status=failed still records a row without crashing", () => {
  const d = db();
  writeAnalysis(d, { ...payload, fundamentals: { ...payload.fundamentals, fetch_status: "failed", pe: null } });
  expect((d.prepare("SELECT fetch_status FROM fundamentals").get() as any).fetch_status).toBe("failed");
});
