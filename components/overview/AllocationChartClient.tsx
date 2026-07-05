"use client";

import dynamic from "next/dynamic";
import type { Holding } from "@/lib/types";

// Recharts is client-only. ssr:false is permitted here because this wrapper is a
// Client Component (it is not allowed directly in a Server Component page).
const AllocationChart = dynamic(() => import("./AllocationChart"), {
  ssr: false,
  loading: () => (
    <div className="h-[380px] animate-pulse rounded-2xl bg-gray-100" />
  ),
});

export default function AllocationChartClient({
  holdings,
}: {
  holdings: Holding[];
}) {
  return <AllocationChart holdings={holdings} />;
}
