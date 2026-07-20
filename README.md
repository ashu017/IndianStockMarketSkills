# Portfolio Dashboard

A local Zerodha Kite portfolio dashboard with per-stock fundamental analysis, built as a
Next.js (App Router, TypeScript) app backed by local SQLite. Holdings are pulled from Kite
via the Kite MCP server (through the Claude Code `portfolio-agent`), normalized into a
daily time-series, and rendered in a light, minimalist UI adapted from a Figma design.

> Re-platformed from the original Streamlit + local-JSON prototype. See
> `docs/superpowers/specs/2026-07-06-portfolio-replatform-design.md` for the design and
> the reasoning (three senior reviews are folded in).

## Stack

- **Next.js 16** (App Router, RSC-only data fetching) + **TypeScript**
- **SQLite** via `better-sqlite3` — money stored as INTEGER minor units, dates as IST `YYYY-MM-DD`
- **Tailwind + shadcn-style components** + **Recharts**
- **Vitest** for unit tests
- **Kite MCP** for holdings ingestion (a dormant direct **Kite Connect** API client is also included, for later)

## Prerequisites

- Node.js 20+
- The **Kite MCP** server connected in Claude Code:
  ```bash
  claude mcp add --transport sse kite https://mcp.kite.trade/sse
  ```

## Setup

```bash
npm install
cp .env.example .env      # adjust if needed (DB path, user id, optional Kite Connect keys)
npm run migrate           # create the SQLite schema at data/portfolio.db
```

## Usage

### Fetch data + launch (via Claude Code)

In Claude Code, run:

```
/portfolio
```

This drives the `portfolio-agent` to: fetch live holdings from the Kite MCP → normalize and
upsert a daily snapshot into SQLite → generate an AI insights summary → launch the dashboard.
If your Kite session has expired, it surfaces a login link and stops; log in and re-run.

### Run the dashboard directly

```bash
PORTFOLIO_DB_PATH=./data/portfolio.db PORTFOLIO_USER_ID=local npm run dev -- --port 3210
```

Then open **http://127.0.0.1:3210**.

- **Overview** (`/`) — KPIs, AI insights, sortable holdings table, allocation donut,
  top winners/losers, concentration callout.
- **Deep-dive** (`/stock/[symbol]`) — position stats, price history, fundamentals scorecard,
  analysis narrative, and peer comparison.

The in-app **Refresh** button re-reads the latest snapshot from SQLite. To pull *new* data
from Kite, run `/portfolio` again.

> Port 3000 is avoided in examples because it is commonly taken by other local processes;
> any free port works (`--port <n>`).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the Next.js dev server |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run migrate` | Apply `db/schema.sql` to the SQLite database |
| `npm run test` | Run the Vitest unit suite |

## Project layout

```
app/                     Next.js App Router (pages + /api routes)
components/portfolio/    Overview + Deep-Dive UI (from the Figma design)
lib/
  db/                    SQLite connection + async, user-scoped query seam
  ingest/                Kite normalize, snapshot writer, payload builder, Kite Connect client
  money.ts               INTEGER minor-unit helpers
  derive.ts              P&L / weight / % math (single source of truth)
  types.ts               DB row types + UI types
db/schema.sql            SQLite schema (Postgres-portable)
scripts/ingest.ts        Ingestion CLI (MCP payload or cached Kite session)
docs/superpowers/        Design specs, API definitions, diagrams, and implementation plan
```

## Data & privacy

- All data is **local** (SQLite at `data/portfolio.db`); the DB and WAL sidecars are gitignored.
- Secrets live only in `.env` (gitignored). This repo is public — never commit credentials.
- Read-only: the agent has no order-placement tools; it observes and reports, never trades.

## Status / roadmap

- ✅ Holdings ingestion, daily snapshots, Overview + Deep-Dive UI, AI insights
- 🚧 **Fundamentals & peers** — the Screener.in adapter is currently a stub, so the
  fundamentals scorecard / peer table render empty-safe placeholders until it is built.
- 💤 **Kite Connect direct API** (token cache, optional TOTP auto-login) is implemented but
  dormant behind unset env vars; the default flow uses the Kite MCP.

## Architecture

- Design: `docs/superpowers/specs/2026-07-06-portfolio-replatform-design.md`
- API definitions: `docs/superpowers/specs/2026-07-06-api-definitions.md`
- Diagrams (PlantUML): `docs/superpowers/specs/diagrams/`
- Implementation plan: `docs/superpowers/plans/2026-07-06-portfolio-replatform.md`
