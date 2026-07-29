/**
 * Sector-demeaning of momentum scores before top-N ranking.
 *
 * Motivation: raw vol-adjusted 12-1 momentum can concentrate the top-30 pool in
 * whichever sector is currently hot (Defence, PSU banks, etc.). Ranking by
 * sector-demeaned momentum instead keeps the diversification promise of a
 * momentum book — the winners are the best names *relative to their sector*.
 *
 * Algorithm
 *   1. Group candidates by sector (null/empty → "__UNKNOWN__").
 *   2. For each sector with >= 3 members, subtract the sector's mean momentum
 *      from each member's momentum.
 *   3. Sectors with < 3 members are left untouched — a mean over 1 or 2 names
 *      is meaningless and would zero-out those candidates.
 *   4. Members with a null momentum are skipped in the mean calc *and* pass
 *      through unchanged.
 *
 * The function is pure and does not mutate the input; a fresh array of new
 * objects is returned. This makes it trivially testable in isolation and lets
 * the scanner keep its `EnrichedCandidate` shape.
 */

export const UNKNOWN_SECTOR_BUCKET = "__UNKNOWN__";
export const MIN_SECTOR_SIZE_FOR_DEMEAN = 3;

export interface DemeanCandidate {
  u: { sector: string | null };
  momentum: number | null;
}

export interface DemeanStats {
  enabled: boolean;
  sectors_demeaned: number;
  sectors_skipped_small: number;
}

export interface DemeanResult<T extends DemeanCandidate> {
  candidates: T[];
  stats: DemeanStats;
}

function bucketOf(sector: string | null | undefined): string {
  if (sector === null || sector === undefined) return UNKNOWN_SECTOR_BUCKET;
  const trimmed = sector.trim();
  return trimmed.length === 0 ? UNKNOWN_SECTOR_BUCKET : trimmed;
}

/**
 * Return a new array of candidates with `momentum` demeaned within each sector.
 *
 * @param candidates candidates to normalize (not mutated)
 * @param enabled    when false, returns the input array as-is with stats.enabled=false
 */
export function demeanBySector<T extends DemeanCandidate>(
  candidates: T[],
  enabled: boolean = true,
): DemeanResult<T> {
  if (!enabled) {
    return {
      candidates,
      stats: {
        enabled: false,
        sectors_demeaned: 0,
        sectors_skipped_small: 0,
      },
    };
  }

  // Group indices by sector bucket. Only candidates with a finite momentum
  // contribute to the group mean; nulls are grouped alongside them so the
  // "size >= 3" check applies to the effective sample.
  const groups = new Map<string, { indices: number[]; sum: number; count: number }>();
  for (let i = 0; i < candidates.length; i++) {
    const b = bucketOf(candidates[i].u.sector);
    let g = groups.get(b);
    if (!g) {
      g = { indices: [], sum: 0, count: 0 };
      groups.set(b, g);
    }
    g.indices.push(i);
    const m = candidates[i].momentum;
    if (m !== null && Number.isFinite(m)) {
      g.sum += m;
      g.count += 1;
    }
  }

  let demeaned = 0;
  let skippedSmall = 0;
  // Result array starts as a shallow copy; we replace demeaned entries in place.
  const out: T[] = candidates.slice();

  for (const [, g] of groups) {
    // Threshold uses the count of members with a numeric momentum. A sector
    // with 5 stocks where only 1 has a momentum is not a meaningful sample.
    if (g.count < MIN_SECTOR_SIZE_FOR_DEMEAN) {
      skippedSmall += 1;
      continue;
    }
    const mean = g.sum / g.count;
    for (const i of g.indices) {
      const c = candidates[i];
      if (c.momentum === null || !Number.isFinite(c.momentum)) continue;
      out[i] = { ...c, momentum: c.momentum - mean };
    }
    demeaned += 1;
  }

  return {
    candidates: out,
    stats: {
      enabled: true,
      sectors_demeaned: demeaned,
      sectors_skipped_small: skippedSmall,
    },
  };
}

/**
 * Read SECTOR_DEMEAN env var — enabled by default, disable with "0".
 */
export function isSectorDemeanEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SECTOR_DEMEAN !== "0";
}
