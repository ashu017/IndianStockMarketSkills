import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { buildPayload } from "@/lib/ingest/build-payload";
import { writeSnapshot, type SnapshotPayload } from "@/lib/ingest/writer";
import {
  loadValidSession,
  saveSession,
  fetchHoldings,
} from "@/lib/ingest/kite-client";
import { autoLogin, autoLoginEnabled } from "@/lib/ingest/kite-totp-login";
import type { RawKiteHolding } from "@/lib/ingest/kite-normalize";

/**
 * Ingestion CLI (spawned by POST /api/refresh, or run directly).
 * Source of holdings, in priority order:
 *   1. INGEST_PAYLOAD env  — a pre-built payload (test / MCP fallback path)
 *   2. cached Kite session — fetch live holdings via Kite Connect API
 * Computes the IST snapshot_date, upserts one day's snapshot, prints a JSON line.
 * If no valid Kite session and no payload, exits with status "login_required".
 */

// Minimal .env loader (standalone tsx scripts don't auto-load .env).
function loadEnv(): void {
  try {
    for (const line of readFileSync(".env", "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* no .env — fine if vars are already set */
  }
}

function istSnapshotDate(now: number = Date.now()): string {
  return new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);
}

async function resolvePayload(
  db: Database.Database,
  userId: string,
): Promise<{ payload: Omit<SnapshotPayload, "snapshotDate">; source: string } | { loginRequired: true }> {
  // 1. Explicit payload override.
  if (process.env.INGEST_PAYLOAD) {
    return {
      payload: JSON.parse(process.env.INGEST_PAYLOAD) as Omit<SnapshotPayload, "snapshotDate">,
      source: "payload",
    };
  }
  // 2. Cached Kite session → live fetch.
  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) return { loginRequired: true };

  let session = loadValidSession(db, userId);

  // 2a. No valid session — try unofficial TOTP auto-login if creds are present.
  if (!session && autoLoginEnabled()) {
    session = await autoLogin({
      userId: process.env.KITE_USER_ID ?? "",
      password: process.env.KITE_PASSWORD ?? "",
      totpSecret: process.env.KITE_TOTP_SECRET ?? "",
      apiKey,
      apiSecret: process.env.KITE_API_SECRET ?? "",
    });
    saveSession(db, userId, session);
  }

  if (!session) return { loginRequired: true };
  const raw: RawKiteHolding[] = await fetchHoldings(apiKey, session.access_token);
  return { payload: buildPayload(userId, raw), source: "kite" };
}

async function main(): Promise<void> {
  loadEnv();
  const userId = process.env.PORTFOLIO_USER_ID ?? "local";
  const dbPath = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";
  const snapshotDate = istSnapshotDate();

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  try {
    const resolved = await resolvePayload(db, userId);
    if ("loginRequired" in resolved) {
      process.stdout.write(JSON.stringify({ status: "login_required" }) + "\n");
      return;
    }
    const payload: SnapshotPayload = { ...resolved.payload, snapshotDate };
    writeSnapshot(db, payload);
    process.stdout.write(
      JSON.stringify({
        status: "ok",
        source: resolved.source,
        snapshotDate,
        holdings: payload.holdings?.length ?? 0,
      }) + "\n",
    );
  } finally {
    db.close();
  }
}

main().catch((err) => {
  process.stdout.write(
    JSON.stringify({
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    }) + "\n",
  );
  process.exit(1);
});
