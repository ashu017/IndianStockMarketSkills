import type { EquityPoint } from "./metrics";

/**
 * The naive forward extrapolation drawn as a dashed line on the strategy's
 * portfolio-value chart.
 *
 * This is NOT a forecast. It continues the trailing average daily growth rate
 * implied by the curve's own endpoints, compounded forward — no volatility, no
 * mean reversion, no regime awareness. There is no forecasting model anywhere in
 * this codebase and this function is not one.
 *
 * It lives in its own module, free of "server-only", because the projection has
 * to be recomputed in the browser: LiveStrategyDetail re-marks the last actual
 * point against live prices, and a dashed line still hanging off the stale value
 * would visibly disagree with the solid one it is supposed to continue.
 */

/** Days of extrapolation. One quarter — far enough to show the slope, short
 *  enough that nobody mistakes it for a plan. */
export const PROJECTION_DAYS = 90;

const MS_PER_DAY = 86_400_000;

/**
 * @param history Chronological actual points. Fewer than 2 yields no
 *   projection — one point implies no rate to continue.
 * @returns Points starting at history's own last point, so the two lines meet
 *   rather than jumping. Empty when there is nothing to project from.
 */
export function projectEquity(history: EquityPoint[], days = PROJECTION_DAYS): EquityPoint[] {
  if (history.length < 2) return [];

  const firstPoint = history[0];
  const lastPoint = history[history.length - 1];

  const spanDays = Math.max(
    1,
    (new Date(lastPoint.date).getTime() - new Date(firstPoint.date).getTime()) / MS_PER_DAY,
  );
  // Guard both ends: a zero or negative value makes the ratio meaningless (and
  // a negative base fractionally powered is NaN), so flatline instead.
  const dailyRate =
    firstPoint.value_rupees > 0 && lastPoint.value_rupees > 0
      ? Math.pow(lastPoint.value_rupees / firstPoint.value_rupees, 1 / spanDays) - 1
      : 0;

  const projection: EquityPoint[] = [{ date: lastPoint.date, value_rupees: lastPoint.value_rupees }];
  const lastDate = new Date(lastPoint.date);
  let cursor = lastPoint.value_rupees;
  for (let i = 1; i <= days; i++) {
    cursor = cursor * (1 + dailyRate);
    projection.push({
      date: new Date(lastDate.getTime() + i * MS_PER_DAY).toISOString().slice(0, 10),
      value_rupees: cursor,
    });
  }
  return projection;
}
