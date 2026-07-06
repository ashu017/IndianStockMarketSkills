import { normalizeKiteHoldings, type RawKiteHolding } from "./kite-normalize";
import type { SnapshotPayload } from "./writer";
import { paiseToRupees, priceToRupees, rupeesToPaise } from "@/lib/money";

/**
 * Pure function: turn raw Kite holdings into the full writer payload (minus
 * snapshotDate, which the ingest CLI stamps in IST). Totals are computed in
 * paise from the per-holding minor units so they stay consistent with the
 * stored raw rows. P&L math mirrors lib/derive.ts but aggregates to portfolio
 * level.
 */
export function buildPayload(
  userId: string,
  raw: RawKiteHolding[],
): Omit<SnapshotPayload, "snapshotDate"> {
  const { meta, holdings } = normalizeKiteHoldings(raw);

  let currentValue = 0; // paise
  let invested = 0; // paise
  let dayPnl = 0; // paise
  let winners = 0;
  let losers = 0;

  for (const h of holdings) {
    const investedRupees = h.qty * priceToRupees(h.avg_price);
    const currentRupees = h.qty * paiseToRupees(h.ltp);
    const dayRupees = h.qty * (paiseToRupees(h.ltp) - paiseToRupees(h.close_price));

    invested += rupeesToPaise(investedRupees);
    currentValue += rupeesToPaise(currentRupees);
    dayPnl += rupeesToPaise(dayRupees);

    if (currentRupees >= investedRupees) winners += 1;
    else losers += 1;
  }

  const totals: SnapshotPayload["totals"] = {
    current_value: currentValue,
    invested,
    total_pnl: currentValue - invested,
    day_pnl: dayPnl,
    holdings_count: holdings.length,
    winners,
    losers,
  };

  return { userId, meta, holdings, totals };
}
