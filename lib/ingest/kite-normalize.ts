import { rupeesToPrice, rupeesToPaise } from "@/lib/money";
import type { Exchange, StockMetaRow } from "@/lib/types";
import type { SnapshotHolding } from "./writer";

/**
 * A raw holding as returned by the Kite Connect `/portfolio/holdings` API (and
 * the kite MCP `get_holdings` tool). Prices are in rupees (floats). We only rely
 * on the fields below; the real payload carries more, which we ignore.
 */
export interface RawKiteHolding {
  tradingsymbol: string;
  exchange: string;
  quantity: number;
  average_price: number; // rupees
  last_price: number; // rupees
  close_price: number; // rupees
  isin?: string;
  company_name?: string;
  sector?: string;
}

export interface NormalizedKiteHoldings {
  meta: StockMetaRow[];
  holdings: SnapshotHolding[];
}

function normalizeExchange(raw: string): Exchange {
  return raw === "BSE" ? "BSE" : "NSE";
}

/**
 * Pure function: convert raw Kite holdings into the `meta` + `holdings` arrays of
 * the writer payload, converting rupee prices to minor units:
 *   avg_price   -> rupeesToPrice  (x10000)
 *   ltp/close   -> rupeesToPaise  (x100)
 * No I/O, no mutation of the input.
 */
export function normalizeKiteHoldings(
  raw: RawKiteHolding[],
): NormalizedKiteHoldings {
  const meta: StockMetaRow[] = [];
  const holdings: SnapshotHolding[] = [];

  for (const h of raw) {
    const exchange = normalizeExchange(h.exchange);
    meta.push({
      symbol: h.tradingsymbol,
      exchange,
      isin: h.isin ?? null,
      company: h.company_name ?? null,
      sector: h.sector ?? null,
    });
    holdings.push({
      symbol: h.tradingsymbol,
      exchange,
      qty: h.quantity,
      avg_price: rupeesToPrice(h.average_price),
      ltp: rupeesToPaise(h.last_price),
      close_price: rupeesToPaise(h.close_price),
    });
  }

  return { meta, holdings };
}
