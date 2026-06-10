# Portfolio Dashboard — Design

**Date:** 2026-06-11
**Status:** Approved (pending implementation plan)

## Goal

Build a local, AI-augmented stock portfolio dashboard for Zerodha Kite users. A user types `/portfolio` in Claude Code and gets a Streamlit dashboard at `http://localhost:8501` showing their holdings, P&L, allocation, and AI-generated insights. Designed to be cloned and used by anyone with Claude Code + the Kite MCP server installed.

## Non-Goals (v1)

- Live tick streaming (refresh is on-demand)
- Order placement/modification through the dashboard
- Sector allocation view (deferred to v2)
- Tax-loss harvesting / XIRR (deferred to v2 as additional skills)
- Cloud hosting / multi-user backend
- Direct Kite REST integration in the dashboard (Claude/agent owns data fetching)

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Claude Code (user-facing)                                       │
│                                                                  │
│   /portfolio  ──►  portfolio-agent  ──orchestrates──►  3 skills  │
│                          ▲                                       │
│                          │ ad-hoc Q&A                            │
│                       (user)                                     │
└──────────────────────────────┬───────────────────────────────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        ▼                      ▼                      ▼
  ┌──────────────┐     ┌──────────────────┐    ┌──────────────────┐
  │ fetch-       │     │ generate-        │    │ launch-          │
  │ holdings     │ ──► │ insights         │ ──►│ dashboard        │
  │              │     │                  │    │                  │
  │ Kite MCP →   │     │ holdings.json →  │    │ spawns streamlit │
  │ holdings.json│     │ insights.md      │    │ + opens browser  │
  └──────────────┘     └──────────────────┘    └──────────────────┘
                                                        │
                                                        ▼
                                            ┌─────────────────────┐
                                            │ Streamlit Dashboard │
                                            │ http://localhost:   │
                                            │   8501              │
                                            │                     │
                                            │ reads:              │
                                            │  - holdings.json    │
                                            │  - insights.md      │
                                            └─────────────────────┘
```

### Boundaries

- **Agent** — orchestration, conversation, ad-hoc Q&A. Knows nothing about Streamlit or file paths.
- **Skills** — each does one job, writes/reads well-defined artifacts. Composable.
- **Dashboard** — pure rendering. Reads JSON/MD files. No knowledge of Claude or MCP.
- **Data files** (`holdings.json`, `insights.md`) — the contract between layers.

## Repository Layout

```
Stocks/
├── .claude/
│   ├── skills/
│   │   ├── fetch-holdings/SKILL.md
│   │   ├── generate-insights/SKILL.md
│   │   └── launch-dashboard/SKILL.md
│   ├── agents/
│   │   └── portfolio-agent.md
│   └── commands/
│       └── portfolio.md
├── dashboard/
│   ├── app.py                # Streamlit app
│   ├── launch.py             # background launcher used by launch-dashboard skill
│   └── requirements.txt
├── data/
│   ├── holdings.json         # written by fetch-holdings, read by all
│   └── insights.md           # written by generate-insights, read by dashboard
├── tests/
│   ├── fixtures/
│   │   ├── kite_holdings_response.json
│   │   └── holdings_normalized.json
│   ├── test_fetch_holdings.py
│   ├── test_dashboard.py
│   └── test_launch_dashboard.py
├── docs/
│   └── superpowers/specs/
└── README.md
```

## Components

### Skills

#### `fetch-holdings`
Calls Kite MCP, normalizes response, writes `data/holdings.json`.

- **Inputs:** none (uses session-authenticated Kite MCP)
- **Output contract** (`data/holdings.json`):
  ```json
  {
    "fetched_at": "2026-06-11T15:32:01+05:30",
    "holdings": [
      {
        "symbol": "MTARTECH",
        "exchange": "NSE",
        "qty": 12,
        "avg_price": 1944.21,
        "ltp": 7106.5,
        "close_price": 7458.0,
        "invested": 23330.55,
        "current_value": 85278.0,
        "pnl": 61947.45,
        "pnl_pct": 265.5,
        "day_change": -351.5,
        "day_change_pct": -4.71,
        "weight_pct": 11.2
      }
    ],
    "summary": {
      "total_invested": 555000.0,
      "current_value": 612000.0,
      "total_pnl": 57000.0,
      "total_pnl_pct": 10.27,
      "day_pnl": -8200.0,
      "day_pnl_pct": -1.32,
      "holdings_count": 42,
      "winners": 18,
      "losers": 24
    }
  }
  ```
- **Computed fields:** `invested = qty * avg_price`, `current_value = qty * ltp`, `pnl_pct = pnl / invested * 100`, `weight_pct = current_value / sum(current_value) * 100`.
- **Atomicity:** writes to `holdings.json.tmp` then `os.rename` to `holdings.json`.

#### `generate-insights`
Reads `holdings.json`, produces `data/insights.md`.

- **Output:** ~150–250 word markdown summary covering top winners/losers, concentration risk, day's notable moves, headline takeaways.
- **Synthesis:** Claude generates the prose. Skill is a prompt template + read/write.

#### `launch-dashboard`
Spawns Streamlit in background, opens browser.

- Runs `streamlit run dashboard/app.py --server.port <P> --server.headless true` as a detached process.
- **Port selection:** scans 8501–8510, picks first free; aborts with clear error if all busy.
- Sleeps ~2s for boot, then `webbrowser.open("http://localhost:<P>")`.
- Writes `.streamlit.pid` and `.streamlit.port` for cleanup.

### Agent (`.claude/agents/portfolio-agent.md`)

- **Tools:** the 3 skills + Kite MCP read tools (`get_holdings`, `get_quotes`, `get_ltp`, `get_positions`, etc.) + Read/Write.
- **System prompt:** "You manage a user's stock portfolio. On `/portfolio`, run `fetch-holdings` → `generate-insights` → `launch-dashboard` in order. For follow-up questions, read `data/holdings.json` and call Kite MCP for current quotes if needed. Never place, modify, or cancel orders without explicit user confirmation containing the phrase 'yes, place this order' (or analogous for modify/cancel)."

### Slash Command (`.claude/commands/portfolio.md`)

One-liner that invokes the agent: "Run fetch-holdings → generate-insights → launch-dashboard, then report the dashboard URL." Supports `refresh` argument (re-runs same chain).

### Dashboard (`dashboard/app.py`)

Single-file Streamlit app, ~150–200 lines. Reads `data/holdings.json` + `data/insights.md` at startup and on refresh button press.

**Sections (top to bottom):**
1. **Header KPIs** — Current Value, Total Invested, Total P&L (₹/%), Day P&L (₹/%), holdings/winners/losers count
2. **AI Insights Panel** — markdown render of `insights.md`
3. **Holdings Table** — sortable: Symbol, Qty, Avg, LTP, Invested, Current, Day Δ%, Total P&L (₹/%), Weight %; color-coded green/red
4. **Allocation Visual** — pie/treemap by holding weight
5. **Performance Lens** — Top 5 winners / Top 5 losers (₹), two-column
6. **Concentration Risk Callout** — top 3 holdings as % of portfolio, with warning if > 40%
7. **Refresh Button + Staleness Banner** — re-reads files; if `fetched_at > 5min ago`, yellow banner: *"Data is X minutes old. Run `/portfolio refresh` in Claude to update."*
8. **Footer** — last fetched timestamp

## Data Flow

### Happy path
```
User types /portfolio
    │
    ▼
portfolio-agent invoked with orchestration prompt
    │
    ▼
[skill: fetch-holdings]
    │  ├─ calls mcp__kite__get_holdings
    │  ├─ transforms response
    │  └─ atomic write data/holdings.json
    ▼
[skill: generate-insights]
    │  ├─ reads data/holdings.json
    │  ├─ Claude synthesizes 150-250 word markdown summary
    │  └─ atomic write data/insights.md
    ▼
[skill: launch-dashboard]
    │  ├─ finds free port 8501..8510
    │  ├─ spawns streamlit (detached)
    │  ├─ writes .streamlit.pid + .streamlit.port
    │  ├─ sleep 2s for boot
    │  └─ webbrowser.open(URL)
    ▼
Agent prints: "Dashboard running at http://localhost:<P> (PID <pid>)"
```

### Refresh (Hybrid)
- `/portfolio refresh` → same chain, overwrites `holdings.json` + `insights.md`. Streamlit auto-reloads on file change (built-in).
- Dashboard's own refresh button → re-reads files only. If `fetched_at > 5min`, shows banner asking user to run `/portfolio refresh` in Claude.

## Error Handling

| Failure | Where caught | Behavior |
|---|---|---|
| Kite MCP returns "Please log in first" | `fetch-holdings` | Skill calls `mcp__kite__login`, returns login URL to user, halts orchestration |
| Kite MCP times out / network error | `fetch-holdings` | Retries once after 2s; on second failure, surfaces error, leaves existing `holdings.json` untouched |
| Empty holdings | `fetch-holdings` | Writes valid JSON with empty array + zeroed summary; insights produces "No holdings found"; dashboard renders empty state |
| `holdings.json` missing/malformed | `generate-insights`, dashboard | Skill aborts with clear message; dashboard shows "Run `/portfolio` to fetch data" empty state |
| All ports 8501–8510 busy | `launch-dashboard` | Aborts with message; user runs `pkill -f streamlit` or passes custom port |
| Streamlit not installed / boot failure | `launch-dashboard` | Captures stderr, hints `pip install -r dashboard/requirements.txt` |
| Agent asked to place/modify/cancel orders | `portfolio-agent` system prompt | Refuses without explicit confirmation phrase |

## Testing Strategy

| Layer | Test type | What it verifies |
|---|---|---|
| `fetch-holdings` transform math | Unit (pytest) | invested, current_value, pnl_pct, weight_pct correct vs fixture |
| `holdings.json` schema | Unit (jsonschema) | Output structure matches contract |
| Dashboard rendering | Streamlit `AppTest` | KPIs, table, charts render without exceptions on sample data |
| Empty-state rendering | Streamlit `AppTest` | Empty holdings shows correct message |
| Stale-banner logic | Unit | Returns true for `fetched_at > 5min`, false otherwise |
| `launch-dashboard` port-finding | Unit | Picks first free port in 8501–8510 |
| Atomic write helper | Unit | Killed mid-write leaves original file intact |
| End-to-end | Manual | `/portfolio` against live Kite MCP, dashboard opens and matches |

### Fixtures

- `tests/fixtures/kite_holdings_response.json` — trimmed real Kite MCP response (~5 holdings: winners, losers, BSE+NSE, ETF)
- `tests/fixtures/holdings_normalized.json` — expected output of `fetch-holdings` transform

### Out of scope (v1)

- Live Kite MCP calls in unit tests
- LLM output quality assertions (manual spot-check only)
- Browser auto-open (trust `webbrowser.open`)
- CI (single-user local project)

## Open Questions / Future Work

- **v2 — sector allocation:** add `sectors.json` + new `enrich-sectors` skill or third-party API
- **v2 — XIRR / true returns:** new `compute-xirr` skill that reads trade history via `mcp__kite__get_trades`
- **v2 — tax-loss harvest hints:** new skill flagging LTCG/STCG candidates near year-end
- **v2 — alerts:** background watcher that pings on threshold breaches
- **v2 — refresh inside dashboard:** optional Kite REST integration so the dashboard can re-fetch without going through Claude (would require user-managed API key)
