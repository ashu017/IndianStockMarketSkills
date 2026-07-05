export const dynamic = "force-dynamic";

import { Suspense } from "react";
import Link from "next/link";
import {
  getHolding,
  getFundamentals,
  getPeers,
  getAnalysis,
} from "@/lib/db";
import { toHolding } from "@/lib/mappers";
import { paiseToRupees } from "@/lib/money";
import type { Exchange } from "@/lib/types";
import Position from "@/components/deepdive/Position";
import Scorecard from "@/components/deepdive/Scorecard";
import PeerTable from "@/components/deepdive/PeerTable";
import Narrative from "@/components/deepdive/Narrative";

const USER = process.env.PORTFOLIO_USER_ID ?? "local";

const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 2,
});

const pulse = "h-40 animate-pulse rounded-2xl bg-zinc-100";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ symbol: string }>;
  searchParams: Promise<{ exchange?: string }>;
}) {
  const { symbol } = await params;
  const { exchange: exchangeParam } = await searchParams;
  const exchange = (exchangeParam ?? "NSE") as Exchange;

  const row = await getHolding(USER, symbol, exchange);
  if (!row) {
    return (
      <main className="mx-auto max-w-4xl space-y-4 p-8">
        <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-700">
          ← Portfolio
        </Link>
        <p className="text-zinc-700">Unknown holding.</p>
      </main>
    );
  }

  // Single-stock page: weight is relative to this position's own current value.
  const totalRupees = row.qty * paiseToRupees(row.ltp);
  const holding = toHolding(row, totalRupees);
  const isin = row.isin;

  return (
    <main className="mx-auto max-w-4xl space-y-8 p-8">
      <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-700">
        ← Portfolio
      </Link>

      <header className="space-y-1">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">
            {holding.symbol} — {holding.company}
          </h1>
          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">
            {holding.exchange}
          </span>
        </div>
        <div className="text-lg font-semibold tabular-nums">
          {inr.format(holding.ltp)}
        </div>
      </header>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-zinc-500">Position</h2>
        <Position holding={holding} />
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-zinc-500">
          Fundamentals
        </h2>
        {isin ? (
          <Suspense fallback={<div className={pulse} />}>
            <Fundamentals isin={isin} sector={holding.sector} />
          </Suspense>
        ) : (
          <p className="text-sm text-zinc-500">No fundamentals yet.</p>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-zinc-500">Peers</h2>
        {isin ? (
          <Suspense fallback={<div className={pulse} />}>
            <Peers isin={isin} />
          </Suspense>
        ) : (
          <p className="text-sm text-zinc-500">No peer data yet.</p>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-zinc-500">Analysis</h2>
        {isin ? (
          <Suspense fallback={<div className={pulse} />}>
            <Analysis isin={isin} />
          </Suspense>
        ) : (
          <p className="text-sm text-zinc-500">No analysis yet.</p>
        )}
      </section>
    </main>
  );
}

async function Fundamentals({
  isin,
  sector,
}: {
  isin: string;
  sector: string;
}) {
  const { core, extra } = await getFundamentals(isin);
  return <Scorecard sector={sector} core={core} extra={extra} />;
}

async function Peers({ isin }: { isin: string }) {
  const peers = await getPeers(isin);
  return <PeerTable peers={peers} />;
}

async function Analysis({ isin }: { isin: string }) {
  const analysis = await getAnalysis(isin);
  return <Narrative analysis={analysis} />;
}
