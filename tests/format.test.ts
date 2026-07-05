import { test, expect } from "vitest";
import { inr, pct } from "@/components/ui/format";

test("formats INR with Indian grouping", () => {
  expect(inr(770587)).toBe("₹7,70,587");
});

test("rounds INR to whole rupees", () => {
  expect(inr(1234.56)).toBe("₹1,235");
  expect(inr(0)).toBe("₹0");
});

test("pct is signed with two decimals", () => {
  expect(pct(8.24)).toBe("+8.24%");
  expect(pct(0)).toBe("+0.00%");
  expect(pct(-3.1)).toBe("-3.10%");
});
