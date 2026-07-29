import { gradeMetric } from "@/lib/grades";
import type { FundamentalItem } from "@/lib/types";

// Known core fundamentals columns → display label.
const LABELS: Record<string, string> = {
  pe: "P/E Ratio",
  pb: "P/B Ratio",
  roe: "ROE",
  roce: "ROCE",
  debt_equity: "Debt / Equity",
  sales_growth_3y: "Sales Growth (3Y)",
  profit_growth_3y: "Profit Growth (3Y)",
  div_yield: "Dividend Yield",
  promoter_holding: "Promoter Holding",
};

// Suffix + precision applied to the numeric display string, per metric.
// Percents get 1 decimal (e.g. "10.9%"); ratios get 2 decimals (e.g. "3.44×").
const PERCENT_KEYS = new Set([
  "roe",
  "roce",
  "sales_growth_3y",
  "profit_growth_3y",
  "div_yield",
  "promoter_holding",
]);
const RATIO_KEYS = new Set(["pe", "pb", "debt_equity"]);

function formatCoreValue(key: string, value: number): string {
  if (PERCENT_KEYS.has(key)) return `${value.toFixed(1)}%`;
  if (RATIO_KEYS.has(key)) return `${value.toFixed(2)}×`;
  return `${value}`;
}

function formatExtraValue(value: number, unit: string | null | undefined): string {
  const u = unit ?? "";
  // Recognized unit → sensible precision. Falls back to raw for unknown units.
  if (u === "%" || u === "pct" || u === "pct_points") return `${value.toFixed(1)}%`;
  if (u === "×" || u === "x") return `${value.toFixed(2)}×`;
  if (u === "days") return `${Math.round(value)} days`;
  if (u === "crore_rupees" || u === "cr") return `₹${value.toLocaleString("en-IN")} Cr`;
  // Numeric-only fields (no unit at all): tolerate very small numbers with 2 decimals,
  // otherwise round to integer.
  if (!u) return Math.abs(value) < 10 ? value.toFixed(2) : `${Math.round(value)}`;
  return `${value}${u}`;
}

type ExtraLike = { metric_key: string; value_num: number | null; unit?: string | null };

/**
 * Maps known core fundamentals columns + appended `fundamentals_extra` rows into
 * graded, display-ready FundamentalItem[]. Null values are skipped.
 */
export function buildScorecard(
  sector: string,
  core: Record<string, number | null>,
  extra: ExtraLike[],
): FundamentalItem[] {
  const items: FundamentalItem[] = [];

  for (const [key, value] of Object.entries(core)) {
    if (value == null || !(key in LABELS)) continue;
    items.push({
      label: LABELS[key],
      value: formatCoreValue(key, value),
      grade: gradeMetric(sector, key, value),
    });
  }

  for (const e of extra) {
    if (e.value_num == null) continue;
    items.push({
      label: e.metric_key,
      value: formatExtraValue(e.value_num, e.unit),
      grade: gradeMetric(sector, e.metric_key, e.value_num),
    });
  }

  return items;
}
