import { describe, it, expect } from "vitest";
import {
  demeanBySector,
  isSectorDemeanEnabled,
  UNKNOWN_SECTOR_BUCKET,
  type DemeanCandidate,
} from "@/lib/momentum-normalize";

/**
 * Build a minimal candidate shape for these unit tests. The real scanner uses
 * an `EnrichedCandidate` with `u`/`verdict`/`momentum`; the helper only reads
 * `u.sector` and `momentum` so a tiny stand-in is enough.
 */
function c(sector: string | null, momentum: number | null): DemeanCandidate {
  return { u: { sector }, momentum };
}

describe("demeanBySector", () => {
  it("all same sector: sum of demeaned momenta is ~0", () => {
    const input = [
      c("IT", 1),
      c("IT", 2),
      c("IT", 3),
      c("IT", 4),
      c("IT", 5),
    ];
    const { candidates, stats } = demeanBySector(input);
    const sum = candidates.reduce((acc, x) => acc + (x.momentum ?? 0), 0);
    expect(sum).toBeCloseTo(0, 10);
    // Mean of 1..5 is 3, so demeaned should be [-2,-1,0,1,2].
    expect(candidates.map((x) => x.momentum)).toEqual([-2, -1, 0, 1, 2]);
    expect(stats.enabled).toBe(true);
    expect(stats.sectors_demeaned).toBe(1);
    expect(stats.sectors_skipped_small).toBe(0);
  });

  it("two mixed sectors: each stock demeaned by its sector's mean", () => {
    // IT mean = (1+2+3)/3 = 2. Bank mean = (10+20+30)/3 = 20.
    const input = [
      c("IT", 1),
      c("Bank", 10),
      c("IT", 2),
      c("Bank", 20),
      c("IT", 3),
      c("Bank", 30),
    ];
    const { candidates, stats } = demeanBySector(input);
    expect(candidates.map((x) => x.momentum)).toEqual([
      -1, // 1  - 2
      -10, // 10 - 20
      0, // 2  - 2
      0, // 20 - 20
      1, // 3  - 2
      10, // 30 - 20
    ]);
    // Order is preserved (helper does not sort).
    expect(candidates.map((x) => x.u.sector)).toEqual([
      "IT",
      "Bank",
      "IT",
      "Bank",
      "IT",
      "Bank",
    ]);
    expect(stats.sectors_demeaned).toBe(2);
    expect(stats.sectors_skipped_small).toBe(0);
  });

  it("lone sector member (< 3): left unchanged", () => {
    const input = [
      c("Auto", 42),
      c("IT", 1),
      c("IT", 2),
      c("IT", 3),
    ];
    const { candidates, stats } = demeanBySector(input);
    // Auto has only 1 member → untouched. IT has 3 → demeaned around mean 2.
    expect(candidates[0].momentum).toBe(42);
    expect(candidates[1].momentum).toBe(-1);
    expect(candidates[2].momentum).toBe(0);
    expect(candidates[3].momentum).toBe(1);
    expect(stats.sectors_demeaned).toBe(1);
    expect(stats.sectors_skipped_small).toBe(1);
  });

  it("null/empty sector: grouped into __UNKNOWN__ bucket", () => {
    const input = [
      c(null, 5),
      c("", 15),
      c("   ", 25), // whitespace-only counts as unknown
      c("IT", 100), // isolated, below the threshold → untouched
    ];
    const { candidates, stats } = demeanBySector(input);
    // Unknown bucket mean = (5+15+25)/3 = 15. Members become [-10, 0, 10].
    expect(candidates[0].u.sector).toBeNull();
    expect(candidates[0].momentum).toBe(-10);
    expect(candidates[1].momentum).toBe(0);
    expect(candidates[2].momentum).toBe(10);
    // The IT stock is a lone member → left as-is.
    expect(candidates[3].momentum).toBe(100);
    expect(stats.sectors_demeaned).toBe(1);
    expect(stats.sectors_skipped_small).toBe(1);
    // Sanity: the exported bucket constant matches the grouping logic.
    expect(UNKNOWN_SECTOR_BUCKET).toBe("__UNKNOWN__");
  });

  it("SECTOR_DEMEAN=0 (disabled): returns candidates unchanged", () => {
    const input = [
      c("IT", 1),
      c("IT", 2),
      c("IT", 3),
    ];
    const { candidates, stats } = demeanBySector(input, false);
    // Same references, momenta unmodified.
    expect(candidates).toBe(input);
    expect(candidates.map((x) => x.momentum)).toEqual([1, 2, 3]);
    expect(stats.enabled).toBe(false);
    expect(stats.sectors_demeaned).toBe(0);
    expect(stats.sectors_skipped_small).toBe(0);

    // And the env-var reader agrees.
    expect(isSectorDemeanEnabled({ SECTOR_DEMEAN: "0" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(isSectorDemeanEnabled({} as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(isSectorDemeanEnabled({ SECTOR_DEMEAN: "1" } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });
});
