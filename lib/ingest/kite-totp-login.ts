import { generateSync } from "otplib";
import { exchangeToken, type KiteSession } from "./kite-client";

/**
 * UNOFFICIAL / GREY-AREA: fully automated Kite login by scripting the 2FA form.
 * This is NOT part of Zerodha's documented API and relies on the internal
 * kite.zerodha.com auth endpoints, which expect an interactive human login.
 * It works, is widely used, and can break without notice if Zerodha changes
 * the flow. Enabled only when KITE_PASSWORD + KITE_TOTP_SECRET are set.
 *
 * Flow: /api/login (pwd) -> /api/twofa (TOTP) -> /connect/login (cookies) ->
 * capture request_token from the redirect -> exchange for access_token.
 */

const KITE_WEB = "https://kite.zerodha.com";

interface AutoLoginCreds {
  userId: string; // Kite user id (e.g. "AB1234")
  password: string;
  totpSecret: string; // base32 seed from TOTP setup
  apiKey: string;
  apiSecret: string;
}

function cookiesFrom(res: Response, jar: Map<string, string>): void {
  // Node fetch exposes multiple Set-Cookie via getSetCookie().
  const setCookies =
    (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  for (const c of setCookies) {
    const [pair] = c.split(";");
    const idx = pair.indexOf("=");
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

export function autoLoginEnabled(): boolean {
  return !!(process.env.KITE_PASSWORD && process.env.KITE_TOTP_SECRET);
}

export async function autoLogin(creds: AutoLoginCreds): Promise<KiteSession> {
  const jar = new Map<string, string>();

  // 1. Password step → request_id
  const loginRes = await fetch(`${KITE_WEB}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ user_id: creds.userId, password: creds.password }),
  });
  cookiesFrom(loginRes, jar);
  const loginJson = (await loginRes.json()) as {
    status: string;
    data?: { request_id: string };
    message?: string;
  };
  if (loginJson.status !== "success" || !loginJson.data?.request_id) {
    throw new Error(`Kite password login failed: ${loginJson.message ?? loginRes.status}`);
  }

  // 2. TOTP step
  const totp = generateSync({ secret: creds.totpSecret });
  const twofaRes = await fetch(`${KITE_WEB}/api/twofa`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader(jar),
    },
    body: new URLSearchParams({
      user_id: creds.userId,
      request_id: loginJson.data.request_id,
      twofa_value: totp,
      twofa_type: "totp",
    }),
  });
  cookiesFrom(twofaRes, jar);
  const twofaJson = (await twofaRes.json()) as { status: string; message?: string };
  if (twofaJson.status !== "success") {
    throw new Error(`Kite TOTP step failed: ${twofaJson.message ?? twofaRes.status}`);
  }

  // 3. Hit the Connect login with the authenticated session; capture request_token
  //    from the redirect chain (do NOT auto-follow so we can read the Location).
  const requestToken = await captureRequestToken(creds.apiKey, jar);

  // 4. Exchange for access_token (same as the documented flow).
  return exchangeToken(creds.apiKey, creds.apiSecret, requestToken);
}

async function captureRequestToken(
  apiKey: string,
  jar: Map<string, string>,
): Promise<string> {
  let url = `${KITE_WEB}/connect/login?v=3&api_key=${encodeURIComponent(apiKey)}`;
  for (let hop = 0; hop < 8; hop++) {
    const res = await fetch(url, {
      redirect: "manual",
      headers: { Cookie: cookieHeader(jar) },
    });
    cookiesFrom(res, jar);
    const loc = res.headers.get("location");
    if (loc) {
      const tokenMatch = loc.match(/[?&]request_token=([^&]+)/);
      if (tokenMatch) return decodeURIComponent(tokenMatch[1]);
      url = loc.startsWith("http") ? loc : `${KITE_WEB}${loc}`;
      continue;
    }
    // Some responses embed the finish redirect in the body.
    const body = await res.text();
    const bodyMatch = body.match(/request_token=([A-Za-z0-9]+)/);
    if (bodyMatch) return bodyMatch[1];
    break;
  }
  throw new Error("Could not capture request_token from Kite login redirect");
}
