import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { spawn } from "node:child_process";

/**
 * On-demand AI analysis for one stock.
 *
 *   POST /api/analysis/RADICO            generate if today's row is missing
 *   POST /api/analysis/RADICO?force=1    always regenerate
 *
 * Delegates to scripts/generate-analysis.ts, which resolves the same ISIN the
 * deep-dive page resolves, calls the `claude -p` CLI for the verdict, and upserts
 * into `analysis`. On success the deep-dive path is revalidated so the Analysis
 * card shows the new narrative on next load.
 *
 * The LLM call is slow (tens of seconds), so this is a POST the client triggers
 * explicitly — never a side effect of rendering.
 */

// The `claude` CLI is not bundled with the app, so this must run on Node.
export const runtime = "nodejs";
export const maxDuration = 180;

const TIMEOUT_MS = 170_000;

function runScript(symbol: string, force: boolean): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("npx", ["tsx", "scripts/generate-analysis.ts"], {
      env: { ...process.env, SYMBOL: symbol, ...(force ? { FORCE: "1" } : {}) },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("analysis generation timed out"));
    }, TIMEOUT_MS);
    proc.stdout.on("data", (d) => (stdout += String(d)));
    proc.stderr.on("data", (d) => (stderr += String(d)));
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ symbol: string }> },
) {
  const { symbol } = await params;
  const decoded = decodeURIComponent(symbol).trim().toUpperCase();
  // Guard the value we hand to a spawned process. Real NSE symbols are
  // alphanumerics plus & - . (e.g. BAJAJ-AUTO, M&M, NIFTY50.NS).
  if (!decoded || !/^[A-Z0-9&.\-]{1,32}$/.test(decoded)) {
    return NextResponse.json({ status: "error", message: "invalid symbol" }, { status: 400 });
  }

  const force = new URL(_req.url).searchParams.get("force") === "1";

  let res: { code: number; stdout: string; stderr: string };
  try {
    res = await runScript(decoded, force);
  } catch (e) {
    return NextResponse.json(
      { status: "error", message: e instanceof Error ? e.message : String(e) },
      { status: 504 },
    );
  }

  // The script prints exactly one JSON line, on both success and handled failure.
  let body: { status?: string; message?: string; [k: string]: unknown };
  const lastLine = res.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  try {
    body = JSON.parse(lastLine);
  } catch {
    return NextResponse.json(
      {
        status: "error",
        message: "analysis script produced no parseable output",
        detail: (res.stderr || res.stdout).trim().slice(0, 500),
      },
      { status: 500 },
    );
  }

  if (body.status === "error") {
    // Missing fundamentals is the caller's cue to refresh first, not a server fault.
    const needsRefresh = /no fundamentals|not found in index_universe/i.test(body.message ?? "");
    return NextResponse.json(body, { status: needsRefresh ? 409 : 500 });
  }

  revalidatePath(`/stock/${decoded}`);
  return NextResponse.json(body);
}

