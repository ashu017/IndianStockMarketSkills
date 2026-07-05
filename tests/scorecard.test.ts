import { test, expect } from "vitest";
import { buildScorecard } from "@/components/deepdive/scorecard-data";

test("grades a metric by sector", () => {
  const items = buildScorecard("IT", { pe: 28.6, roe: 50.1 }, []);
  const roe = items.find((i) => i.label === "ROE");
  expect(roe?.grade).toBe("Good");
  expect(roe?.value).toBe("50.1%");
});

test("skips null values", () => {
  const items = buildScorecard("IT", { pe: 28.6, roe: null, pb: null }, []);
  expect(items.find((i) => i.label === "ROE")).toBeUndefined();
  expect(items.find((i) => i.label === "P/B Ratio")).toBeUndefined();
  expect(items.find((i) => i.label === "P/E Ratio")).toBeDefined();
});

test("appends and grades fundamentals_extra rows", () => {
  const items = buildScorecard(
    "default",
    {},
    [{ metric_key: "sales_growth_3y", value_num: 20, unit: "%" }],
  );
  const extra = items.find((i) => i.label === "sales_growth_3y");
  expect(extra?.value).toBe("20%");
  expect(extra?.grade).toBe("Good");
});
