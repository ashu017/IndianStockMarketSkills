import type { Grade } from "./types";

// Versioned so retuning doesn't silently change the meaning of past "as of" views.
export const THRESHOLDS_VERSION = "v1";

// [good, fair] boundaries. For "lower is better" metrics: value <= good → Good,
// <= fair → Fair, else Weak. For "higher is better" (roe/roce/nim): reversed.
// Sector key falls back to "default" when a sector-specific set is absent.
type Bounds = [number, number];
const HIGHER_IS_BETTER = new Set(["roe", "roce", "nim", "sales_growth_3y", "profit_growth_3y"]);

const THRESHOLDS: Record<string, Record<string, Bounds>> = {
  default: {
    pe: [20, 35],
    pb: [3, 6],
    debt_equity: [0.5, 1],
    roe: [15, 10],
    roce: [15, 10],
    sales_growth_3y: [15, 8],
    profit_growth_3y: [15, 8],
    promoter_holding: [50, 30],
  },
  Banking: {
    pe: [18, 25],
    gross_npa: [1.5, 3],
    net_npa: [0.5, 1],
    nim: [3.5, 3],
    roe: [15, 10],
  },
};

export function gradeMetric(sector: string, key: string, value: number): Grade {
  const set = THRESHOLDS[sector] ?? THRESHOLDS.default;
  const bounds = set[key] ?? THRESHOLDS.default[key];
  if (!bounds) return "Fair";
  const [good, fair] = bounds;
  if (HIGHER_IS_BETTER.has(key)) {
    return value >= good ? "Good" : value >= fair ? "Fair" : "Weak";
  }
  return value <= good ? "Good" : value <= fair ? "Fair" : "Weak";
}
