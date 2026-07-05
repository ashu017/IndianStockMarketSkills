import { test, expect } from "vitest";
import {
  paiseToRupees,
  rupeesToPaise,
  priceToRupees,
  rupeesToPrice,
} from "@/lib/money";

test("round-trips rupees and paise", () => {
  expect(rupeesToPaise(770587)).toBe(77058700);
  expect(paiseToRupees(77058700)).toBe(770587);
});

test("price scale is x10000", () => {
  expect(rupeesToPrice(3845.2)).toBe(38452000);
  expect(priceToRupees(38452000)).toBe(3845.2);
});
