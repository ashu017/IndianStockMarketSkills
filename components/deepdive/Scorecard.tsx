import { buildScorecard } from "./scorecard-data";
import type { FundamentalsExtraRow, FundamentalsRow } from "@/lib/types";

const gradeColor = {
  Good: "bg-green-100 text-green-700",
  Fair: "bg-amber-100 text-amber-700",
  Weak: "bg-red-100 text-red-700",
} as const;

interface ScorecardProps {
  sector: string;
  core: FundamentalsRow | null;
  extra: FundamentalsExtraRow[];
}

export default function Scorecard({ sector, core, extra }: ScorecardProps) {
  if (!core) {
    return <p className="text-sm text-zinc-500">No fundamentals yet.</p>;
  }

  const items = buildScorecard(
    sector,
    core as unknown as Record<string, number | null>,
    extra,
  );

  if (items.length === 0) {
    return <p className="text-sm text-zinc-500">No fundamentals yet.</p>;
  }

  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
      {items.map((item) => (
        <div key={item.label} className="rounded-2xl border border-zinc-200 p-4">
          <div className="text-xs text-zinc-500">{item.label}</div>
          <div className="mt-1 text-xl font-semibold tabular-nums">
            {item.value}
          </div>
          <span
            className={`mt-2 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${gradeColor[item.grade]}`}
          >
            {item.grade}
          </span>
        </div>
      ))}
    </div>
  );
}
