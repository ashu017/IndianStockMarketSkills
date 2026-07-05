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

// Suffix applied to the numeric display string, per metric.
const PERCENT_KEYS = new Set([
  "roe",
  "roce",
  "sales_growth_3y",
  "profit_growth_3y",
  "div_yield",
  "promoter_holding",
]);
const RATIO_KEYS = new Set(["pe", "pb", "debt_equity"]);

function suffixFor(key: string): string {
  if (PERCENT_KEYS.has(key)) return "%";
  if (RATIO_KEYS.has(key)) return "×";
  return "";
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
      value: `${value}${suffixFor(key)}`,
      grade: gradeMetric(sector, key, value),
    });
  }

  for (const e of extra) {
    if (e.value_num == null) continue;
    items.push({
      label: e.metric_key,
      value: `${e.value_num}${e.unit ?? ""}`,
      grade: gradeMetric(sector, e.metric_key, e.value_num),
    });
  }

  return items;
}
