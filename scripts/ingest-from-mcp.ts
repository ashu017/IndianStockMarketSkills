import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { buildPayload } from "@/lib/ingest/build-payload";
import type { RawKiteHolding } from "@/lib/ingest/kite-normalize";
import { paiseToRupees, priceToRupees } from "@/lib/money";

const rawPath = process.env.RAW_HOLDINGS_PATH ?? "./data/_raw_holdings.json";
const outPath = process.env.HOLDINGS_JSON_PATH ?? "./data/holdings.json";
const userId = process.env.PORTFOLIO_USER_ID ?? "local";

mkdirSync(dirname(outPath), { recursive: true });

const raw: RawKiteHolding[] = JSON.parse(readFileSync(rawPath, "utf8"));
const payload = buildPayload(userId, raw);

const fetchedAt = new Date().toISOString();
const holdingsJson = {
  fetched_at: fetchedAt,
  totals: {
    current_value: paiseToRupees(payload.totals.current_value),
    invested: paiseToRupees(payload.totals.invested),
    total_pnl: paiseToRupees(payload.totals.total_pnl),
    day_pnl: paiseToRupees(payload.totals.day_pnl),
    holdings_count: payload.totals.holdings_count,
    winners: payload.totals.winners,
    losers: payload.totals.losers,
  },
  holdings: payload.holdings.map((h, i) => ({
    symbol: h.symbol,
    exchange: h.exchange,
    isin: payload.meta[i]?.isin ?? null,
    company_name: payload.meta[i]?.company_name ?? null,
    qty: h.qty,
    avg_price: priceToRupees(h.avg_price),
    ltp: paiseToRupees(h.ltp),
    close_price: paiseToRupees(h.close_price),
  })),
};
writeFileSync(outPath, JSON.stringify(holdingsJson, null, 2));

const snapshot = spawnSync(
  "npx",
  ["tsx", "scripts/ingest.ts"],
  {
    env: { ...process.env, INGEST_PAYLOAD: JSON.stringify(payload) },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  },
);
process.stdout.write(snapshot.stdout ?? "");
process.stderr.write(snapshot.stderr ?? "");
if (snapshot.status !== 0) process.exit(snapshot.status ?? 1);

process.stdout.write(
  JSON.stringify({
    status: "ok",
    holdings_json: outPath,
    holdings_count: payload.totals.holdings_count,
  }) + "\n",
);
