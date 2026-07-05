# Portfolio Dashboard Re-platform — Design

**Date:** 2026-07-06
**Status:** Approved design, pending implementation plan
**Supersedes:** the Streamlit + local-JSON dashboard (`dashboard/app.py`, `data/*.json`) and the Python skills wiring for the dashboard UI.

---

## 1. Summary

Re-platform the personal Zerodha Kite portfolio dashboard from **Streamlit + local JSON files** to a **single Next.js (App Router) application in TypeScript**, backed by a **local SQLite database** whose schema is Postgres-portable and multi-user-ready. Add a **per-stock fundamental analysis** feature (scorecard + narrative + peer comparison) sourced by scraping Screener.in.

The UI is adapted from an approved Figma Make design (Vite + React + TS + Tailwind + shadcn/ui, two pages: Overview and per-stock Deep-Dive).

This design is the product of a brainstorm plus three independent senior reviews (architect, backend, frontend). Their load-bearing findings are incorporated and cited inline.

---

## 2. Goals / Non-goals

### Goals
- Replace Streamlit with a Next.js app matching the Figma design (Overview + Deep-Dive pages).
- Persist holdings as a **daily time-series** so history accrues over time.
- Add **fundamental analysis** per stock: typed ratios + Good/Fair/Weak grades + ~120-word narrative + peer comparison.
- Keep everything **local and single-user** for now, but make the **schema multi-user-ready** (a `user_id` column on user-scoped tables) so a future migration is mechanical.
- One language across the repo: **TypeScript**.

### Non-goals (explicitly deferred — documented, not built)
- Multi-user onboarding, per-user Kite OAuth, token refresh, server-side scheduled ingestion.
- Hosting on Vercel. (Note: the hosting milestone == the SQLite→Postgres migration milestone; see §7.)
- Live trading / order placement (remains out of scope; agent stays read-only).
- Storing OHLC price history (fetched from Kite on demand, not persisted).

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  NEXT.JS app (local: `next dev`; Vercel later)               │
│  app/page.tsx            → Overview  (Server Component)      │
│  app/stock/[symbol]/…    → DeepDive  (Server Component)      │
│  app/api/refresh/…       → optional ingestion trigger        │
│  • Server-side data layer (lib/db.ts) queries SQLite         │
│  • Client components only for interactivity (charts, nav)    │
│  • shadcn/ui + Tailwind (from Figma) + Recharts              │
└───────────────┬─────────────────────────────────────────────┘
                │  server-side reads (better-sqlite3)
┌───────────────▼─────────────────────────────────────────────┐
│  SQLite — Postgres-portable schema, user_id on user tables   │
│  raw-only storage; derived values in shared util             │
└───────────────▲─────────────────────────────────────────────┘
                │  idempotent upserts (ON CONFLICT)
┌───────────────┴─────────────────────────────────────────────┐
│  INGESTION — Claude + portfolio-agent (local, on-demand)     │
│  Kite MCP → holdings · Screener adapter → fundamentals/peers  │
│  Node/TS writer (better-sqlite3) · snapshot_date in IST      │
└───────────────────────────────────────────────────────────────┘
```

**Key decisions:**
- **Next.js over Vite** — Server Components/Route Handlers query SQLite directly server-side, eliminating the separate local read-API a Vite SPA would need. Secrets stay server-side. File-based routing replaces `useState` navigation.
- **SQLite over Supabase (for now)** — data volume is ~KB/day; a cloud DB is over-built and its multi-user benefit is illusory until ingestion auth is solved (architect SEV-1/SEV-3). SQLite removes the service-role-key-on-laptop risk entirely (SEV-2 / backend P0 #1).
- **Unified TypeScript** — ingestion writer is Node/TS (`better-sqlite3`), retiring the Python `dashboard/`. The agent triggers ingestion and supplies Kite data; writing + scraping run in Node.

---

## 4. Data model (SQLite, Postgres-portable)

Principles enforced (all three reviewers):
- **Raw-only storage.** Store facts (qty, avg_price, ltp, close_price); compute derived values (pnl, pnlPct, weight, current, invested, dayPnl) in a **single shared TS util** used by both writer and reader. `weight` is portfolio-relative and is **never** stored per-row.
- **`NUMERIC`/`REAL` discipline.** Money and quantities use exact numeric handling; never trust binary float for rupee P&L. Note PostgREST/driver returns of numerics may be strings — mappers coerce explicitly.
- **Two RLS classes when we reach Postgres:** user-scoped tables (`user_id = auth.uid()`, both `USING` + `WITH CHECK`) vs. world-readable reference tables. `user_id` columns exist now in SQLite as plain columns.

### Tables

**`stock_meta`** — instrument dimension. *Global (not user-scoped).*
- PK `(symbol, exchange)`; columns: `isin`, `company`, `sector`, `exchange`.
- Rationale: bare `symbol` is ambiguous for dual-listed NSE/BSE stocks; `isin` is the stable cross-exchange identity (backend P1 #4).

**`holding_snapshots`** — per-holding daily time-series. *User-scoped.*
- `UNIQUE(user_id, snapshot_date, symbol, exchange)`; index `(user_id, symbol, snapshot_date)`.
- Raw columns: `qty`, `avg_price`, `ltp`, `close_price`. FK → `stock_meta(symbol, exchange)`.
- `snapshot_date` derived in **IST (Asia/Kolkata)** in the writer, not from UTC `now()` (backend P0 #2).

**`portfolio_snapshots`** — daily totals. *User-scoped.*
- `UNIQUE(user_id, snapshot_date)`; columns: `current_value`, `invested`, `total_pnl`, `day_pnl`, `holdings_count`, `winners`, `losers`.

**`fundamentals`** — typed ratios. *Global, keyed `(isin, as_of_date)`.*
- **Typed numeric columns** (NOT label/value strings — backend P1 #3): `pe`, `pb`, `roe`, `roce`, `debt_equity`, `sales_growth_3y`, `profit_growth_3y`, `div_yield`, `market_cap`, `promoter_holding`, plus sector-specific nullable columns (e.g. `gross_npa`, `nim` for banks).
- Provenance: `fetched_at`, `source`, `source_url`, `fetch_status`.
- Grades (Good/Fair/Weak) are **computed at read time** from a thresholds config, not stored.

**`peers`** — peer comparison rows. *Global, keyed by `isin` (of the subject stock).*
- Numeric `pe`, `roe`, `roce`, `sales_growth` (nullable); `peer_symbol`, `peer_company`.

**`analysis`** — LLM narrative cache. *Global, keyed `(isin, generated_at)`.*
- `narrative` text, `model_version`, `prompt_version`. Regenerable; clearly derived, not scraped fact.

### Views / shared logic
- `v_holdings_current` — latest snapshot per (user, symbol). Replaces a separate `holdings_current` table (backend P2 #7; removes dual-write drift).
- `lib/derive.ts` — the single source of truth for pnl/weight/pct math, imported by writer and readers.

---

## 5. Frontend

- **Routing:** Next App Router. `app/page.tsx` → Overview; `app/stock/[symbol]/page.tsx` → Deep-Dive. Solves deep-linking, back button, refresh persistence (all three reviewers P0). Replaces Figma's `useState<selectedSymbol>`.
- **Data fetching:** initial loads via Server Components querying `lib/db.ts` directly. **TanStack Query** only for client-driven refetch (Refresh button, history range selector). A hooks/fetcher seam keeps data access out of presentational components.
- **Types:** DB row types (snake_case) mapped to UI types (camelCase: `Holding`, `FundamentalItem`, `Peer`, `StockDetail`) via explicit mappers that coerce numerics. Never share one type across DB and UI layers (frontend P1 #5).
- **States:** first-class loading (shadcn `Skeleton`), empty (new/empty portfolio; stock with no fundamentals/peers must render gracefully), and error (distinguish auth/RLS from network) — Figma output is happy-path only (frontend P1 #6).
- **Charts:** **Recharts** for donut/treemap allocation, winners/losers bars, and historical line — one chart engine, shadcn-native theming (frontend P1 #7).
- **Auth-ready shell:** a provider shell at the root (auth context yielding a static/local user now) so real auth slots in later without threading user through fetchers (frontend P2 #9).
- **Cross-cutting:** shared INR formatting (`en-IN`, lakh/crore), P&L sign/color with a non-color cue (arrow/aria) for accessibility, and a visible "as of <timestamp>" since LTP is only as fresh as the last ingest.

---

## 6. Ingestion

- **Trigger:** on-demand, human-in-the-loop (Kite token expires daily and requires interactive OAuth — blocks unattended scheduling; all three reviewers). The `portfolio-agent` orchestrates.
- **Holdings:** Kite MCP (`get_holdings`, quotes) → normalized → upsert into `holding_snapshots` + `portfolio_snapshots`.
- **Fundamentals/peers:** a **validated Screener.in adapter** — schema-validate every fetch, reject/flag rather than persist garbage; stamp `fetched_at`/`source`/`fetch_status`; **degrade to stale-labeled, never blank-on-fail** (upsert only on success). Decoupled from the holdings path so a Screener break never blocks the portfolio view (architect SEV-4 / backend P2 #8). TTL ~24h checked at read time.
- **Idempotency:** `INSERT ... ON CONFLICT (natural key) DO UPDATE` — re-running the same trading day overwrites that day's rows (last-write-wins); never creates duplicate rows (backend P0 #2).
- **Gap tolerance:** time-series is one-row-per-trading-day-actually-run; readers/charts must handle non-contiguous dates (weekends, holidays, skipped days) and never `generate_series` blindly (all three reviewers).
- **Grades & narrative:** grades = threshold logic at read time; narrative = LLM-generated, stored with model/prompt version.

---

## 7. Migration path to hosted / multi-user (deferred)

The hosting milestone **is** the SQLite→Postgres migration (SQLite doesn't run on Vercel serverless). To keep it mechanical:
- DB access is a thin swappable module (`lib/db.ts`); schema is authored in Postgres-compatible SQL.
- `user_id` columns and the reference/user table split already exist.
- The real deferred work is not the DB — it's a **server-side ingestion service with per-user Kite OAuth + token refresh + secret management** (architect SEV-1). Budgeted as its own future project; "Supabase has Auth" is explicitly NOT treated as having built multi-user ingestion.

---

## 8. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Screener scraping breaks silently | High | Validated adapter, `fetch_status`, stale-labeled degrade, decoupled from holdings |
| Daily Kite token blocks automation | High | Accept on-demand ingestion; gap-tolerant schema; document clearly |
| Derived-field drift | Med | Raw-only storage; single shared `derive.ts` |
| LTP staleness misread as live | Med | "as of <timestamp>" in UI |
| SQLite→Postgres migration friction | Med | Portable schema, thin `db.ts`, `user_id` present now |
| Instrument ambiguity (dual-listed) | Med | `stock_meta` keyed `(symbol, exchange)` + `isin`; fundamentals/peers keyed by `isin` |

---

## 9. Retirement

Removed once the Next app is at parity: `dashboard/app.py`, `dashboard/launch.py`, `dashboard/fetch_holdings.py`, `dashboard/requirements.txt`, `data/*.json`, `.streamlit*`, and the Python-oriented dashboard skills. The `fetch-holdings` / `generate-insights` concepts migrate into the Node/TS ingestion + LLM narrative step.
