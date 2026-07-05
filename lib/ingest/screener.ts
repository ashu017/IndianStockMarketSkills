import { z } from "zod";

/**
 * Zod schema for the subset of Screener.in fundamentals we persist. All numeric
 * fields are nullable (a company may simply not report a metric). `.passthrough()`
 * keeps any additional extracted metrics so the caller can fan them into
 * `fundamentals_extra` without losing data.
 */
export const FundamentalsSchema = z
  .object({
    pe: z.number().nullable(),
    pb: z.number().nullable(),
    roe: z.number().nullable(),
    roce: z.number().nullable(),
    debt_equity: z.number().nullable(),
    sales_growth_3y: z.number().nullable(),
    profit_growth_3y: z.number().nullable(),
    div_yield: z.number().nullable(),
    market_cap: z.number().nullable(),
    promoter_holding: z.number().nullable(),
  })
  .partial()
  .passthrough();

export type Fundamentals = z.infer<typeof FundamentalsSchema>;

export type FetchFundamentalsResult =
  | { status: "ok"; data: Fundamentals }
  | { status: "failed"; data: null };

/**
 * Parse a Screener.in HTML page into a raw fundamentals object.
 *
 * NOTE: This is a documented stub. The real CSS/DOM selectors are wired against
 * live Screener HTML later (see plan Task 5 "known simplifications"). Until then
 * this throws when given no HTML and returns an empty object otherwise, so the
 * validation + status contract below is fully exercised and testable.
 */
function parseScreenerHtml(html: string): unknown {
  if (!html || html.trim().length === 0) {
    throw new Error("empty html");
  }
  // TODO: extract real metrics from `html` (e.g. cheerio selectors on the
  // ratios/company header blocks). Returning {} keeps every field null/absent,
  // which the schema accepts as a valid (empty) fundamentals object.
  return {};
}

/**
 * Fetch + validate fundamentals for an ISIN. NEVER throws: any parse or
 * validation failure is caught and degraded to `{ status: 'failed', data: null }`
 * so the ingestion holdings path is never interrupted by a bad Screener response.
 *
 * @param isin  the instrument ISIN (used by the real fetcher to build the URL)
 * @param html  pre-fetched Screener HTML (the caller performs the network fetch)
 */
export async function fetchFundamentals(
  isin: string,
  html?: string,
): Promise<FetchFundamentalsResult> {
  try {
    void isin; // reserved for the live fetcher/URL builder
    const raw = parseScreenerHtml(html ?? "");
    const data = FundamentalsSchema.parse(raw);
    return { status: "ok", data };
  } catch {
    return { status: "failed", data: null };
  }
}
