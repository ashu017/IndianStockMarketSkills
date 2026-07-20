import "server-only";

// Screener's chart JSON endpoint (same one the screener MCP uses under the hood).
// Metric keys that are known to work: "Price-DMA50-Volume", "Quarter Sales", "EPS".
const BASE = "https://www.screener.in";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export type ChartMetricKey = "price" | "sales" | "eps";

const METRIC_QUERY: Record<ChartMetricKey, string> = {
  price: "Price-DMA50-Volume",
  sales: "Quarter Sales",
  eps: "EPS",
};

export type ChartRange = "1Y" | "3Y" | "5Y" | "ALL";

const RANGE_DAYS: Record<ChartRange, number> = {
  "1Y": 365,
  "3Y": 1095,
  "5Y": 1825,
  ALL: 10000,
};

export interface ChartSeries {
  metric: string;
  points: { date: string; value: number }[];
}

// company_id cache (module-scoped; fine for a local single-user app).
const idCache = new Map<string, number>();

/** Resolve Screener's numeric company_id from a trading symbol (via the company page). */
export async function resolveCompanyId(symbol: string): Promise<number | null> {
  const key = symbol.toUpperCase();
  const cached = idCache.get(key);
  if (cached) return cached;
  for (const view of ["consolidated/", ""]) {
    const res = await fetch(`${BASE}/company/${encodeURIComponent(key)}/${view}`, {
      headers: { "User-Agent": UA },
    });
    if (!res.ok) continue;
    const html = await res.text();
    const m = html.match(/\/company\/(?:[a-z]+\/)?(\d+)\//);
    if (m) {
      const id = Number(m[1]);
      idCache.set(key, id);
      return id;
    }
  }
  return null;
}

/** Fetch one chart metric for a symbol. Returns the requested series only
 * (for "price" that means the Price line; DMA/Volume are dropped). */
export async function fetchChart(
  symbol: string,
  metric: ChartMetricKey,
  range: ChartRange,
): Promise<ChartSeries | null> {
  const companyId = await resolveCompanyId(symbol);
  if (!companyId) return null;

  const q = encodeURIComponent(METRIC_QUERY[metric]);
  const days = RANGE_DAYS[range];
  const res = await fetch(
    `${BASE}/api/company/${companyId}/chart/?q=${q}&days=${days}&consolidated=true`,
    { headers: { "User-Agent": UA, "X-Requested-With": "XMLHttpRequest" } },
  );
  if (!res.ok) return null;

  const json = (await res.json()) as {
    datasets?: { metric: string; values: [string, string][] }[];
  };
  // Pick the primary series: "Price" for price, else the first dataset.
  const wanted =
    metric === "price"
      ? json.datasets?.find((d) => d.metric === "Price")
      : json.datasets?.[0];
  if (!wanted) return null;

  return {
    metric: wanted.metric,
    points: wanted.values
      .map(([date, v]) => ({ date, value: Number(v) }))
      .filter((p) => Number.isFinite(p.value)),
  };
}
