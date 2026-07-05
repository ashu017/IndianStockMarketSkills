import type { Holding } from "@/lib/types";

const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 2,
});

const fmtMoney = (v: number) => inr.format(v);
const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const fmtSignedMoney = (v: number) => `${v >= 0 ? "+" : "-"}${inr.format(Math.abs(v))}`;
const toneClass = (v: number) =>
  v > 0 ? "text-green-600" : v < 0 ? "text-red-600" : "text-zinc-700";

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="rounded-2xl border border-zinc-200 p-4">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={`mt-1 text-lg font-semibold tabular-nums ${tone ?? ""}`}>
        {value}
      </div>
    </div>
  );
}

export default function Position({ holding }: { holding: Holding }) {
  return (
    <section className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      <Stat label="Qty" value={holding.qty.toLocaleString("en-IN")} />
      <Stat label="Avg Price" value={fmtMoney(holding.avgPrice)} />
      <Stat label="LTP" value={fmtMoney(holding.ltp)} />
      <Stat label="Invested" value={fmtMoney(holding.invested)} />
      <Stat label="Current" value={fmtMoney(holding.current)} />
      <Stat
        label="P&L"
        value={`${fmtSignedMoney(holding.pnl)} (${fmtPct(holding.pnlPct)})`}
        tone={toneClass(holding.pnl)}
      />
      <Stat
        label="Day Change"
        value={`${fmtSignedMoney(holding.dayPnl)} (${fmtPct(holding.dayChangePct)})`}
        tone={toneClass(holding.dayPnl)}
      />
      <Stat label="Weight" value={`${holding.weight.toFixed(1)}%`} />
    </section>
  );
}
