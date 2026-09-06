/**
 * Fetches per-quarter Sales / Net Profit / EPS from Screener's company page
 * "Quarterly Results" table. Unlike lib/screener-chart.ts (which uses
 * Screener's JSON chart API), there is no JSON endpoint for quarterly Net
 * Profit — only Price, "Quarter Sales", and EPS are exposed as chart metrics.
 * This regex-parses the rendered HTML table instead, validated against a
 * live RELIANCE fetch (13 quarters, June 2023 – June 2026 at time of writing).
 *
 * Screener's free/unauthenticated page only shows the last ~13 quarters —
 * that's the ceiling on how far back this can go, regardless of how much
 * OHLC price history is cached locally.
 */

const BASE = "https://www.screener.in";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export interface QuarterlyResultRow {
  quarter_end_date: string; // YYYY-MM-DD
  sales_cr: number | null;
  net_profit_cr: number | null;
  eps: number | null;
}

/** Screener display string → number, or null for missing ("—", "", N/A).
 * Duplicated from lib/screener-parse.ts's parseScreenerNumber rather than
 * imported, since that module's sibling parseCroreToPaise assumes a single
 * scalar value, not a table row — keeping this self-contained avoids coupling
 * two different parsing shapes. */
function parseScreenerNumber(s: string | null | undefined): number | null {
  if (s == null) return null;
  const cleaned = s.replace(/[₹%×,\s]/g, "").replace(/Cr\.?/gi, "");
  if (cleaned === "" || cleaned === "—" || /^n\/?a$/i.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function extractSection(html: string, startLabel: string): string | null {
  const start = html.indexOf(startLabel);
  if (start === -1) return null;
  const end = html.indexOf("<h2", start + startLabel.length);
  return html.slice(start, end === -1 ? undefined : end);
}

function extractDateKeys(section: string): string[] {
  return [...section.matchAll(/data-date-key="(\d{4}-\d{2}-\d{2})"/g)].map((m) => m[1]);
}

function extractRow(section: string, label: string): (number | null)[] | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(">\\s*" + escaped + "\\s*(&nbsp;|<)");
  const m = re.exec(section);
  if (!m) return null;
  const labelIdx = m.index;
  const rowStart = section.lastIndexOf("<tr", labelIdx);
  const rowEnd = section.indexOf("</tr>", labelIdx);
  if (rowStart === -1 || rowEnd === -1) return null;
  const row = section.slice(rowStart, rowEnd);
  const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m2) => m2[1]);
  const valueCells = cells.slice(1); // first <td> is the row's own label cell
  return valueCells.map((c) => parseScreenerNumber(c.replace(/<[^>]+>/g, "").trim()));
}

/** Fetch the last ~13 quarters of Sales/Net Profit/EPS for a symbol.
 * Tries consolidated first (matches this app's existing fundamentals
 * convention), falls back to standalone if consolidated isn't published. */
export async function fetchQuarterlyResults(symbol: string): Promise<QuarterlyResultRow[] | null> {
  for (const view of ["consolidated/", ""]) {
    const res = await fetch(`${BASE}/company/${encodeURIComponent(symbol.toUpperCase())}/${view}`, {
      headers: { "User-Agent": UA },
    });
    if (!res.ok) continue;
    const html = await res.text();
    const section = extractSection(html, "Quarterly Results");
    if (!section) continue;
    const dates = extractDateKeys(section);
    if (dates.length === 0) continue;
    const sales = extractRow(section, "Sales");
    const netProfit = extractRow(section, "Net Profit");
    const eps = extractRow(section, "EPS in Rs");
    return dates.map((d, i) => ({
      quarter_end_date: d,
      sales_cr: sales?.[i] ?? null,
      net_profit_cr: netProfit?.[i] ?? null,
      eps: eps?.[i] ?? null,
    }));
  }
  return null;
}
