import { NextRequest, NextResponse } from "next/server";
import {
  fetchChart,
  type ChartMetricKey,
  type ChartRange,
} from "@/lib/screener-chart";

const METRICS: ChartMetricKey[] = ["price", "sales", "eps"];
const RANGES: ChartRange[] = ["1Y", "3Y", "5Y", "ALL"];

// GET /api/chart/TCS?metric=price&range=1Y  → { metric, points:[{date,value}] }
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ symbol: string }> },
) {
  const { symbol } = await params;
  const metricParam = req.nextUrl.searchParams.get("metric") ?? "price";
  const rangeParam = req.nextUrl.searchParams.get("range") ?? "1Y";

  const metric = (METRICS as string[]).includes(metricParam)
    ? (metricParam as ChartMetricKey)
    : "price";
  const range = (RANGES as string[]).includes(rangeParam)
    ? (rangeParam as ChartRange)
    : "1Y";

  try {
    const series = await fetchChart(decodeURIComponent(symbol), metric, range);
    if (!series) {
      return NextResponse.json(
        { status: "no_data", metric, points: [] },
        { status: 200 },
      );
    }
    return NextResponse.json({ status: "ok", metric: series.metric, points: series.points });
  } catch (e) {
    return NextResponse.json(
      { status: "error", message: e instanceof Error ? e.message : String(e), points: [] },
      { status: 200 },
    );
  }
}
