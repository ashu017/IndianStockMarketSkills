import type { Holding } from "@/lib/types";

export default function Concentration({ holdings }: { holdings: Holding[] }) {
  const top3 = [...holdings]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3);
  const top3Weight = top3.reduce((sum, h) => sum + h.weight, 0);
  const concentrated = top3Weight > 40;

  return (
    <div
      className={`rounded-2xl border p-5 ${
        concentrated
          ? "border-amber-300 bg-amber-50"
          : "border-gray-200"
      }`}
    >
      <div className="text-xs uppercase tracking-wide text-gray-500">
        Concentration
      </div>
      <div className="mt-1 text-2xl font-bold tabular-nums">
        {top3Weight.toFixed(1)}%
      </div>
      <div className="mt-1 text-sm text-gray-600">
        Top 3 holdings ({top3.map((h) => h.symbol).join(", ") || "—"})
      </div>
      {concentrated && (
        <div className="mt-2 text-sm font-medium text-amber-700">
          ⚠ High concentration — top 3 exceed 40% of portfolio.
        </div>
      )}
    </div>
  );
}
