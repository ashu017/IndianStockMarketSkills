# Portfolio Dashboard — API Definitions

**Date:** 2026-07-06
**Companion to:** `2026-07-06-portfolio-replatform-design.md`
**Diagrams:** `diagrams/schema.puml`, `diagrams/architecture.puml`, `diagrams/refresh-sequence.puml`

Because the app is **RSC-only** (design §3), there is deliberately **almost no public HTTP API**. Data flows through two internal surfaces plus one HTTP route:

1. **Data-access seam** (`lib/db.ts`) — async, always user-scoped TypeScript functions that Server Components call directly. This is the real "API".
2. **HTTP surface** — a single `POST /api/refresh` route handler (triggers ingestion).
3. **UI type contracts** — the shapes mappers produce for components.

All money crosses these boundaries as **rupee numbers already converted from INTEGER minor units** (conversion happens in the mapper); the DB seam returns minor units, the UI types carry rupees. Every timestamp is ISO-8601 UTC; `snapshot_date`/`as_of_date` are `YYYY-MM-DD` (IST).

---

## 1. Data-access seam — `lib/db.ts`

Rules (design §4/§4a):
- **Async signatures** even though `better-sqlite3` is synchronous — makes the Postgres swap mechanical.
- **Every user-scoped function takes `userId` as its first argument** — no ambient/implicit user; enforces the access discipline that stands in for RLS until Postgres.
- `import 'server-only'` at the top; never imported by a client component.
- Returns **DB-shaped rows** (minor units, snake_case); mappers convert to UI types (§3).

### Reads (user-scoped)

```ts
// Latest holdings (from v_holdings_current) joined to stock_meta.
getHoldings(userId: string): Promise<HoldingRow[]>

// Portfolio totals for the latest snapshot_date.
getPortfolioSummary(userId: string): Promise<PortfolioSummaryRow | null>

// One holding's latest position + instrument meta.
getHolding(userId: string, symbol: string, exchange: string): Promise<HoldingRow | null>

// Daily portfolio totals over a range (gap-tolerant; non-contiguous dates).
// range ∈ '1M' | '3M' | '6M' | '1Y' | 'ALL'  → resolved to a start date server-side.
getPortfolioHistory(userId: string, range: Range): Promise<PortfolioSnapshotRow[]>

// One symbol's per-day series (for the deep-dive sparkline / history).
getHoldingHistory(userId: string, symbol: string, exchange: string, range: Range): Promise<HoldingSnapshotRow[]>
```

### Reads (global reference — no userId)

```ts
// Universal ratios + sector-specific extras for a stock, latest as_of_date.
getFundamentals(isin: string): Promise<{ core: FundamentalsRow | null; extra: FundamentalsExtraRow[]; }>

// Peer rows for the subject stock, latest as_of_date.
getPeers(isin: string): Promise<PeerRow[]>

// Latest narrative (analysis cache) for a stock.
getAnalysis(isin: string): Promise<AnalysisRow | null>

// Resolve symbol/exchange → instrument identity (isin, company, sector).
getStockMeta(symbol: string, exchange: string): Promise<StockMetaRow | null>
```

### Writes (ingestion only — used by the writer, not the Next app)

All wrapped in a single `db.transaction()`; each is an `INSERT … ON CONFLICT(<unique>) DO UPDATE` (idempotent, last-write-wins per day).

```ts
upsertStockMeta(rows: StockMetaRow[]): void
upsertHoldingSnapshots(userId: string, snapshotDate: string, rows: HoldingSnapshotRow[]): void
upsertPortfolioSnapshot(userId: string, snapshotDate: string, totals: PortfolioSummaryRow): void
upsertFundamentals(isin: string, asOfDate: string, core: FundamentalsRow, extra: FundamentalsExtraRow[]): void
upsertPeers(isin: string, asOfDate: string, rows: PeerRow[]): void
upsertAnalysis(isin: string, row: AnalysisRow): void   // UNIQUE(isin): overwrite
```

### Grade computation (read-time, not stored)

```ts
// Sector-keyed, versioned thresholds → Good | Fair | Weak.
gradeMetric(sector: string, metricKey: string, value: number): Grade
gradeThresholdsVersion(): string   // surfaced in UI provenance
```

---

## 2. HTTP surface — Route Handlers

The only HTTP endpoint. The range selector and navigation are **URL/RSC**, not API calls (design §3/§5).

### `POST /api/refresh`

Triggers on-demand ingestion. **Spawns the standalone ingestion process** (single-writer guarantee, design §6); never writes in-process. On success calls `revalidatePath('/')`; the client then `router.refresh()`.

**Request body** (optional):
```jsonc
{ "mode": "full" | "holdings-only" }   // default "full"; holdings-only skips Screener/LLM
```

**Responses:**
```jsonc
// 200 — ingestion complete
{ "status": "ok", "snapshotDate": "2026-07-06",
  "holdings": 42, "fundamentalsUpdated": 15, "fundamentalsStale": 2 }

// 202 — already running (single writer; a refresh is in flight)
{ "status": "in_progress" }

// 409 — Kite login required (token expired) — surfaces the login URL, stops
{ "status": "login_required", "loginUrl": "https://kite.zerodha.com/connect/login?..." }

// 500 — ingestion failed (holdings path); existing data left intact
{ "status": "error", "message": "..." }
```

**Notes:**
- A Screener/fundamentals failure does **not** fail the request — it returns `200` with `fundamentalsStale`/skips, because fundamentals are decoupled from the holdings path (design §6). Only a holdings-path failure yields `500`.
- No auth on this route for the local single-user build; when hosted, it gates on the authenticated user and ingestion runs per-user (deferred, design §7).

---

## 3. UI type contracts (mapper output)

These are the camelCase shapes components consume — aligned with the Figma `data.ts` interfaces so the mock→live swap is invisible (design §5). Money is **rupees** (converted from minor units in the mapper).

```ts
interface Holding {
  symbol: string; company: string; exchange: 'NSE' | 'BSE'; sector: string;
  qty: number; avgPrice: number; ltp: number; dayChangePct: number;
  invested: number; current: number; pnl: number; pnlPct: number;
  dayPnl: number; weight: number;             // weight computed, never stored
}

interface FundamentalItem { label: string; value: string; grade: 'Good' | 'Fair' | 'Weak'; }
//  value = display string formatted from numeric column (e.g. "27.4×"); grade = read-time.

interface Peer { symbol: string; company: string; pe: number | null; roe: number; roce: number | null; salesGrowth: number; }

interface StockDetail {
  fundamentals: FundamentalItem[];   // core + sector extras, graded
  analysis: string;                  // narrative from analysis table
  peers: Peer[];
  provenance: { fetchedAt: string; fetchStatus: 'ok' | 'stale' | 'failed';
                thresholdsVersion: string; modelVersion?: string };
}

interface PortfolioSummary {
  currentValue: number; invested: number; totalPnl: number; totalPnlPct: number;
  dayPnl: number; dayPnlPct: number; holdingsCount: number; winners: number; losers: number;
  asOf: string;                      // "as of <timestamp>" freshness label
}

type Range = '1M' | '3M' | '6M' | '1Y' | 'ALL';
```

---

## 4. Consumption map (which page calls what)

| Surface | Overview (`/`) | Deep-Dive (`/stock/[symbol]`) |
|---|---|---|
| `getPortfolioSummary` | ✓ (KPI row) | — |
| `getHoldings` | ✓ (table, allocation, winners/losers, concentration) | — |
| `getPortfolioHistory` | ✓ (history chart; `?range=`) | — |
| `getHolding` | — | ✓ (position stats) |
| `getFundamentals` + `gradeMetric` | — | ✓ (scorecard) |
| `getAnalysis` | — | ✓ (narrative) |
| `getPeers` | — | ✓ (peer table) |
| `getHoldingHistory` | — | ✓ (per-stock sparkline) |
| `POST /api/refresh` | ✓ (Refresh button) | ✓ (Refresh button) |

Deep-Dive splits into Suspense boundaries: position stats render instantly; fundamentals/peers/analysis stream in behind a Skeleton (design §5), so a slow/stale Screener never blocks the page.
