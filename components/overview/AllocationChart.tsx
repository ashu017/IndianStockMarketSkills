"use client";

import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  Legend,
} from "recharts";
import type { Holding } from "@/lib/types";
import { inr } from "@/components/ui/format";

const COLORS = [
  "#2563eb",
  "#16a34a",
  "#f59e0b",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
  "#db2777",
  "#65a30d",
  "#ea580c",
  "#4f46e5",
];

export default function AllocationChart({
  holdings,
}: {
  holdings: Holding[];
}) {
  const data = [...holdings]
    .sort((a, b) => b.current - a.current)
    .map((h) => ({ name: h.symbol, value: h.current }));

  return (
    <div className="rounded-2xl border border-gray-200 p-5">
      <div className="mb-2 text-xs uppercase tracking-wide text-gray-500">
        Allocation by Value
      </div>
      <ResponsiveContainer width="100%" height={320}>
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius={70}
            outerRadius={110}
            paddingAngle={1}
          >
            {data.map((_, i) => (
              <Cell key={i} fill={COLORS[i % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip formatter={(v) => inr(Number(v))} />
          <Legend />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
