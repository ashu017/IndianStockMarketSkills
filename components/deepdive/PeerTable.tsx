import type { PeerRow } from "@/lib/types";

const fmtRatio = (v: number | null) => (v == null ? "—" : `${v}×`);
const fmtPct = (v: number | null) => (v == null ? "—" : `${v}%`);

export default function PeerTable({ peers }: { peers: PeerRow[] }) {
  if (!peers || peers.length === 0) {
    return <p className="text-sm text-zinc-500">No peer data yet.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500">
            <th className="py-2 pr-4 font-medium">Peer</th>
            <th className="py-2 pr-4 text-right font-medium">P/E</th>
            <th className="py-2 pr-4 text-right font-medium">ROE</th>
            <th className="py-2 pr-4 text-right font-medium">ROCE</th>
            <th className="py-2 text-right font-medium">Sales Growth</th>
          </tr>
        </thead>
        <tbody>
          {peers.map((p) => (
            <tr key={p.peer_symbol} className="border-b border-zinc-100">
              <td className="py-2 pr-4">
                <span className="font-medium">{p.peer_symbol}</span>
                {p.peer_company && (
                  <span className="ml-2 text-xs text-zinc-500">
                    {p.peer_company}
                  </span>
                )}
              </td>
              <td className="py-2 pr-4 text-right tabular-nums">
                {fmtRatio(p.pe)}
              </td>
              <td className="py-2 pr-4 text-right tabular-nums">
                {fmtPct(p.roe)}
              </td>
              <td className="py-2 pr-4 text-right tabular-nums">
                {fmtPct(p.roce)}
              </td>
              <td className="py-2 text-right tabular-nums">
                {fmtPct(p.sales_growth)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
