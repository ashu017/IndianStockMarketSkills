import Link from "next/link";
import type { Holding } from "@/lib/types";
import { inr, pct } from "@/components/ui/format";

export default function WinnersLosers({ holdings }: { holdings: Holding[] }) {
  const byPnl = [...holdings].sort((a, b) => b.pnl - a.pnl);
  const winners = byPnl.filter((h) => h.pnl > 0).slice(0, 5);
  const losers = byPnl
    .filter((h) => h.pnl < 0)
    .slice(-5)
    .reverse();

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <List title="Top Winners" rows={winners} />
      <List title="Top Losers" rows={losers} />
    </div>
  );
}

function List({ title, rows }: { title: string; rows: Holding[] }) {
  return (
    <div className="rounded-2xl border border-gray-200 p-5">
      <div className="mb-3 text-xs uppercase tracking-wide text-gray-500">
        {title}
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-500">None</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((h) => (
            <li
              key={`${h.symbol}-${h.exchange}`}
              className="flex items-center justify-between text-sm"
            >
              <Link
                className="font-medium text-blue-600 hover:underline"
                href={`/stock/${h.symbol}?exchange=${h.exchange}`}
              >
                {h.symbol}
              </Link>
              <span
                className={`tabular-nums ${
                  h.pnl >= 0 ? "text-green-600" : "text-red-600"
                }`}
              >
                {inr(h.pnl)} ({pct(h.pnlPct)})
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
