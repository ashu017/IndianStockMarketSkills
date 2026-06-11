---
name: fetch-holdings
description: Fetch the user's Zerodha Kite holdings via MCP, normalize them, and write data/holdings.json. Use whenever the user asks to refresh, view, or analyze their portfolio.
---

# fetch-holdings

Pull the user's current holdings from the Kite MCP server, transform them with the project normalizer, and write the canonical `data/holdings.json` that all downstream skills read.

## When to use

- The user runs `/portfolio` (orchestrated by `portfolio-agent`)
- The user runs `/portfolio refresh`
- Any other skill needs fresh holdings data

## Steps

1. Call `mcp__kite__get_holdings` (no parameters).
2. If the tool returns a "Please log in" error, call `mcp__kite__login`, return the login URL to the user as a clickable markdown link, and STOP. Do not proceed.
3. If the call returns an array (possibly empty), continue.
4. Save the raw MCP JSON response to `data/_raw_holdings.json`, then from the project root (`/Users/ashunsah/Desktop/Stocks`) run:

   ```bash
   .venv/bin/python -c "
   import json
   from datetime import datetime, timezone
   from dashboard.fetch_holdings import normalize_holdings, atomic_write_json
   raw = json.load(open('data/_raw_holdings.json'))
   now = datetime.now(timezone.utc).isoformat()
   atomic_write_json('data/holdings.json', normalize_holdings(raw, now=now))
   print('wrote data/holdings.json with', len(raw), 'holdings')
   "
   rm data/_raw_holdings.json
   ```

5. Verify `data/holdings.json` exists and is valid JSON.
6. Report: "Fetched N holdings, total value ₹X, day P&L ₹Y" (read from the summary).

## Failure modes

- **Auth required:** halt with login URL.
- **MCP timeout:** retry once after 2 seconds. On second failure, surface the error and leave any existing `data/holdings.json` untouched.
- **Empty holdings:** still write a valid file (empty array, zeroed summary). Report "no holdings found" and continue.
