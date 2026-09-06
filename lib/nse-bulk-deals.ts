/**
 * Fetches NSE's bulk-deals CSV export directly, for the daily refresh job
 * (scripts/refresh-bulk-deals.ts). Same session-cookie warmup dance as
 * lib/nse-announcements.ts — NSE returns a geo-block HTML page, not JSON/CSV,
 * for any API call that arrives without cookies from a real page visit first.
 *
 * Dead ends already ruled out, so nobody re-tries them: the static
 * archives.nseindia.com/content/equities/bulk.csv works but is a single-day
 * snapshot with zero history, and /api/historical/bulk-deals (no "OR") returns
 * HTTP 200 with the geo-block page rather than an error.
 *
 * The endpoint caps each call at 365 days, which is why the original 3-year
 * backfill was three sequential calls. The daily job only ever asks for a
 * short trailing window, so one call is always enough.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const WARMUP_URL = "https://www.nseindia.com/companies-listing/corporate-filings-announcements";
const REFERER = "https://www.nseindia.com/market-data/large-deals";
const API_BASE = "https://www.nseindia.com/api/historicalOR/bulk-block-short-deals";

/** NSE's date params are DD-MM-YYYY, unlike the DD-MMM-YYYY it emits in the
 * CSV body itself — don't reuse the CSV's own format here. */
export function toNseDateParam(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${d.getUTCFullYear()}`;
}

async function warmupCookieHeader(): Promise<string> {
  const res = await fetch(WARMUP_URL, { headers: { "User-Agent": UA } });
  const setCookies = res.headers.getSetCookie?.() ?? [];
  return setCookies.map((c) => c.split(";")[0]).join("; ");
}

export type DealOptionType = "bulk_deals" | "block_deals";

/**
 * Raw CSV text for the given window (params are DD-MM-YYYY). Throws rather
 * than returning partial data — a caller writing into the DB needs to know the
 * difference between "no deals in this window" (valid empty CSV) and "NSE
 * handed us a block page" (must not be treated as zero deals).
 */
export async function fetchBulkDealsCsv(
  fromDDMMYYYY: string,
  toDDMMYYYY: string,
  optionType: DealOptionType = "bulk_deals",
): Promise<string> {
  const cookieHeader = await warmupCookieHeader();
  const url = `${API_BASE}?optionType=${optionType}&from=${fromDDMMYYYY}&to=${toDDMMYYYY}&csv=true`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "*/*",
      Referer: REFERER,
      Cookie: cookieHeader,
    },
  });
  if (!res.ok) throw new Error(`NSE bulk-deals fetch failed: HTTP ${res.status} for ${fromDDMMYYYY}..${toDDMMYYYY}`);
  const text = await res.text();

  // The geo-block/error path also returns HTTP 200, so status alone proves
  // nothing — assert the body actually looks like the expected CSV.
  if (/^\s*</.test(text)) {
    throw new Error(
      `NSE returned HTML, not CSV (geo-block or session rejected) for ${fromDDMMYYYY}..${toDDMMYYYY}`,
    );
  }
  const firstLine = text.replace(/^﻿/, "").split("\n")[0] ?? "";
  if (!/symbol/i.test(firstLine) || !/client\s*name/i.test(firstLine)) {
    throw new Error(`Unexpected CSV header from NSE: ${JSON.stringify(firstLine.slice(0, 200))}`);
  }
  return text;
}
