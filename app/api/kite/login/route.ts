import { NextResponse } from "next/server";
import { loginUrl } from "@/lib/ingest/kite-client";

// Bounces the browser to Kite's login page. After the user logs in (with TOTP),
// Kite redirects to /api/kite/callback with the request_token.
export async function GET() {
  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ status: "missing_keys" }, { status: 500 });
  }
  return NextResponse.redirect(loginUrl(apiKey));
}
