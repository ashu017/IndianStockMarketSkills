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
    revalidatePath("/");
    // The ingest CLI prints one JSON line on stdout. Guard the parse so a
    // non-JSON line (or empty output) still yields a well-formed response.
    let body: unknown = { status: "ok" };
    try {
      body = JSON.parse(res.stdout);
    } catch {
      body = { status: "ok", note: "ingest produced no parseable output" };
    }
    return NextResponse.json(body);
  } finally {
    releaseLock();
  }
}
