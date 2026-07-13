import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { spawnSync } from "node:child_process";
import { acquireLock, releaseLock } from "@/lib/ingest/lock";

export async function POST() {
  if (!acquireLock()) {
    return NextResponse.json({ status: "in_progress" }, { status: 202 });
  }
  try {
    const res = spawnSync("npx", ["tsx", "scripts/ingest.ts"], {
      encoding: "utf8",
      env: process.env,
    });
    if (res.status !== 0) {
      return NextResponse.json(
        { status: "error", message: res.stderr },
        { status: 500 },
      );
    }
    // The ingest CLI prints one JSON line on stdout. Guard the parse so a
    // non-JSON line (or empty output) still yields a well-formed response.
    let body: { status?: string; [k: string]: unknown } = { status: "ok" };
    try {
      body = JSON.parse(res.stdout);
    } catch {
      body = { status: "ok", note: "ingest produced no parseable output" };
    }
    // No valid Kite session → tell the client where to connect.
    if (body.status === "login_required") {
      return NextResponse.json({ status: "login_required", loginUrl: "/api/kite/login" });
    }
    revalidatePath("/");
    return NextResponse.json(body);
  } finally {
    releaseLock();
  }
}
