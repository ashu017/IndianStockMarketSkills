// Display formatters. Safe to run server-side (used by Server Components).

// Indian-grouped rupee amount with no decimals, e.g. inr(770587) === "₹7,70,587".
export const inr = (n: number): string =>
  "₹" +
  new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(
    Math.round(n),
  );

// Signed percentage with two decimals, e.g. pct(8.24) === "+8.24%", pct(-3.1) === "-3.10%".
export const pct = (n: number): string => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
