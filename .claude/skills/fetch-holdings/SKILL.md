---
name: fetch-holdings
description: Fetch the user's Zerodha Kite holdings via the Kite Connect REST API (using a cached daily access_token) and write data/holdings.json plus a SQLite snapshot. Use whenever the user asks to refresh, view, or analyze their portfolio.
---

# fetch-holdings

Pull the user's current holdings via the Kite Connect REST API (`api.kite.trade`),
using the daily `access_token` cached in the SQLite `kite_session` table. Produce:

- `data/holdings.json` — human-readable snapshot used by `generate-insights` and
  the Telegram digest
- one row in the SQLite `holdings_snapshot` table (per IST day) — used by the
  Next.js dashboard and `fundamental-analyst` peer-join queries

This flow is **fully headless** — no MCP session, no browser click — as long as
today's `access_token` is still valid (Zerodha tokens expire at 06:00 IST).

## When to use

- The user runs `/portfolio` (orchestrated by `portfolio-agent`)
- The user runs `/portfolio refresh`
- The `portfolio-telegram` cron fires
- Any other skill needs fresh holdings data

## Steps

Working directory: `/home/ashunsah/workplace/IndianStockMarketSkills`

1. Ensure `node_modules` exists and the DB is migrated. Cheap idempotent check:

   ```bash
   cd /home/ashunsah/workplace/IndianStockMarketSkills
   [ -d node_modules ] || npm install
   [ -f data/portfolio.db ] || PORTFOLIO_DB_PATH=./data/portfolio.db npx tsx scripts/migrate.ts
   mkdir -p data
   ```

2. Run the ingest script. It reads `.env` for `KITE_API_KEY` / `KITE_API_SECRET`,
   loads the cached `access_token` from SQLite, calls `api.kite.trade/portfolio/holdings`,
   writes `data/holdings.json`, and upserts today's snapshot row:

   ```bash
   cd /home/ashunsah/workplace/IndianStockMarketSkills
   PORTFOLIO_DB_PATH=./data/portfolio.db PORTFOLIO_USER_ID=local \
     npx tsx scripts/ingest.ts
   ```

   Exits with one of two JSON lines on stdout:

   - `{"status":"ok","source":"kite","snapshotDate":"YYYY-MM-DD","holdings":N}` — success
   - `{"status":"login_required"}` — no valid cached token (token expired at 06:00 IST
     or the user has never logged in on this box)
   - `{"status":"error","message":"..."}` — anything else (network, API rejection, etc.)

3. On `login_required`, HALT. Do NOT proceed and do NOT fabricate holdings. Return
   this instruction to the caller (the cron converts it into a Telegram WARN, the
   interactive user sees a login link):

   > Kite session expired — visit `http://127.0.0.1:3210/api/kite/login` in a browser
   > (SSH tunnel if remote) and complete Zerodha login + TOTP. Then re-run.

   The Next.js dashboard exposes `/api/kite/login` (redirects to Zerodha) and
   `/api/kite/callback` (exchanges the request_token and persists the new
   access_token). Start the dashboard first if it isn't running:

   ```bash
   cd /home/ashunsah/workplace/IndianStockMarketSkills
   PORTFOLIO_DB_PATH=./data/portfolio.db PORTFOLIO_USER_ID=local \
     npm run dev -- --port 3210 --hostname 127.0.0.1
   ```

4. On `status: ok`, verify `data/holdings.json` exists and parses. Report a
   one-line summary read from the file's `totals` block:
   `"Fetched N holdings, total value ₹X, day P&L ₹Y"`.

## Failure modes

- **`login_required`:** halt with the login URL. Leave any existing
  `data/holdings.json` untouched. Once per day (before ~06:00 IST expiry) is the
  worst case — the token is good for the rest of the day after one browser click.
- **API 4xx from Kite** (`InputException`, expired token mid-day, revoked):
  `ingest.ts` prints `status: error`. Surface the error and stop; do NOT retry
  blindly — some 4xx responses invalidate the token and only a fresh login helps.
- **Network / timeout:** retry once after 2 seconds. On second failure, surface
  the error and leave any existing `data/holdings.json` untouched.
- **Empty holdings:** `ingest.ts` still writes a valid `data/holdings.json` (empty
  array, zeroed totals). Report "no holdings found" and continue.
- **`npm install` needed but blocked (no network / stale lockfile):** report the
  failure and stop; do not attempt a workaround.

## Notes on the auth model

- The daily `access_token` is stored in the `kite_session` SQLite table, one row
  per `PORTFOLIO_USER_ID`. `expires_at` is pinned to the next 06:00 IST boundary
  (SEBI regulation).
- This skill does NOT use the Kite MCP (`mcp__kite__*` tools). The MCP requires
  an interactive OAuth session per SSE connection, which cannot be reused by a
  headless cron. The REST API + cached token pattern is what makes the cron work.
- The `portfolio-telegram` cron detects `login_required` and posts a WARN to
  Telegram (dedup'd, so it doesn't spam). One click on the login URL fixes it.
