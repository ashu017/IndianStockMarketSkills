import type { PortfolioSummaryRow } from "@/lib/types";
import { paiseToRupees } from "@/lib/money";
import { inr, pct } from "@/components/ui/format";

export default function Kpis({ summary }: { summary: PortfolioSummaryRow }) {
  const cv = paiseToRupees(summary.current_value);
  const inv = paiseToRupees(summary.invested);
  const tp = paiseToRupees(summary.total_pnl);
  const dp = paiseToRupees(summary.day_pnl);
  const investedPaise = summary.invested;
  const prevValuePaise = summary.current_value - summary.day_pnl;

  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
      <Card label="Current Value" value={inr(cv)} />
      <Card label="Invested" value={inr(inv)} />
      <Card
        label="Total P&L"
        value={inr(tp)}
        sub={pct(investedPaise ? (summary.total_pnl / investedPaise) * 100 : 0)}
        up={summary.total_pnl >= 0}
      />
      <Card
        label="Day P&L"
        value={inr(dp)}
        sub={pct(prevValuePaise ? (summary.day_pnl / prevValuePaise) * 100 : 0)}
        up={summary.day_pnl >= 0}
      />
      <Card
        label="Holdings W/L"
        value={String(summary.holdings_count)}
        sub={`${summary.winners}W / ${summary.losers}L`}
      />
    </div>
  );
}

function Card({
  label,
  value,
  sub,
  up,
}: {
  label: string;
  value: string;
  sub?: string;
  up?: boolean;
}) {
  const tone =
    up === undefined ? "text-gray-500" : up ? "text-green-600" : "text-red-600";
  return (
    <div className="rounded-2xl border border-gray-200 p-5">
      <div className="text-xs uppercase tracking-wide text-gray-500">
        {label}
      </div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
      {sub && (
        <div className={`mt-1 text-sm ${tone}`}>
          {up === undefined ? "" : up ? "▲ " : "▼ "}
          {sub}
        </div>
      )}
    </div>
  );
}
