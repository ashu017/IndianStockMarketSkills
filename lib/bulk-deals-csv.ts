import type Database from "better-sqlite3";

/**
 * Parsing and upsert for NSE's bulk-deals CSV export. Extracted from
 * scripts/ingest-bulk-deals.ts so the one-off CSV-directory ingester and the
 * daily refresh (scripts/refresh-bulk-deals.ts) can't drift apart — a parser
 * quirk fixed in one would otherwise silently persist in the other.
 *
 * No `server-only` import here (not even transitively): these run under plain
 * `npx tsx` as well as inside Next.js, and `db` is always passed in rather
 * than pulled from getDb().
 *
 * Quirks handled:
 *   - Headers have trailing spaces ("Date ", "Symbol ", ...).
 *   - Quantities are Indian-grouped ("3,41,431") INSIDE quotes — see
 *     splitCsvLine, which is load-bearing for column alignment.
 *   - is_institution is a keyword heuristic, not a verified classification.
 */

// Keyword-based institution heuristic, as scoped with the user: mutual funds,
// trusts, LLPs, foreign (Pte) entities, insurers, pension funds, and generic
// corporate-entity suffixes (Capital/Fund/Limited/Ltd/Pvt/Private). This will
// misclassify some individual-owned entities with a corporate wrapper as
// "institutional" and some genuinely institutional vehicles without any of
// these words as "individual" — it's a transparent rule, not a certain one.
export const INSTITUTION_RE =
  /\b(MUTUAL FUND|TRUST|LLP|PTE|INSURANCE|PENSION|CAPITAL|FUND|LIMITED|LTD|PVT|PRIVATE)\b/i;

export interface BulkDealRow {
  deal_date: string;
  symbol: string;
  security_name: string;
  client_name: string;
  side: "BUY" | "SELL";
  quantity: number | null;
  price: number | null;
}

function parseIndianNumber(s: string | undefined): number | null {
  if (s == null) return null;
  const cleaned = s.replace(/[",\s]/g, "");
  if (cleaned === "" || cleaned === "-") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** DD-MMM-YYYY ("26-AUG-2024") → YYYY-MM-DD. */
export function parseDealDate(s: string): string | null {
  const m = s.trim().match(/^(\d{2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const months: Record<string, string> = {
    JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
    JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
  };
  const mm = months[m[2].toUpperCase()];
  if (!mm) return null;
  return `${m[3]}-${mm}-${m[1]}`;
}

/** Quote-aware CSV line splitter. Load-bearing: quantity fields use Indian
 * comma grouping INSIDE quotes (e.g. "3,41,431") — a naive line.split(",")
 * would shred that into three fields and silently misalign every column
 * after it. Handles "" as an escaped quote inside a quoted field. */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  cells.push(cur.trim());
  return cells;
}

/** Parses CSV text (not a path) so the same function serves a file read from
 * disk and a response body fetched from NSE. */
export function parseBulkDealsCsv(text: string): BulkDealRow[] {
  const lines = text.replace(/^﻿/, "").split("\n").filter((l) => l.trim().length > 0); // strip BOM
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const idx = (name: string) => header.findIndex((h) => h.toLowerCase().startsWith(name.toLowerCase()));
  const iDate = idx("Date");
  const iSymbol = idx("Symbol");
  const iSecName = idx("Security Name");
  const iClient = idx("Client Name");
  const iSide = idx("Buy / Sell");
  const iQty = idx("Quantity");
  const iPrice = idx("Trade Price");

  const rows: BulkDealRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    if (cells.length < header.length) continue;
    const date = parseDealDate(cells[iDate] ?? "");
    const side = (cells[iSide] ?? "").toUpperCase();
    if (!date || (side !== "BUY" && side !== "SELL")) continue;
    rows.push({
      deal_date: date,
      symbol: cells[iSymbol] ?? "",
      security_name: cells[iSecName] ?? "",
      client_name: cells[iClient] ?? "",
      side,
      quantity: parseIndianNumber(cells[iQty]),
      price: parseIndianNumber(cells[iPrice]),
    });
  }
  return rows;
}

export interface UpsertResult {
  rows_seen: number;
  rows_inserted: number;
  rows_skipped_incomplete: number;
}

/**
 * Idempotent insert, relying on the table's
 * UNIQUE(deal_date, symbol, client_name, side, quantity, price) — so a daily
 * job may safely re-fetch an overlapping window without accumulating dupes.
 *
 * Rows missing quantity or price are dropped rather than inserted: SQLite
 * treats NULLs as DISTINCT in a UNIQUE index, so such a row would slip past
 * ON CONFLICT and duplicate on every overlapping re-fetch. They're also
 * unusable downstream (lib/bulk-deal-fifo.ts filters them out anyway), so
 * dropping them costs nothing and keeps re-runs genuinely idempotent.
 */
export function upsertBulkDeals(db: Database.Database, rows: BulkDealRow[]): UpsertResult {
  const stmt = db.prepare(
    `INSERT INTO bulk_deals(deal_date, symbol, security_name, client_name, side, quantity, price, is_institution, fetched_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(deal_date, symbol, client_name, side, quantity, price) DO NOTHING`,
  );
  const now = new Date().toISOString();
  let inserted = 0;
  let skipped = 0;

  const tx = db.transaction((batch: BulkDealRow[]) => {
    for (const r of batch) {
      if (r.quantity == null || r.price == null) {
        skipped++;
        continue;
      }
      const isInstitution = INSTITUTION_RE.test(r.client_name) ? 1 : 0;
      const info = stmt.run(
        r.deal_date, r.symbol, r.security_name, r.client_name, r.side,
        r.quantity, r.price, isInstitution, now,
      );
      if (info.changes > 0) inserted++;
    }
  });
  tx(rows);

  return { rows_seen: rows.length, rows_inserted: inserted, rows_skipped_incomplete: skipped };
}
