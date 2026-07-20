import { test, expect } from "vitest";
import { parseScreenerNumber, parseCroreToPaise } from "@/lib/screener-parse";

test("parses plain and suffixed ratio strings", () => {
  expect(parseScreenerNumber("15.2")).toBe(15.2);
  expect(parseScreenerNumber("2.84 %")).toBe(2.84);
  expect(parseScreenerNumber("63.0 %")).toBe(63.0);
  expect(parseScreenerNumber("1,234.5")).toBe(1234.5);
  expect(parseScreenerNumber("—")).toBeNull();
  expect(parseScreenerNumber("")).toBeNull();
  expect(parseScreenerNumber(undefined)).toBeNull();
});

test("parses market cap crore string to paise", () => {
  expect(parseCroreToPaise("₹ 8,14,737 Cr.")).toBe(814737 * 1e7 * 100);
  expect(parseCroreToPaise("—")).toBeNull();
});
