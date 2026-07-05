"use client";

import Link from "next/link";
import type { Holding } from "@/lib/types";
import { inr, pct } from "@/components/ui/format";

export default function HoldingsTable({ holdings }: { holdings: Holding[] }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-gray-200">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
            <th className="px-4 py-3">Symbol</th>
            <th className="px-4 py-3 text-right">Qty</th>
            <th className="px-4 py-3 text-right">LTP</th>
            <th className="px-4 py-3 text-right">Day %</th>
            <th className="px-4 py-3 text-right">Current</th>
            <th className="px-4 py-3 text-right">P&L</th>
            <th className="px-4 py-3 text-right">P&L %</th>
            <th className="px-4 py-3 text-right">Weight</th>
          </tr>
        </thead>
        <tbody>
          {holdings.map((h) => (
            <tr
              key={`${h.symbol}-${h.exchange}`}
              className="border-t border-gray-100 hover:bg-gray-50"
            >
              <td className="px-4 py-3">
                <Link
                  className="font-medium text-blue-600 hover:underline"
                  href={`/stock/${h.symbol}?exchange=${h.exchange}`}
                >
                  {h.symbol}
                </Link>
                <div className="text-xs text-gray-500">{h.company}</div>
              </td>
              <td className="px-4 py-3 text-right tabular-nums">{h.qty}</td>
              <td className="px-4 py-3 text-right tabular-nums">
                {inr(h.ltp)}
              </td>
              <td
                className={`px-4 py-3 text-right tabular-nums ${
                  h.dayChangePct >= 0 ? "text-green-600" : "text-red-600"
                }`}
              >
                {pct(h.dayChangePct)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                {inr(h.current)}
              </td>
              <td
                className={`px-4 py-3 text-right tabular-nums ${
                  h.pnl >= 0 ? "text-green-600" : "text-red-600"
                }`}
              >
                {inr(h.pnl)}
              </td>
              <td
                className={`px-4 py-3 text-right tabular-nums ${
                  h.pnlPct >= 0 ? "text-green-600" : "text-red-600"
                }`}
              >
                {pct(h.pnlPct)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                {h.weight.toFixed(2)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
