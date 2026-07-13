import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/connection";
import { exchangeToken, saveSession } from "@/lib/ingest/kite-client";

const USER = process.env.PORTFOLIO_USER_ID ?? "local";

// Kite redirects here after login with ?request_token=... . We exchange it for an
// access_token, cache it, then bounce back to the dashboard.
export async function GET(req: NextRequest) {
  const requestToken = req.nextUrl.searchParams.get("request_token");
  const status = req.nextUrl.searchParams.get("status");
  const origin = req.nextUrl.origin;

  if (status === "error" || !requestToken) {
    return NextResponse.redirect(`${origin}/?kite=login_failed`);
  }

  const apiKey = process.env.KITE_API_KEY;
  const apiSecret = process.env.KITE_API_SECRET;
  if (!apiKey || !apiSecret) {
    return NextResponse.redirect(`${origin}/?kite=missing_keys`);
  }

  try {
    const session = await exchangeToken(apiKey, apiSecret, requestToken);
    saveSession(getDb(), USER, session);
    return NextResponse.redirect(`${origin}/?kite=connected`);
  } catch {
    return NextResponse.redirect(`${origin}/?kite=exchange_failed`);
  }
}
