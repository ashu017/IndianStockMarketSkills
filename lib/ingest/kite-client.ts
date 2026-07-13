import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { RawKiteHolding } from "./kite-normalize";

const KITE_API = "https://api.kite.trade";

export interface KiteSession {
  access_token: string;
  kite_user_id: string | null;
  login_time: string;
  expires_at: string;
}

/** Access tokens expire at 6:00 AM IST the next day (regulatory). */
export function nextExpiryIso(now: number = Date.now()): string {
  // Work in IST (UTC+5:30). Find the next 06:00 IST boundary, return as UTC ISO.
  const istMs = now + 5.5 * 3600_000;
  const ist = new Date(istMs);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  const d = ist.getUTCDate();
  const hour = ist.getUTCHours();
  // If already past 6 AM IST, expiry is 6 AM tomorrow; else 6 AM today.
  const dayOffset = hour >= 6 ? 1 : 0;
  const expiryIstMidnightUtc = Date.UTC(y, m, d + dayOffset, 6, 0, 0);
  return new Date(expiryIstMidnightUtc - 5.5 * 3600_000).toISOString();
}

/** Kite login URL the user opens in a browser to get a request_token. */
export function loginUrl(apiKey: string): string {
  return `https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(apiKey)}`;
}

/**
 * Exchange a request_token (from the browser redirect) for an access_token.
 * checksum = SHA-256(api_key + request_token + api_secret).
 */
export async function exchangeToken(
  apiKey: string,
  apiSecret: string,
  requestToken: string,
): Promise<KiteSession> {
  const checksum = createHash("sha256")
    .update(apiKey + requestToken + apiSecret)
    .digest("hex");

  const res = await fetch(`${KITE_API}/session/token`, {
    method: "POST",
    headers: {
      "X-Kite-Version": "3",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      api_key: apiKey,
      request_token: requestToken,
      checksum,
    }),
  });

  const json = (await res.json()) as {
    status: string;
    data?: { access_token: string; user_id?: string; login_time?: string };
    message?: string;
  };
  if (json.status !== "success" || !json.data?.access_token) {
    throw new Error(`Kite session exchange failed: ${json.message ?? res.status}`);
  }

  return {
    access_token: json.data.access_token,
    kite_user_id: json.data.user_id ?? null,
    login_time: new Date().toISOString(),
    expires_at: nextExpiryIso(),
  };
}

/** Persist the session (one row per user). */
export function saveSession(db: Database.Database, userId: string, s: KiteSession): void {
  db.prepare(
    `INSERT INTO kite_session(user_id, access_token, kite_user_id, login_time, expires_at)
     VALUES(@user_id, @access_token, @kite_user_id, @login_time, @expires_at)
     ON CONFLICT(user_id) DO UPDATE SET
       access_token=excluded.access_token, kite_user_id=excluded.kite_user_id,
       login_time=excluded.login_time, expires_at=excluded.expires_at`,
  ).run({ user_id: userId, ...s });
}

/** Return a still-valid cached session, or null if absent/expired. */
export function loadValidSession(
  db: Database.Database,
  userId: string,
  now: number = Date.now(),
): KiteSession | null {
  const row = db
    .prepare(`SELECT * FROM kite_session WHERE user_id = ?`)
    .get(userId) as (KiteSession & { user_id: string }) | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= now) return null;
  return row;
}

/** Fetch holdings using a valid access_token. */
export async function fetchHoldings(
  apiKey: string,
  accessToken: string,
): Promise<RawKiteHolding[]> {
  const res = await fetch(`${KITE_API}/portfolio/holdings`, {
    headers: {
      "X-Kite-Version": "3",
      Authorization: `token ${apiKey}:${accessToken}`,
    },
  });
  const json = (await res.json()) as {
    status: string;
    data?: RawKiteHolding[];
    message?: string;
  };
  if (json.status !== "success" || !json.data) {
    throw new Error(`Kite holdings fetch failed: ${json.message ?? res.status}`);
  }
  return json.data;
}
