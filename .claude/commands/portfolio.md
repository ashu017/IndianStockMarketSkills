---
description: Fetch the latest Zerodha holdings, generate AI insights, and launch the local dashboard.
argument-hint: "[refresh]"
---

Use the `portfolio-agent` to run the orchestration:

1. Invoke the `fetch-holdings` skill.
2. Invoke the `generate-insights` skill.
3. Invoke the `launch-dashboard` skill.
4. Report the dashboard URL to the user.

If the argument is `refresh`, perform the same chain (it overwrites the data files).

If the user is not logged in to Kite, surface the login URL from `mcp__kite__login` and stop.
