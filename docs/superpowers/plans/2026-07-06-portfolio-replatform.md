# Portfolio Re-platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Streamlit + local-JSON portfolio dashboard with a single Next.js (App Router, TypeScript) app backed by local SQLite, adding per-stock fundamental analysis.

**Architecture:** RSC-only Next.js app reads a local SQLite DB (INTEGER minor-unit money, TEXT IST dates) through an async, always-user-scoped seam (`lib/db.ts`). A Node/TS ingestion writer (spawned by `POST /api/refresh`) pulls Kite holdings + scrapes Screener fundamentals and upserts idempotently in one transaction. See `../specs/2026-07-06-portfolio-replatform-design.md` and `../specs/2026-07-06-api-definitions.md`.

**Tech Stack:** Next.js 15 (App Router), TypeScript, better-sqlite3, Tailwind + shadcn/ui, Recharts, Vitest, Zod (Screener validation).

---

## Parallelization map (READ FIRST — this is why the plan is phased)

Worktree fan-out is only safe **after the foundation exists**. Phases:

- **Phase 0 (SEQUENTIAL, single worktree):** Tasks 1–4. Scaffold, config, schema, and the `lib/db.ts` + money/derive seam. Everything else imports these; parallelizing them = guaranteed conflicts on `package.json`/`next.config.js`/`schema.sql`.
- **Phase 1 (PARALLEL, one worktree each):** after Phase 0 merges to main, these touch disjoint files:
  - **WT-A** Task 5 — Ingestion writer + Screener adapter (`lib/ingest/**`, `scripts/**`)
  - **WT-B** Task 6 — Overview page (`app/page.tsx`, `components/overview/**`)
  - **WT-C** Task 7 — Deep-Dive page (`app/stock/[symbol]/**`, `components/deepdive/**`)
  - **WT-D** Task 8 — `/api/refresh` route (`app/api/refresh/**`)
- **Phase 2 (SEQUENTIAL):** Task 9 — integration wiring + retire Streamlit. Runs after Phase 1 worktrees merge.

Shared seams (`lib/db.ts`, `lib/types.ts`, `lib/money.ts`, `lib/derive.ts`) are **frozen after Phase 0** — Phase 1 tasks import but do not modify them. If a Phase 1 task needs a new seam function, it adds it in its own file or flags it for Task 9.

**Push protocol:** each task = its own commit; merge worktrees to main one commit at a time; push after each merge.

---

## Phase 0 — Foundation (sequential)

### Task 1: Scaffold Next.js app + tooling

**Files:**
- Create: `package.json`, `next.config.js`, `tsconfig.json`, `tailwind.config.ts`, `postcss.config.mjs`, `app/layout.tsx`, `app/globals.css`, `.gitignore` (append)
- Create: `vitest.config.ts`, `.env.example`

- [ ] **Step 1: Scaffold**

```bash
cd /Users/ashunsah/Desktop/Stocks
npx create-next-app@latest webapp --typescript --tailwind --app --no-src-dir --import-alias "@/*" --use-npm --eslint
# Move contents up if desired, or keep in webapp/. This plan assumes repo-root Next app; adjust paths if using webapp/.
```

- [ ] **Step 2: Add deps**

```bash
npm i better-sqlite3 recharts zod
npm i -D @types/better-sqlite3 vitest @vitejs/plugin-react server-only
```

- [ ] **Step 3: Configure `next.config.js` for native module**

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['better-sqlite3'],
};
module.exports = nextConfig;
```

- [ ] **Step 4: `.env.example` (server-only vars — never NEXT_PUBLIC_)**

```
PORTFOLIO_DB_PATH=./data/portfolio.db
PORTFOLIO_USER_ID=local
```

- [ ] **Step 5: `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', globals: true } });
```

- [ ] **Step 6: Append to `.gitignore`**

```
# Next / Node
node_modules/
.next/
.env.local
# SQLite (local data + WAL sidecars)
data/portfolio.db
data/portfolio.db-wal
data/portfolio.db-shm
```

- [ ] **Step 7: Verify build**

Run: `npm run build`
Expected: succeeds (default scaffold).

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: scaffold Next.js app + tooling"
```

---

### Task 2: SQLite schema + migration runner

**Files:**
- Create: `db/schema.sql`, `lib/db/connection.ts`, `scripts/migrate.ts`
- Test: `tests/schema.test.ts`

- [ ] **Step 1: Write `db/schema.sql`** (money = INTEGER minor units; dates = TEXT)

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS stock_meta (
  symbol   TEXT NOT NULL,
  exchange TEXT NOT NULL CHECK (exchange IN ('NSE','BSE')),
  isin     TEXT,
  company  TEXT,
  sector   TEXT,
  PRIMARY KEY (symbol, exchange)
);
CREATE INDEX IF NOT EXISTS idx_stock_meta_isin ON stock_meta(isin);

CREATE TABLE IF NOT EXISTS holding_snapshots (
  user_id       TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,               -- YYYY-MM-DD (IST)
  symbol        TEXT NOT NULL,
  exchange      TEXT NOT NULL,
  qty           INTEGER NOT NULL,            -- shares
  avg_price     INTEGER NOT NULL,            -- x10000
  ltp           INTEGER NOT NULL,            -- paise
  close_price   INTEGER NOT NULL,            -- paise
  UNIQUE (user_id, snapshot_date, symbol, exchange),
  FOREIGN KEY (symbol, exchange) REFERENCES stock_meta(symbol, exchange)
);
CREATE INDEX IF NOT EXISTS idx_hs_series ON holding_snapshots(user_id, symbol, snapshot_date);

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  user_id        TEXT NOT NULL,
  snapshot_date  TEXT NOT NULL,
  current_value  INTEGER NOT NULL,           -- paise
  invested       INTEGER NOT NULL,
  total_pnl      INTEGER NOT NULL,
  day_pnl        INTEGER NOT NULL,
  holdings_count INTEGER NOT NULL,
  winners        INTEGER NOT NULL,
  losers         INTEGER NOT NULL,
  UNIQUE (user_id, snapshot_date)
);

CREATE TABLE IF NOT EXISTS fundamentals (
  isin TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  pe REAL, pb REAL, roe REAL, roce REAL, debt_equity REAL,
  sales_growth_3y REAL, profit_growth_3y REAL, div_yield REAL,
  market_cap INTEGER, promoter_holding REAL,
  fetched_at TEXT, source TEXT, source_url TEXT,
  fetch_status TEXT CHECK (fetch_status IN ('ok','stale','failed')),
  UNIQUE (isin, as_of_date)
);

CREATE TABLE IF NOT EXISTS fundamentals_extra (
  isin TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  value_num REAL,
  unit TEXT,
  UNIQUE (isin, as_of_date, metric_key)
);

CREATE TABLE IF NOT EXISTS peers (
  isin TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  peer_symbol TEXT NOT NULL,
  peer_company TEXT,
  pe REAL, roe REAL, roce REAL, sales_growth REAL,
  UNIQUE (isin, as_of_date, peer_symbol)
);

CREATE TABLE IF NOT EXISTS analysis (
  isin TEXT NOT NULL,
  narrative TEXT,
  generated_at TEXT,
  model_version TEXT,
  prompt_version TEXT,
  UNIQUE (isin)
);

CREATE VIEW IF NOT EXISTS v_holdings_current AS
SELECT * FROM (
  SELECT hs.*, ROW_NUMBER() OVER (
    PARTITION BY user_id, symbol, exchange ORDER BY snapshot_date DESC) AS rn
  FROM holding_snapshots hs
) WHERE rn = 1;
```

- [ ] **Step 2: Write `lib/db/connection.ts`** (WAL, busy_timeout, FK, HMR singleton)

```ts
import 'server-only';
import Database from 'better-sqlite3';

const path = process.env.PORTFOLIO_DB_PATH ?? './data/portfolio.db';
const g = globalThis as unknown as { __db?: Database.Database };

export function getDb(): Database.Database {
  if (g.__db) return g.__db;
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  g.__db = db;
  return db;
}
```

- [ ] **Step 3: Write `scripts/migrate.ts`**

```ts
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
const path = process.env.PORTFOLIO_DB_PATH ?? './data/portfolio.db';
const db = new Database(path);
db.exec(readFileSync('db/schema.sql', 'utf8'));
console.log('migrated', path);
```

- [ ] **Step 4: Write failing test `tests/schema.test.ts`**

```ts
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { test, expect } from 'vitest';

test('schema applies and enforces snapshot uniqueness', () => {
  const db = new Database(':memory:');
  db.exec(readFileSync('db/schema.sql', 'utf8'));
  db.prepare("INSERT INTO stock_meta(symbol,exchange,isin) VALUES('TCS','NSE','INE467B01029')").run();
  const ins = db.prepare(
    "INSERT INTO holding_snapshots(user_id,snapshot_date,symbol,exchange,qty,avg_price,ltp,close_price) VALUES(?,?,?,?,?,?,?,?)");
  ins.run('u','2026-07-06','TCS','NSE',15,37200000,38452000,38620000);
  expect(() => ins.run('u','2026-07-06','TCS','NSE',15,37200000,38452000,38620000)).toThrow();
});
```

- [ ] **Step 5: Run test → fails, then passes**

Run: `npx vitest run tests/schema.test.ts`
Expected: PASS (schema valid, UNIQUE throws on dup).

- [ ] **Step 6: Add npm scripts + commit**

Add to `package.json` scripts: `"migrate": "tsx scripts/migrate.ts"` (install `tsx` if needed: `npm i -D tsx`).

```bash
git add -A && git commit -m "feat: sqlite schema + migration runner + connection"
```

---

### Task 3: Money + shared types

**Files:**
- Create: `lib/money.ts`, `lib/types.ts`
- Test: `tests/money.test.ts`

- [ ] **Step 1: Failing test `tests/money.test.ts`**

```ts
import { test, expect } from 'vitest';
import { paiseToRupees, rupeesToPaise, priceToRupees } from '@/lib/money';

test('round-trips rupees and paise', () => {
  expect(rupeesToPaise(770587)).toBe(77058700);
  expect(paiseToRupees(77058700)).toBe(770587);
});
test('price scale is x10000', () => {
  expect(priceToRupees(38452000)).toBe(3845.2);
});
```

- [ ] **Step 2: Implement `lib/money.ts`**

```ts
export const PAISE = 100;          // rupee -> paise
export const PRICE_SCALE = 10000;  // rupee -> price minor units

export const rupeesToPaise = (r: number) => Math.round(r * PAISE);
export const paiseToRupees = (p: number) => p / PAISE;
export const rupeesToPrice = (r: number) => Math.round(r * PRICE_SCALE);
export const priceToRupees = (p: number) => p / PRICE_SCALE;
```

- [ ] **Step 3: `lib/types.ts`** (DB row types + UI types + Range; from API doc §1/§3)

```ts
export type Grade = 'Good' | 'Fair' | 'Weak';
export type Range = '1M' | '3M' | '6M' | '1Y' | 'ALL';

// DB rows (snake_case, minor units)
export interface HoldingRow {
  user_id: string; snapshot_date: string; symbol: string; exchange: 'NSE'|'BSE';
  qty: number; avg_price: number; ltp: number; close_price: number;
  company?: string; sector?: string; isin?: string;
}
export interface PortfolioSummaryRow {
  current_value: number; invested: number; total_pnl: number; day_pnl: number;
  holdings_count: number; winners: number; losers: number; snapshot_date: string;
}

// UI types (camelCase, rupees) — aligned to Figma data.ts
export interface Holding {
  symbol: string; company: string; exchange: 'NSE'|'BSE'; sector: string;
  qty: number; avgPrice: number; ltp: number; dayChangePct: number;
  invested: number; current: number; pnl: number; pnlPct: number; dayPnl: number; weight: number;
}
export interface FundamentalItem { label: string; value: string; grade: Grade; }
export interface Peer { symbol: string; company: string; pe: number|null; roe: number; roce: number|null; salesGrowth: number; }
export interface StockDetail {
  fundamentals: FundamentalItem[]; analysis: string; peers: Peer[];
  provenance: { fetchedAt: string; fetchStatus: 'ok'|'stale'|'failed'; thresholdsVersion: string; modelVersion?: string };
}
export interface PortfolioSummary {
  currentValue: number; invested: number; totalPnl: number; totalPnlPct: number;
  dayPnl: number; dayPnlPct: number; holdingsCount: number; winners: number; losers: number; asOf: string;
}
```

- [ ] **Step 4: Run test → PASS**

Run: `npx vitest run tests/money.test.ts`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: money minor-unit utils + shared types"
```

---

### Task 4: Derive + db seam + mappers (the frozen interface)

**Files:**
- Create: `lib/derive.ts`, `lib/db/index.ts`, `lib/mappers.ts`, `lib/grades.ts`
- Test: `tests/derive.test.ts`, `tests/db.test.ts`

- [ ] **Step 1: Failing test `tests/derive.test.ts`**

```ts
import { test, expect } from 'vitest';
import { deriveHolding } from '@/lib/derive';

test('derives pnl and pct from minor units', () => {
  // qty 15, avg 3720 (x10000=37200000), ltp 3845.2 (paise=384520)
  const h = deriveHolding({ qty:15, avg_price:37200000, ltp:384520, close_price:386200 }, 100000000);
  expect(h.invested).toBeCloseTo(55800, 0);
  expect(h.current).toBeCloseTo(57678, 0);
  expect(h.pnl).toBeCloseTo(1878, 0);
});
```

- [ ] **Step 2: Implement `lib/derive.ts`**

```ts
import { paiseToRupees, priceToRupees } from './money';

export function deriveHolding(
  r: { qty:number; avg_price:number; ltp:number; close_price:number },
  totalCurrentPaise: number,
) {
  const avg = priceToRupees(r.avg_price);
  const ltp = paiseToRupees(r.ltp);
  const close = paiseToRupees(r.close_price);
  const invested = r.qty * avg;
  const current = r.qty * ltp;
  const pnl = current - invested;
  const pnlPct = invested ? (pnl / invested) * 100 : 0;
  const dayChangePct = close ? ((ltp - close) / close) * 100 : 0;
  const dayPnl = r.qty * (ltp - close);
  const weight = totalCurrentPaise ? (current / paiseToRupees(totalCurrentPaise)) * 100 : 0;
  return { invested, current, pnl, pnlPct, dayChangePct, dayPnl, weight, avgPrice: avg, ltp };
}
```

- [ ] **Step 3: Implement `lib/grades.ts`** (sector-keyed, versioned; minimal viable set)

```ts
import type { Grade } from './types';
export const THRESHOLDS_VERSION = 'v1';
// [good_ceiling, fair_ceiling] — value <= good => Good, <= fair => Fair, else Weak. null sector falls back to 'default'.
const T: Record<string, Record<string, [number, number]>> = {
  default: { pe:[20,35], debt_equity:[0.5,1], roe:[15,10], roce:[15,10] },
  Banking: { pe:[18,25], gross_npa:[1.5,3], nim:[3.5,3] },
};
export function gradeMetric(sector: string, key: string, value: number): Grade {
  const t = (T[sector] ?? T.default)[key] ?? T.default[key];
  if (!t) return 'Fair';
  const higherIsBetter = ['roe','roce','nim'].includes(key);
  const [g, f] = t;
  if (higherIsBetter) return value >= g ? 'Good' : value >= f ? 'Fair' : 'Weak';
  return value <= g ? 'Good' : value <= f ? 'Fair' : 'Weak';
}
```

- [ ] **Step 4: Implement `lib/db/index.ts`** (ASYNC, always-userId-scoped seam — API doc §1)

```ts
import 'server-only';
import { getDb } from './connection';
import type { HoldingRow, PortfolioSummaryRow, Range } from '../types';

function startDateFor(range: Range): string {
  if (range === 'ALL') return '0000-00-00';
  const days = { '1M':30, '3M':91, '6M':182, '1Y':365 }[range];
  const d = new Date(Date.now() - days*86400000);
  return d.toISOString().slice(0,10);
}

export async function getHoldings(userId: string): Promise<HoldingRow[]> {
  return getDb().prepare(
    `SELECT v.*, m.company, m.sector, m.isin FROM v_holdings_current v
     JOIN stock_meta m ON m.symbol=v.symbol AND m.exchange=v.exchange
     WHERE v.user_id=?`).all(userId) as HoldingRow[];
}
export async function getPortfolioSummary(userId: string): Promise<PortfolioSummaryRow|null> {
  return getDb().prepare(
    `SELECT * FROM portfolio_snapshots WHERE user_id=? ORDER BY snapshot_date DESC LIMIT 1`
  ).get(userId) as PortfolioSummaryRow ?? null;
}
export async function getPortfolioHistory(userId: string, range: Range): Promise<PortfolioSummaryRow[]> {
  return getDb().prepare(
    `SELECT * FROM portfolio_snapshots WHERE user_id=? AND snapshot_date>=? ORDER BY snapshot_date`
  ).all(userId, startDateFor(range)) as PortfolioSummaryRow[];
}
export async function getHolding(userId: string, symbol: string, exchange: string) {
  return getDb().prepare(
    `SELECT v.*, m.company, m.sector, m.isin FROM v_holdings_current v
     JOIN stock_meta m ON m.symbol=v.symbol AND m.exchange=v.exchange
     WHERE v.user_id=? AND v.symbol=? AND v.exchange=?`).get(userId, symbol, exchange) as HoldingRow ?? null;
}
export async function getFundamentals(isin: string) {
  const db = getDb();
  const core = db.prepare(`SELECT * FROM fundamentals WHERE isin=? ORDER BY as_of_date DESC LIMIT 1`).get(isin) ?? null;
  const extra = db.prepare(`SELECT * FROM fundamentals_extra WHERE isin=? ORDER BY as_of_date DESC`).all(isin);
  return { core, extra };
}
export async function getPeers(isin: string) {
  return getDb().prepare(
    `SELECT * FROM peers WHERE isin=? ORDER BY as_of_date DESC`).all(isin);
}
export async function getAnalysis(isin: string) {
  return getDb().prepare(`SELECT * FROM analysis WHERE isin=?`).get(isin) ?? null;
}
```

- [ ] **Step 5: Implement `lib/mappers.ts`** (rows → UI types; converts minor units)

```ts
import type { HoldingRow, Holding } from './types';
import { deriveHolding } from './derive';

export function toHolding(r: HoldingRow, totalCurrentPaise: number): Holding {
  const d = deriveHolding(r, totalCurrentPaise);
  return {
    symbol: r.symbol, company: r.company ?? r.symbol, exchange: r.exchange, sector: r.sector ?? '',
    qty: r.qty, avgPrice: d.avgPrice, ltp: d.ltp, dayChangePct: d.dayChangePct,
    invested: d.invested, current: d.current, pnl: d.pnl, pnlPct: d.pnlPct, dayPnl: d.dayPnl, weight: d.weight,
  };
}
```

- [ ] **Step 6: Failing test `tests/db.test.ts`** (seed in-memory, assert getHoldings shape)

```ts
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { test, expect } from 'vitest';

test('v_holdings_current returns latest row per symbol', () => {
  const db = new Database(':memory:');
  db.exec(readFileSync('db/schema.sql','utf8'));
  db.prepare("INSERT INTO stock_meta(symbol,exchange,isin) VALUES('TCS','NSE','X')").run();
  const ins = db.prepare("INSERT INTO holding_snapshots(user_id,snapshot_date,symbol,exchange,qty,avg_price,ltp,close_price) VALUES('u',?,?,?,?,?,?,?)");
  ins.run('2026-07-05','TCS','NSE',15,37200000,380000000,381000000);
  ins.run('2026-07-06','TCS','NSE',15,37200000,384520000,386200000);
  const row: any = db.prepare("SELECT * FROM v_holdings_current WHERE user_id='u' AND symbol='TCS'").get();
  expect(row.snapshot_date).toBe('2026-07-06');
});
```

- [ ] **Step 7: Run tests → PASS**

Run: `npx vitest run`

- [ ] **Step 8: Commit — FREEZES the seam**

```bash
git add -A && git commit -m "feat: derive + async db seam + mappers + grades (frozen interface)"
```

> After this commit is on main, Phase 1 worktrees may begin. They import `lib/db`, `lib/types`, `lib/money`, `lib/derive`, `lib/mappers`, `lib/grades` and MUST NOT modify them.

---

## Phase 1 — Parallel worktrees (after Phase 0 on main)

### Task 5 [WT-A]: Ingestion writer + Screener adapter

**Files:**
- Create: `lib/ingest/writer.ts`, `lib/ingest/screener.ts`, `lib/ingest/kite-normalize.ts`, `scripts/ingest.ts`
- Test: `tests/ingest.test.ts`

- [ ] **Step 1: Failing test — writer upserts idempotently in one txn**

```ts
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { test, expect } from 'vitest';
import { writeSnapshot } from '@/lib/ingest/writer';

test('re-running same day overwrites, not duplicates', () => {
  const db = new Database(':memory:'); db.exec(readFileSync('db/schema.sql','utf8'));
  const payload = { userId:'u', snapshotDate:'2026-07-06',
    meta:[{symbol:'TCS',exchange:'NSE',isin:'X',company:'TCS',sector:'IT'}],
    holdings:[{symbol:'TCS',exchange:'NSE',qty:15,avg_price:37200000,ltp:384520000,close_price:386200000}],
    totals:{current_value:1,invested:1,total_pnl:0,day_pnl:0,holdings_count:1,winners:1,losers:0} };
  writeSnapshot(db, payload); writeSnapshot(db, payload);
  const n: any = db.prepare("SELECT COUNT(*) c FROM holding_snapshots").get();
  expect(n.c).toBe(1);
});
```

- [ ] **Step 2: Implement `lib/ingest/writer.ts`** (transaction, ON CONFLICT, stock_meta first)

```ts
import type Database from 'better-sqlite3';
export function writeSnapshot(db: Database.Database, p: any) {
  const tx = db.transaction(() => {
    const meta = db.prepare(`INSERT INTO stock_meta(symbol,exchange,isin,company,sector)
      VALUES(@symbol,@exchange,@isin,@company,@sector)
      ON CONFLICT(symbol,exchange) DO UPDATE SET isin=excluded.isin,company=excluded.company,sector=excluded.sector`);
    for (const m of p.meta) meta.run(m);
    const hs = db.prepare(`INSERT INTO holding_snapshots(user_id,snapshot_date,symbol,exchange,qty,avg_price,ltp,close_price)
      VALUES(@user_id,@snapshot_date,@symbol,@exchange,@qty,@avg_price,@ltp,@close_price)
      ON CONFLICT(user_id,snapshot_date,symbol,exchange) DO UPDATE SET
      qty=excluded.qty,avg_price=excluded.avg_price,ltp=excluded.ltp,close_price=excluded.close_price`);
    for (const h of p.holdings) hs.run({ ...h, user_id:p.userId, snapshot_date:p.snapshotDate });
    db.prepare(`INSERT INTO portfolio_snapshots(user_id,snapshot_date,current_value,invested,total_pnl,day_pnl,holdings_count,winners,losers)
      VALUES(@user_id,@snapshot_date,@current_value,@invested,@total_pnl,@day_pnl,@holdings_count,@winners,@losers)
      ON CONFLICT(user_id,snapshot_date) DO UPDATE SET
      current_value=excluded.current_value,invested=excluded.invested,total_pnl=excluded.total_pnl,
      day_pnl=excluded.day_pnl,holdings_count=excluded.holdings_count,winners=excluded.winners,losers=excluded.losers`)
      .run({ ...p.totals, user_id:p.userId, snapshot_date:p.snapshotDate });
  });
  tx();
}
```

- [ ] **Step 3: Implement `lib/ingest/screener.ts`** (Zod-validated; degrade to failed, never throw into holdings path)

```ts
import { z } from 'zod';
const Fund = z.object({ pe:z.number().nullable(), roe:z.number().nullable() }).passthrough();
export async function fetchFundamentals(isin: string, html?: string) {
  try {
    // parse `html` (fetched by caller) → object; validate
    const parsed = Fund.parse(/* extracted */ {});
    return { status:'ok' as const, data: parsed };
  } catch {
    return { status:'failed' as const, data: null };
  }
}
```

- [ ] **Step 4: Implement `scripts/ingest.ts`** (CLI entry the /api/refresh route spawns; reads Kite payload from stdin/env, computes IST snapshot_date, calls writeSnapshot)

```ts
import Database from 'better-sqlite3';
import { writeSnapshot } from '@/lib/ingest/writer';
const db = new Database(process.env.PORTFOLIO_DB_PATH ?? './data/portfolio.db');
const istDate = new Date(Date.now()+5.5*3600000).toISOString().slice(0,10);
const payload = JSON.parse(process.env.INGEST_PAYLOAD ?? '{}');
writeSnapshot(db, { ...payload, snapshotDate: istDate });
console.log(JSON.stringify({ status:'ok', snapshotDate: istDate, holdings: payload.holdings?.length ?? 0 }));
```

- [ ] **Step 5: Run test → PASS; commit**

```bash
npx vitest run tests/ingest.test.ts
git add -A && git commit -m "feat: ingestion writer + screener adapter + ingest CLI"
```

---

### Task 6 [WT-B]: Overview page

**Files:**
- Create: `app/page.tsx`, `components/overview/Kpis.tsx`, `components/overview/HoldingsTable.tsx`, `components/overview/AllocationChart.tsx`, `components/overview/WinnersLosers.tsx`, `components/overview/Concentration.tsx`, `components/ui/format.ts`
- Test: `tests/format.test.ts`

- [ ] **Step 1: Failing test `tests/format.test.ts`** (INR formatting, server-side)

```ts
import { test, expect } from 'vitest';
import { inr } from '@/components/ui/format';
test('formats INR with Indian grouping', () => {
  expect(inr(770587)).toBe('₹7,70,587');
});
```

- [ ] **Step 2: Implement `components/ui/format.ts`**

```ts
export const inr = (n: number) =>
  '₹' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(n));
export const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
```

- [ ] **Step 3: Implement `app/page.tsx`** (RSC, force-dynamic, reads seam, maps, passes plain data)

```tsx
export const dynamic = 'force-dynamic';
import { getHoldings, getPortfolioSummary } from '@/lib/db';
import { toHolding } from '@/lib/mappers';
import { rupeesToPaise } from '@/lib/money';
import Kpis from '@/components/overview/Kpis';
import HoldingsTable from '@/components/overview/HoldingsTable';

const USER = process.env.PORTFOLIO_USER_ID ?? 'local';

export default async function Page() {
  const summary = await getPortfolioSummary(USER);
  const rows = await getHoldings(USER);
  if (!summary || rows.length === 0) return <main className="p-8"><h1 className="text-2xl font-bold">Portfolio</h1><p className="text-muted-foreground mt-4">No holdings yet. Run refresh.</p></main>;
  const totalPaise = rows.reduce((a, r) => a + rupeesToPaise((r.qty * r.ltp) / 100), 0);
  const holdings = rows.map(r => toHolding(r, totalPaise));
  return (
    <main className="p-8 space-y-8">
      <h1 className="text-2xl font-bold">Portfolio</h1>
      <Kpis summary={summary} />
      <HoldingsTable holdings={holdings} />
    </main>
  );
}
```

- [ ] **Step 4: Implement `components/overview/Kpis.tsx`** (server component, uses `inr`)

```tsx
import { inr, pct } from '@/components/ui/format';
import { paiseToRupees } from '@/lib/money';
export default function Kpis({ summary }: { summary: any }) {
  const cv = paiseToRupees(summary.current_value), inv = paiseToRupees(summary.invested);
  const tp = paiseToRupees(summary.total_pnl);
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
      <Card label="Current Value" value={inr(cv)} />
      <Card label="Invested" value={inr(inv)} />
      <Card label="Total P&L" value={inr(tp)} sub={pct(inv ? tp/inv*100 : 0)} up={tp>=0} />
      <Card label="Holdings" value={String(summary.holdings_count)} sub={`${summary.winners}W / ${summary.losers}L`} />
      <Card label="Day P&L" value={inr(paiseToRupees(summary.day_pnl))} up={summary.day_pnl>=0} />
    </div>
  );
}
function Card({ label, value, sub, up }: { label:string; value:string; sub?:string; up?:boolean }) {
  return <div className="rounded-2xl border p-5"><div className="text-xs uppercase text-muted-foreground">{label}</div>
    <div className="text-2xl font-bold tabular-nums">{value}</div>
    {sub && <div className={`text-sm ${up===undefined?'':up?'text-green-600':'text-red-600'}`}>{up===undefined?'':up?'▲ ':'▼ '}{sub}</div>}</div>;
}
```

- [ ] **Step 5: Implement `HoldingsTable.tsx`** (client leaf: rows link to `/stock/[symbol]`)

```tsx
'use client';
import Link from 'next/link';
import type { Holding } from '@/lib/types';
import { inr, pct } from '@/components/ui/format';
export default function HoldingsTable({ holdings }: { holdings: Holding[] }) {
  return (
    <table className="w-full text-sm">
      <thead><tr className="text-left text-muted-foreground">
        <th>Symbol</th><th>Qty</th><th className="text-right">LTP</th><th className="text-right">P&L</th><th className="text-right">Weight</th>
      </tr></thead>
      <tbody>{holdings.map(h => (
        <tr key={`${h.symbol}-${h.exchange}`} className="border-t hover:bg-muted/50">
          <td><Link className="text-primary underline" href={`/stock/${h.symbol}?exchange=${h.exchange}`}>{h.symbol}</Link></td>
          <td>{h.qty}</td><td className="text-right tabular-nums">{inr(h.ltp)}</td>
          <td className={`text-right tabular-nums ${h.pnl>=0?'text-green-600':'text-red-600'}`}>{inr(h.pnl)} ({pct(h.pnlPct)})</td>
          <td className="text-right tabular-nums">{h.weight.toFixed(2)}%</td>
        </tr>))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 6: Implement `AllocationChart.tsx`, `WinnersLosers.tsx`, `Concentration.tsx`** as client leaves using Recharts (donut) and simple derived lists. (Render behind `next/dynamic(() => import(...), { ssr:false })` from `app/page.tsx` when wired in Task 9.)

```tsx
// components/overview/AllocationChart.tsx
'use client';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import type { Holding } from '@/lib/types';
export default function AllocationChart({ holdings }: { holdings: Holding[] }) {
  const data = holdings.map(h => ({ name: h.symbol, value: h.current }));
  return <ResponsiveContainer width="100%" height={320}><PieChart>
    <Pie data={data} dataKey="value" nameKey="name" innerRadius={70} outerRadius={110}>
      {data.map((_, i) => <Cell key={i} />)}
    </Pie><Tooltip /></PieChart></ResponsiveContainer>;
}
```

- [ ] **Step 7: Run tests + build; commit**

```bash
npx vitest run tests/format.test.ts && npm run build
git add -A && git commit -m "feat: overview page (KPIs, holdings table, allocation)"
```

---

### Task 7 [WT-C]: Deep-Dive page

**Files:**
- Create: `app/stock/[symbol]/page.tsx`, `components/deepdive/Position.tsx`, `components/deepdive/Scorecard.tsx`, `components/deepdive/PeerTable.tsx`, `components/deepdive/Narrative.tsx`
- Test: `tests/scorecard.test.ts`

- [ ] **Step 1: Failing test `tests/scorecard.test.ts`** (fundamentals rows → graded FundamentalItem[])

```ts
import { test, expect } from 'vitest';
import { buildScorecard } from '@/components/deepdive/scorecard-data';
test('grades a metric by sector', () => {
  const items = buildScorecard('IT', { pe: 28.6, roe: 50.1 } as any, []);
  expect(items.find(i => i.label==='ROE')?.grade).toBe('Good');
});
```

- [ ] **Step 2: Implement `components/deepdive/scorecard-data.ts`**

```ts
import { gradeMetric } from '@/lib/grades';
import type { FundamentalItem } from '@/lib/types';
const LABELS: Record<string,string> = { pe:'P/E Ratio', pb:'P/B Ratio', roe:'ROE', roce:'ROCE', debt_equity:'Debt / Equity' };
export function buildScorecard(sector: string, core: Record<string,number|null>, extra: {metric_key:string;value_num:number;unit?:string}[]): FundamentalItem[] {
  const items: FundamentalItem[] = [];
  for (const [k, v] of Object.entries(core)) {
    if (v == null || !(k in LABELS)) continue;
    items.push({ label: LABELS[k], value: `${v}${k==='roe'||k==='roce'?'%':k==='pe'||k==='pb'?'×':''}`, grade: gradeMetric(sector, k, v) });
  }
  for (const e of extra) items.push({ label: e.metric_key, value: `${e.value_num}${e.unit ?? ''}`, grade: gradeMetric(sector, e.metric_key, e.value_num) });
  return items;
}
```

- [ ] **Step 3: Implement `app/stock/[symbol]/page.tsx`** (RSC, Suspense boundaries, force-dynamic)

```tsx
export const dynamic = 'force-dynamic';
import { Suspense } from 'react';
import { getHolding, getFundamentals, getPeers, getAnalysis } from '@/lib/db';
import Position from '@/components/deepdive/Position';
import Scorecard from '@/components/deepdive/Scorecard';
const USER = process.env.PORTFOLIO_USER_ID ?? 'local';

export default async function Page({ params, searchParams }: { params:{symbol:string}; searchParams:{exchange?:string} }) {
  const exchange = searchParams.exchange ?? 'NSE';
  const holding = await getHolding(USER, params.symbol, exchange);
  if (!holding) return <main className="p-8">Unknown holding.</main>;
  return (
    <main className="p-8 space-y-8">
      <a href="/" className="text-sm text-muted-foreground">← Portfolio</a>
      <h1 className="text-2xl font-bold">{holding.symbol} — {holding.company}</h1>
      <Position holding={holding} />
      <Suspense fallback={<div className="h-40 animate-pulse rounded-2xl bg-muted" />}>
        {/* @ts-expect-error async server component */}
        <Fundamentals isin={holding.isin!} sector={holding.sector ?? ''} />
      </Suspense>
    </main>
  );
}
async function Fundamentals({ isin, sector }: { isin:string; sector:string }) {
  const { core, extra } = await getFundamentals(isin);
  if (!core) return <p className="text-muted-foreground">No fundamentals yet.</p>;
  return <Scorecard sector={sector} core={core} extra={extra as any} />;
}
```

- [ ] **Step 4: Implement `Position.tsx`, `Scorecard.tsx`, `PeerTable.tsx`, `Narrative.tsx`** (server components; Scorecard uses buildScorecard + grade color pills; empty-safe)

```tsx
// components/deepdive/Scorecard.tsx
import { buildScorecard } from './scorecard-data';
const color = { Good:'bg-green-100 text-green-700', Fair:'bg-amber-100 text-amber-700', Weak:'bg-red-100 text-red-700' } as const;
export default function Scorecard({ sector, core, extra }: any) {
  const items = buildScorecard(sector, core, extra);
  return <div className="grid grid-cols-2 md:grid-cols-3 gap-4">{items.map(i => (
    <div key={i.label} className="rounded-2xl border p-4">
      <div className="text-xs text-muted-foreground">{i.label}</div>
      <div className="text-xl font-semibold tabular-nums">{i.value}</div>
      <span className={`text-xs px-2 py-0.5 rounded-full ${color[i.grade]}`}>{i.grade}</span>
    </div>))}</div>;
}
```

- [ ] **Step 5: Run test + build; commit**

```bash
npx vitest run tests/scorecard.test.ts && npm run build
git add -A && git commit -m "feat: deep-dive page (position, scorecard, peers, narrative)"
```

---

### Task 8 [WT-D]: /api/refresh route

**Files:**
- Create: `app/api/refresh/route.ts`, `lib/ingest/lock.ts`
- Test: `tests/refresh-lock.test.ts`

- [ ] **Step 1: Failing test `tests/refresh-lock.test.ts`**

```ts
import { test, expect } from 'vitest';
import { acquireLock, releaseLock } from '@/lib/ingest/lock';
test('lock is exclusive', () => {
  expect(acquireLock()).toBe(true);
  expect(acquireLock()).toBe(false);
  releaseLock();
  expect(acquireLock()).toBe(true); releaseLock();
});
```

- [ ] **Step 2: Implement `lib/ingest/lock.ts`** (file-based single-writer guard)

```ts
import { existsSync, writeFileSync, rmSync } from 'node:fs';
const LOCK = (process.env.PORTFOLIO_DB_PATH ?? './data/portfolio.db') + '.ingest.lock';
export function acquireLock(): boolean { if (existsSync(LOCK)) return false; writeFileSync(LOCK, String(process.pid)); return true; }
export function releaseLock(): void { try { rmSync(LOCK); } catch {} }
```

- [ ] **Step 3: Implement `app/api/refresh/route.ts`** (spawns ingestion, revalidates; responses per API doc §2)

```ts
import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { spawnSync } from 'node:child_process';
import { acquireLock, releaseLock } from '@/lib/ingest/lock';

export async function POST() {
  if (!acquireLock()) return NextResponse.json({ status:'in_progress' }, { status:202 });
  try {
    const res = spawnSync('npx', ['tsx','scripts/ingest.ts'], { encoding:'utf8', env: process.env });
    if (res.status !== 0) return NextResponse.json({ status:'error', message: res.stderr }, { status:500 });
    revalidatePath('/');
    return NextResponse.json(JSON.parse(res.stdout || '{"status":"ok"}'));
  } finally { releaseLock(); }
}
```

- [ ] **Step 4: Run test + build; commit**

```bash
npx vitest run tests/refresh-lock.test.ts && npm run build
git add -A && git commit -m "feat: /api/refresh route with single-writer lock"
```

---

## Phase 2 — Integration (sequential, after Phase 1 merges)

### Task 9: Wire pages together, dynamic charts, retire Streamlit

**Files:**
- Modify: `app/page.tsx` (mount AllocationChart/WinnersLosers/Concentration via `next/dynamic`), `app/stock/[symbol]/page.tsx` (mount PeerTable/Narrative)
- Create: `components/RefreshButton.tsx`
- Delete: `dashboard/`, `data/holdings.json`, `data/insights.md`, `.streamlit*`, old Python skills

- [ ] **Step 1: `components/RefreshButton.tsx`** (client; POST /api/refresh → router.refresh())

```tsx
'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
export default function RefreshButton() {
  const r = useRouter(); const [busy,setBusy] = useState(false);
  return <button disabled={busy} onClick={async()=>{ setBusy(true); const res=await fetch('/api/refresh',{method:'POST'}); const j=await res.json(); if(j.status==='login_required') alert('Kite login required: '+j.loginUrl); r.refresh(); setBusy(false); }} className="rounded-lg border px-4 py-2">{busy?'Refreshing…':'Refresh'}</button>;
}
```

- [ ] **Step 2: Mount dynamic charts in `app/page.tsx`**

```tsx
import dynamicImport from 'next/dynamic';
const AllocationChart = dynamicImport(() => import('@/components/overview/AllocationChart'), { ssr:false, loading:()=> <div className="h-80 animate-pulse rounded-2xl bg-muted" /> });
// render <AllocationChart holdings={holdings} /> alongside the table
```

- [ ] **Step 3: Seed + smoke test end-to-end**

```bash
npm run migrate
# seed a fixture snapshot (or run a real ingest), then:
npm run dev  # verify / and /stock/TCS render, Refresh works
```

- [ ] **Step 4: Retire Streamlit**

```bash
git rm -r dashboard/ .streamlit* 2>/dev/null; rm -f data/holdings.json data/insights.md
git add -A && git commit -m "chore: retire Streamlit dashboard and Python data path"
```

- [ ] **Step 5: Final build + commit**

```bash
npm run build
git add -A && git commit -m "feat: integrate overview + deep-dive + refresh (parity)" || true
```

---

## Self-review notes

- **Spec coverage:** schema §4 → Task 2; money/derive §4 → Tasks 3–4; RSC-only §3/§5 → Tasks 6–7; ingestion §6 → Tasks 5,8; API doc §1/§2/§3 → Tasks 4,8, types in Task 3; retirement §9 → Task 9. Deferred items (multi-user, hosting) intentionally not tasked.
- **Known simplifications (flag for review during execution):** grade thresholds in `lib/grades.ts` are a minimal viable set (design wants fuller sector coverage); Screener HTML parsing in `screener.ts` is stubbed (the real selector logic is written against live HTML during WT-A); narrative generation is agent-side (not in these tasks — the ingest CLI receives it in its payload).
- **Type consistency:** `HoldingRow`/`Holding`/`FundamentalItem`/`Peer` defined once in Task 3, imported everywhere. Seam frozen at end of Task 4.
