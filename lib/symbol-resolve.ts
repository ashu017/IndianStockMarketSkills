import type Database from "better-sqlite3";

/**
 * Resolve a user-provided string to an NSE tradingsymbol. Accepts:
 *   - An exact tradingsymbol ("TCS", "BAJAJ-AUTO")
 *   - A full or partial company name ("Tata Consultancy", "Reliance Industries")
 *   - A lowercase / space-messy variant of either
 *
 * Returns one of three outcomes:
 *   { kind: 'exact', symbol, company, sector }
 *   { kind: 'ambiguous', candidates: [{symbol, company, sector}, ...] }   (2-8 top matches)
 *   { kind: 'notfound' }
 *
 * All three UI surfaces (Next.js API, home-page search, Telegram bot) use this
 * so behaviour stays consistent.
 */

export interface Candidate {
  symbol: string;
  company: string;
  sector: string;
}

export type ResolveResult =
  | { kind: "exact"; symbol: string; company: string; sector: string }
  | { kind: "ambiguous"; candidates: Candidate[] }
  | { kind: "notfound" };

/**
 * Aggressive normalization for name matching. Handles HTML entities, trailing
 * dots, common corporate suffixes ("Ltd.", "Limited", "Industries"), and
 * squashes to alphanumeric-only.
 */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\.\s*$/g, "")
    .replace(/\bltd\.?\b/g, "")
    .replace(/\blimited\b/g, "")
    .replace(/\bcorporation\b/g, "corp")
    .replace(/\bindustries\b/g, "ind")
    .replace(/\bcompany\b/g, "co")
    .replace(/\band\b/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

interface UniverseSymbol {
  symbol: string;
  company: string | null;
  sector: string | null;
}

/**
 * Load the full universe once per call. Cheap — 200-500 rows, no filter.
 * If you resolve many symbols in a tight loop, pass the pre-built list yourself.
 */
export function loadUniverseSymbols(db: Database.Database): UniverseSymbol[] {
  return db
    .prepare(
      `SELECT DISTINCT symbol, company, sector
       FROM index_universe
       WHERE symbol IS NOT NULL`,
    )
    .all() as UniverseSymbol[];
}

/**
 * Core resolver. Order of matching:
 *   1. Exact symbol match (case-insensitive)     → 'exact'
 *   2. Exact normalized-name match               → 'exact' (only if unique)
 *   3. Prefix match on symbol                    → 'exact' if exactly 1, else 'ambiguous'
 *   4. Substring match on normalized name         → same
 *   5. Nothing                                   → 'notfound'
 */
export function resolveSymbolOrName(
  input: string,
  universe: UniverseSymbol[],
): ResolveResult {
  const q = input.trim();
  if (!q) return { kind: "notfound" };
  const upper = q.toUpperCase();
  const normQ = normalizeName(q);

  // (1) Exact symbol
  const bySym = universe.find((u) => u.symbol.toUpperCase() === upper);
  if (bySym) {
    return {
      kind: "exact",
      symbol: bySym.symbol,
      company: bySym.company ?? "",
      sector: bySym.sector ?? "",
    };
  }

  // Build normalized-company map on the fly (small universe, cheap)
  const byNormName = new Map<string, UniverseSymbol[]>();
  for (const u of universe) {
    if (!u.company) continue;
    const n = normalizeName(u.company);
    if (!n) continue;
    if (!byNormName.has(n)) byNormName.set(n, []);
    byNormName.get(n)!.push(u);
  }

  // (2) Exact normalized-name match
  if (normQ && byNormName.has(normQ)) {
    const hits = byNormName.get(normQ)!;
    if (hits.length === 1) {
      const h = hits[0];
      return { kind: "exact", symbol: h.symbol, company: h.company ?? "", sector: h.sector ?? "" };
    }
  }

  // (3+4) Prefix + substring matches on symbol AND normalized company name.
  const scored = new Map<string, { u: UniverseSymbol; score: number }>();
  const bump = (u: UniverseSymbol, s: number): void => {
    const cur = scored.get(u.symbol);
    if (!cur || cur.score < s) scored.set(u.symbol, { u, score: s });
  };

  for (const u of universe) {
    const symU = u.symbol.toUpperCase();
    // Symbol prefix (highest signal)
    if (symU.startsWith(upper)) bump(u, 100 - symU.length);
    // Symbol substring
    else if (symU.includes(upper)) bump(u, 80 - symU.length);
    // Name matches — only if q is at least 3 chars (avoid overreach on 2-char inputs)
    if (normQ.length >= 3 && u.company) {
      const normC = normalizeName(u.company);
      if (normC.startsWith(normQ)) bump(u, 90 - normC.length);
      else if (normC.includes(normQ)) bump(u, 70 - normC.length);
    }
  }

  const ranked = [...scored.values()].sort((a, b) => b.score - a.score);
  if (ranked.length === 0) return { kind: "notfound" };
  if (ranked.length === 1) {
    const h = ranked[0].u;
    return { kind: "exact", symbol: h.symbol, company: h.company ?? "", sector: h.sector ?? "" };
  }
  // Ambiguous — return up to 8 candidates for the caller to disambiguate.
  return {
    kind: "ambiguous",
    candidates: ranked.slice(0, 8).map((r) => ({
      symbol: r.u.symbol,
      company: r.u.company ?? "",
      sector: r.u.sector ?? "",
    })),
  };
}

/** Convenience for callers that just want the DB read + resolve in one call. */
export function resolveWithDb(db: Database.Database, input: string): ResolveResult {
  return resolveSymbolOrName(input, loadUniverseSymbols(db));
}
