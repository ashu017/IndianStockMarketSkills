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
- **Data fetching: RSC-only (no TanStack Query)** — for a single-user, read-mostly dashboard, Server Components read SQLite for all data; refresh via `router.refresh()` + `revalidatePath`; the history range selector is a URL search param (`?range=1M`) that re-runs the RSC. This removes the client `QueryClientProvider`, the RSC↔client duplication/hydration risk, and a dependency (frontend round-2 P0 #3, architect concurrence).

---

## 4. Data model (SQLite, Postgres-portable)

Principles enforced (all three reviewers):
- **Raw-only storage.** Store facts (qty, avg_price, ltp, close_price); compute derived values (pnl, pnlPct, weight, current, invested, dayPnl) in a **single shared TS util** used by both writer and reader. `weight` is portfolio-relative and is **never** stored per-row.
- **Money as INTEGER, exact (backend round-2 P0).** SQLite has **no** exact decimal type — a `NUMERIC`/`REAL` column stores IEEE-754 float and would both violate "no binary float for P&L" *and* silently diverge from Postgres `NUMERIC`. Therefore money and quantities are stored as **INTEGER minor units**: rupee amounts as **paise** (₹×100); prices that carry fractional paise (Kite `avg_price`) at a fixed higher scale (**×10000**, i.e. 1/100 paise). Each monetary column documents its scale. `lib/money.ts` centralizes scale/rounding (half-up, banker's-rounding decision made there); `derive.ts` operates in minor units and only the UI mapper converts to display rupees. Migrates cleanly to Postgres `BIGINT` (or `NUMERIC` with a documented scale).
- **Dates/timestamps as TEXT (backend round-2 P2).** `snapshot_date`/`as_of_date` = `TEXT 'YYYY-MM-DD'` computed in **IST (Asia/Kolkata)** so per-day UNIQUE semantics and lexical comparison are timezone-independent. Provenance timestamps (`fetched_at`, `generated_at`) = ISO-8601 **UTC** TEXT so they sort lexically and map to Postgres `timestamptz`.
- **Two RLS classes when we reach Postgres:** user-scoped tables (`user_id = auth.uid()`, both `USING` + `WITH CHECK`) vs. world-readable reference tables. `user_id` columns exist now in SQLite as plain columns. **Access discipline (architect round-2 SEV-3):** for the entire SQLite lifetime nothing *enforces* user scoping, so **all user-scoped reads/writes go through helpers that require a `userId` argument** — never ad-hoc SQL — so the eventual RLS migration is habitual, not a hunt for missing `WHERE user_id = ?`.

### Tables

**`stock_meta`** — instrument dimension. *Global (not user-scoped).*
- PK `(symbol, exchange)`; columns: `isin`, `company`, `sector`, `exchange`.
- Rationale: bare `symbol` is ambiguous for dual-listed NSE/BSE stocks; `isin` is the stable cross-exchange identity (backend P1 #4).

**`holding_snapshots`** — per-holding daily time-series. *User-scoped.*
- `UNIQUE(user_id, snapshot_date, symbol, exchange)`; index `(user_id, symbol, snapshot_date)`.
- Raw columns (INTEGER minor units): `qty`, `avg_price` (×10000), `ltp` (paise), `close_price` (paise). FK → `stock_meta(symbol, exchange)` — enforced only with `PRAGMA foreign_keys = ON` (see §4a); writer upserts `stock_meta` before snapshots in the same transaction.
- `snapshot_date` derived in **IST (Asia/Kolkata)** in the writer, not from UTC `now()` (backend P0 #2).

**`portfolio_snapshots`** — daily totals. *User-scoped.*
- `UNIQUE(user_id, snapshot_date)`; columns: `current_value`, `invested`, `total_pnl`, `day_pnl` (all INTEGER paise), `holdings_count`, `winners`, `losers`.
- Note: `holdings_count`/`winners`/`losers` are **denormalized daily aggregates** — an intentional, acknowledged exception to raw-only (recomputable from that day's `holding_snapshots`), kept as a cheap daily summary (backend round-2 P2).

**`fundamentals`** — universal typed ratios. *Global.* **`UNIQUE(isin, as_of_date)`** (upsert target; `as_of_date` is date-granular → same-day re-fetch overwrites).
- **Typed numeric columns** for metrics that apply to nearly all equities (backend P1 #3): `pe`, `pb`, `roe`, `roce`, `debt_equity`, `sales_growth_3y`, `profit_growth_3y`, `div_yield`, `market_cap`, `promoter_holding`.
- Provenance: `fetched_at`, `source`, `source_url`, `fetch_status`.

**`fundamentals_extra`** — sector-specific long-tail metrics (backend round-2 P1). *Global.* **`UNIQUE(isin, as_of_date, metric_key)`**.
- Narrow typed-EAV: `isin`, `as_of_date`, `metric_key` (enum validated per sector — e.g. `gross_npa`, `net_npa`, `nim`, `casa`, `car` for banks; others per sector), `value_num` (REAL/INTEGER), `unit`.
- Rationale: avoids a 60-column sparse table and per-sector `ALTER TABLE`; keeps SQL filtering/sorting on the common ratios in `fundamentals`.

**`peers`** — peer comparison rows (one-to-many). *Global.* **`UNIQUE(isin, as_of_date, peer_symbol)`** (backend round-2 P1 — "keyed by isin" alone is wrong for a many-row table and gives no upsert target).
- `isin` (subject), `as_of_date`, `peer_symbol`, `peer_company`, numeric `pe`, `roe`, `roce`, `sales_growth` (nullable).

**`analysis`** — LLM narrative cache. *Global.* **`UNIQUE(isin)`** — latest-wins cache, upsert overwrites (NOT keyed by `generated_at`, which would append forever; backend round-2 P1).
- `narrative` text, `generated_at` (ISO-8601 UTC), `model_version`, `prompt_version`. Regenerable; clearly derived, not scraped fact.

### Grades & thresholds
- Grades (Good/Fair/Weak) are **computed at read time** from a thresholds config, not stored.
- **Thresholds are sector-keyed and versioned (backend round-2 P1/SEV-4):** D/E is meaningless for a bank, NIM/GNPA are null for non-banks — a flat threshold set would mis-grade. Config carries a `version` so retuning doesn't silently change the meaning of past "as of" views (parity with `analysis`'s `prompt_version`).

### Views / shared logic
- `v_holdings_current` — latest snapshot per (user, symbol). Replaces a separate `holdings_current` table (backend P2 #7; removes dual-write drift). **Must use `ROW_NUMBER() OVER (PARTITION BY user_id, symbol ORDER BY snapshot_date DESC)`, NOT SQLite's non-standard bare-`MAX()`+`GROUP BY` idiom** (which returns undefined results on Postgres — architect round-2 SEV-4 / backend round-2 P2). Served by index `(user_id, symbol, snapshot_date)`.
- `lib/derive.ts` — the single source of truth for pnl/weight/pct math (operates in INTEGER minor units), imported by writer and readers.
- `lib/money.ts` — scale constants + rounding contract for the INTEGER-paise representation.

---

## 4a. Storage-engine & Next integration mechanics

These are the round-2 findings the first review couldn't surface. They are load-bearing, not polish.

### SQLite connection (both reader and writer)
- **WAL mode + busy_timeout (backend/architect round-2 P0/SEV-1):** every connection opens with `PRAGMA journal_mode = WAL` and `PRAGMA busy_timeout = 5000`. Without this, a page render (reader) concurrent with a refresh (writer) throws `SQLITE_BUSY` — exactly the app's core refresh-then-view loop. WAL adds `-wal`/`-shm` sidecar files → relevant to §9 backup/gitignore.
- **`PRAGMA foreign_keys = ON` (backend round-2 P0):** off by default, per-connection; set on every open or the `stock_meta` FK is decorative.
- **Transactions (backend round-2 P2):** each refresh wraps the multi-table, multi-row write (`stock_meta` → `holding_snapshots` → `portfolio_snapshots`) in a single `db.transaction()` — atomicity (no half-written snapshot day) and `better-sqlite3` performance (one fsync, not one per row).
- **`ON CONFLICT` targets:** every upsert conflict target corresponds to an explicit declared `UNIQUE` constraint (enumerated per table in §4); SQLite errors on a target with no matching unique index.

### `better-sqlite3` in Next (frontend/architect round-2 P0/SEV-2)
- **`serverExternalPackages: ['better-sqlite3']`** in `next.config.js` — it's a native addon; the bundler must not trace it (Next 15 key; `experimental.serverComponentsExternalPackages` on 14).
- **`globalThis` connection singleton** — `next dev` HMR re-evaluates modules; a module-scoped `new Database()` leaks handles. Cache on `globalThis` (the Prisma-in-dev pattern).
- **`import 'server-only'`** at the top of `lib/db.ts` — build-time guard so a Client Component importing it fails loudly instead of leaking the driver client-side.
- **`export const dynamic = 'force-dynamic'`** (or `revalidate = 0`) on data routes — the portfolio is live data; without a dynamic signal Next may statically prerender and serve a stale/absent-DB snapshot. Post-ingest freshness comes from `revalidatePath('/')` / `router.refresh()` (no `fetch` cache applies since reads aren't `fetch`).

### Async-shaped, always-scoped data seam (architect round-2 SEV-3)
- `lib/db.ts` exposes an **async** interface (`await getHoldings(userId)`) even though `better-sqlite3` is synchronous underneath. The eventual `pg`/Postgres client is async; shaping the seam async now makes that swap mechanical instead of rippling a sync→async change into every call site. This is the honest content behind "portable" — see §7 (language downgraded from "mechanical").

---

## 5. Frontend

- **Routing:** Next App Router. `app/page.tsx` → Overview; `app/stock/[symbol]/page.tsx` → Deep-Dive. Solves deep-linking, back button, refresh persistence (all three reviewers P0). Replaces Figma's `useState<selectedSymbol>`.
- **Data fetching — RSC-only (frontend round-2 P0 #3):** Server Components read `lib/db.ts` for all data. **No TanStack Query, no `QueryClientProvider`.** Refresh = `router.refresh()` + `revalidatePath`. History range = URL search param (`?range=1M`) that re-runs the RSC. This removes the RSC↔client data-ownership duplication and hydration-mismatch risk class entirely.
- **Server/client boundary — the real port work (frontend round-2 P1 #6):** the Figma Make output is one monolithic client tree (`useState` nav, inline `data.ts`, handlers throughout). The port is a **boundary-drawing exercise**: default every component to Server, add `'use client'` only at interactive leaves. Do NOT slap `'use client'` on every ported file — that rebuilds a Vite SPA inside Next and forfeits §3's rationale.
- **Charts as client leaves (frontend round-2 P1 #4):** **Recharts** (donut/treemap allocation, winners/losers bars, historical line) is client-only. Pattern: Server Component does the DB read + `derive.ts` math and passes **only plain serializable data** (no `Date`, no functions) into a thin `'use client'` chart leaf, rendered via `next/dynamic(..., { ssr: false })` behind a Skeleton. One chart engine; shadcn-native theming.
- **Types:** DB row types (snake_case) mapped to UI types (camelCase: `Holding`, `FundamentalItem`, `Peer`, `StockDetail`) via explicit mappers. Never share one type across layers (frontend P1 #5). Note: `better-sqlite3` returns `REAL`/`INTEGER` as JS `number` **today** (the numeric-as-string caveat is a Postgres/PostgREST *future* concern) — the mapper contract is "coerce whatever the backend returns to `number` (and minor-units→rupees for money)"; don't write dead string-parsing now (frontend round-2 P2 #10).
- **States via Suspense (frontend P1 #6 + round-2 P2 #8):** first-class loading (shadcn `Skeleton`), empty (empty portfolio; a stock with no fundamentals/peers must render gracefully), error (distinguish auth from network). Use RSC `<Suspense>` boundaries — Overview totals/holdings render instantly from the fast SQLite read while the historical chart and the slower/possibly-stale Screener fundamentals stream in behind fallbacks. The Screener-decoupling boundary (§6) maps directly onto a Suspense boundary.
- **Auth-ready shell (frontend round-2 P1 #5):** a root provider renders `{children}` so pages stay Server Components; only components that *consume* auth are client leaves. For today's single static local user this may just be a server-side `getCurrentUser()` helper — a Context provider only earns its place once client components need the user.
- **shadcn/ui in Next is re-init, not copy (frontend round-2 P1 #7):** run `npx shadcn init` against the Next project (don't copy the Vite export wholesale); Tailwind `content` globs must cover `app/**` (Figma's point at `src/**` — miss this and prod renders unstyled); `components.json`, `cn()`, and `@/` aliases re-established.
- **Env/secrets (frontend round-2 P2 #9):** only `NEXT_PUBLIC_`-prefixed vars reach the client bundle; the SQLite file path, Kite tokens, and Screener config stay server-only (never `NEXT_PUBLIC_`).
- **Cross-cutting:** INR formatting done **once, server-side**, shipping formatted strings to avoid `Intl` SSR/client hydration drift (the shared util must be isomorphic + deterministic for the client chart tooltip; frontend round-2 P2 #11). P&L sign/color with a non-color cue (arrow/aria). Visible "as of <timestamp>" since LTP is only as fresh as the last ingest.

---

## 6. Ingestion

- **Trigger:** on-demand, human-in-the-loop (Kite token expires daily and requires interactive OAuth — blocks unattended scheduling; all three reviewers). The `portfolio-agent` orchestrates.
- **Holdings:** Kite MCP (`get_holdings`, quotes) → normalized → upsert into `holding_snapshots` + `portfolio_snapshots`.
- **Fundamentals/peers:** a **validated Screener.in adapter** — schema-validate every fetch, reject/flag rather than persist garbage; stamp `fetched_at`/`source`/`fetch_status`; **degrade to stale-labeled, never blank-on-fail** (upsert only on success). Decoupled from the holdings path so a Screener break never blocks the portfolio view (architect SEV-4 / backend P2 #8). TTL ~24h checked at read time.
- **Idempotency:** `INSERT ... ON CONFLICT (natural key) DO UPDATE` against the explicit UNIQUE constraints in §4 — re-running the same trading day overwrites that day's rows (last-write-wins); never creates duplicate rows (backend P0 #2). Whole refresh wrapped in one `db.transaction()` (§4a).
- **Gap tolerance:** time-series is one-row-per-trading-day-actually-run; readers/charts must handle non-contiguous dates (weekends, holidays, skipped days) and never `generate_series` blindly (all three reviewers).
- **Trigger mechanics — resolves the `/api/refresh` ambiguity (architect round-2 SEV-5):** the Refresh button calls a Next Route Handler that **spawns the standalone ingestion process** (not an in-process write). This keeps a single writer process, so WAL's one-writer rule holds and the reader never contends as writer. On completion the route calls `revalidatePath('/')`. Ingestion never writes inside the request-render path.
- **Grades & narrative ownership (was under-specified):** grades = sector-keyed threshold logic at read time. The **narrative is generated during ingestion** (the `portfolio-agent`/Claude step has the LLM), written to the `analysis` table with `model_version`/`prompt_version`; the Next app only *reads* it. This pins the previously-open "who invokes the LLM" question.

---

## 7. Migration path to hosted / multi-user (deferred)

The hosting milestone **is** the SQLite→Postgres migration (SQLite doesn't run on Vercel serverless). It is **portable with a documented translation step — not a zero-touch mechanical swap** (architect/backend round-2 SEV-3/P2). Known deltas to translate:
- **Async seam already in place** (§4a) — `better-sqlite3` (sync) → `pg` (async) is the biggest trap; shaping `lib/db.ts` async now absorbs it.
- **Money:** INTEGER minor units → Postgres `BIGINT` or `NUMERIC(scale)` (documented per column).
- **View idiom:** `v_holdings_current` already uses `ROW_NUMBER()` (portable), not the SQLite bare-`MAX()` trick.
- **Types:** SQLite INTEGER 0/1 flags → Postgres `boolean`; TEXT ISO dates → `date`/`timestamptz`; any `COLLATE NOCASE` symbol matching → explicit Postgres collation.
- `user_id` columns and the reference/user table split already exist; access already goes through user-scoped helpers so RLS (`USING` + `WITH CHECK`) drops in.
- The real deferred work is not the DB — it's a **server-side ingestion service with per-user Kite OAuth + token refresh + secret management** (architect SEV-1). Budgeted as its own future project; "Supabase has Auth" is explicitly NOT treated as having built multi-user ingestion.

---

## 8. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Reader/writer `SQLITE_BUSY` contention | High | WAL + `busy_timeout`; single writer process (refresh route spawns ingestion, never writes in-process) — §4a/§6 |
| Money precision / float divergence | High | INTEGER minor units + `lib/money.ts`; never `REAL` for money — §4 |
| Screener scraping breaks / gets blocked | High | Validated adapter, `fetch_status`, stale-labeled degrade, decoupled from holdings. Accepted as personal-use, best-effort, no SLA; evaluate a paid API before any multi-user move (architect round-2 SEV-4/5) |
| Daily Kite token blocks automation | High | Accept on-demand ingestion; gap-tolerant schema; document clearly |
| FK not enforced / half-written day | Med | `PRAGMA foreign_keys=ON`; whole refresh in one transaction — §4a |
| Derived-field drift | Med | Raw-only storage; single shared `derive.ts` |
| LTP staleness misread as live | Med | "as of <timestamp>" in UI |
| SQLite→Postgres migration friction | Med | Async seam now; portable idioms; documented translation deltas (§7) — "portable", not "mechanical" |
| Instrument ambiguity (dual-listed) | Med | `stock_meta` keyed `(symbol, exchange)` + `isin`; fundamentals/peers keyed by `isin` |
| Local DB has no backup/durability | Low | Not in repo; a `cp`/snapshot of the `.db` (+`-wal`/`-shm`) is the durability story — noted, not automated for v1 |

---

## 9. Retirement

Removed once the Next app is at parity: `dashboard/app.py`, `dashboard/launch.py`, `dashboard/fetch_holdings.py`, `dashboard/requirements.txt`, `data/*.json`, `.streamlit*`, and the Python-oriented dashboard skills. The `fetch-holdings` / `generate-insights` concepts migrate into the Node/TS ingestion + LLM narrative step. Note: WAL sidecar files (`*.db-wal`, `*.db-shm`) must be gitignored alongside the DB.
