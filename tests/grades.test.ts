import { test, expect } from "vitest";
import { gradeMetric, THRESHOLDS_VERSION } from "@/lib/grades";

test("higher-is-better metric grades correctly", () => {
  expect(gradeMetric("IT", "roe", 50)).toBe("Good");
  expect(gradeMetric("IT", "roe", 12)).toBe("Fair");
  expect(gradeMetric("IT", "roe", 5)).toBe("Weak");
});

test("lower-is-better metric grades correctly", () => {
  expect(gradeMetric("default", "debt_equity", 0.3)).toBe("Good");
  expect(gradeMetric("default", "debt_equity", 0.8)).toBe("Fair");
  expect(gradeMetric("default", "debt_equity", 2)).toBe("Weak");
});

test("sector-specific thresholds apply (bank NPA)", () => {
  expect(gradeMetric("Banking", "gross_npa", 1)).toBe("Good");
  expect(gradeMetric("Banking", "gross_npa", 4)).toBe("Weak");
});

test("version is exposed", () => {
  expect(THRESHOLDS_VERSION).toBe("v1");
});
