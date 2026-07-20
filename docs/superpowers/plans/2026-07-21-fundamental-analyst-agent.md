# Fundamental Analyst Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reusable `fundamental-analyst` Claude Code subagent that analyzes an Indian stock via the `screener-mcp` tools, produces a sector-aware graded scorecard + BUY/SELL/HOLD verdict, and persists it to SQLite so the dashboard deep-dive populates.

**Architecture:** A Node persist script (`scripts/persist-analysis.ts`) + a value parser (`lib/screener-parse.ts`) do the deterministic SQLite writes; the agent (`.claude/agents/fundamental-analyst.md`) does the LLM analysis and calls the script. The `analysis` table gains `verdict`/`confidence` columns; `screener` is wired into `.mcp.json`; both agents share one recommendation policy.

**Tech Stack:** TypeScript, better-sqlite3, Vitest, Zod, Claude Code agents + MCP.

**Spec:** `docs/superpowers/specs/2026-07-21-fundamental-analyst-agent-design.md`

---

## File structure

| File | Responsibility |
|---|---|
| `db/schema.sql` (modify) | add `verdict`, `confidence` to `analysis` |
| `scripts/migrate-analysis-verdict.ts` (create) | idempotent `ALTER TABLE` migration for existing DBs |
| `lib/screener-parse.ts` (create) | `parseScreenerValue` — display string → number/null |
| `lib/ingest/analysis-writer.ts` (create) | `writeAnalysis(db, payload)` — upsert fundamentals/extra/peers/analysis in one txn |
| `scripts/persist-analysis.ts` (create) | CLI: read JSON payload from env, open DB, call `writeAnalysis` |
| `.claude/agents/fundamental-analyst.md` (create) | the agent definition + procedure |
| `.claude/agents/portfolio-agent.md` (modify) | shared recommendation policy + batch fan-out |
| `.mcp.json` (modify) | add `screener` MCP server |
| `components/deepdive/DeepDiveClient` path (modify) | render verdict + confidence |
| `tests/*.test.ts` (create) | parser, writer, schema, migration tests |

---

## Task 1: Add verdict/confidence to the analysis schema

**Files:**
- Modify: `db/schema.sql`
- Create: `tests/analysis-schema.test.ts`

- [ ] **Step 1: Write the failing test** (`tests/analysis-schema.test.ts`)

```ts
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { test, expect } from "vitest";

test("analysis table has verdict and confidence columns", () => {
  const db = new Database(":memory:");
  db.exec(readFileSync("db/schema.sql", "utf8"));
  const cols = (db.prepare("PRAGMA table_info(analysis)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  expect(cols).toContain("verdict");
  expect(cols).toContain("confidence");
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx vitest run tests/analysis-schema.test.ts`
Expected: FAIL (columns missing).

- [ ] **Step 3: Edit `db/schema.sql`** — replace the `analysis` table block with:

```sql
CREATE TABLE IF NOT EXISTS analysis (
  isin           TEXT NOT NULL,
  narrative      TEXT,
  verdict        TEXT,                       -- 'BUY' | 'SELL' | 'HOLD'
  confidence     TEXT,                       -- 'Low' | 'Medium' | 'High'
  generated_at   TEXT,                       -- ISO-8601 UTC
  model_version  TEXT,
  prompt_version TEXT,
  UNIQUE (isin)
);
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npx vitest run tests/analysis-schema.test.ts`

- [ ] **Step 5: Commit**

```bash
git add db/schema.sql tests/analysis-schema.test.ts
git commit -m "feat: add verdict/confidence columns to analysis table"
```

---

## Task 2: Migration for existing databases

**Files:**
- Create: `scripts/migrate-analysis-verdict.ts`
- Create: `tests/migrate-analysis-verdict.test.ts`

Existing `data/portfolio.db` files already have the old `analysis` table; `CREATE TABLE IF NOT EXISTS` won't add columns. This migration is idempotent.

- [ ] **Step 1: Write the failing test** (`tests/migrate-analysis-verdict.test.ts`)

```ts
import Database from "better-sqlite3";
import { test, expect } from "vitest";
import { addVerdictColumns } from "@/scripts/migrate-analysis-verdict";

test("adds verdict/confidence to an old analysis table, idempotently", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE analysis (isin TEXT, narrative TEXT, generated_at TEXT,
           model_version TEXT, prompt_version TEXT, UNIQUE(isin));`);
  addVerdictColumns(db);
  addVerdictColumns(db); // second run must not throw
  const cols = (db.prepare("PRAGMA table_info(analysis)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  expect(cols).toContain("verdict");
  expect(cols).toContain("confidence");
});
```

- [ ] **Step 2: Run it — expect FAIL** (`Cannot find module`)

Run: `npx vitest run tests/migrate-analysis-verdict.test.ts`

- [ ] **Step 3: Create `scripts/migrate-analysis-verdict.ts`**

```ts
import Database from "better-sqlite3";

/** Idempotently add verdict/confidence columns to an existing analysis table. */
export function addVerdictColumns(db: Database.Database): void {
  const cols = (db.prepare("PRAGMA table_info(analysis)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!cols.includes("verdict")) db.exec("ALTER TABLE analysis ADD COLUMN verdict TEXT");
  if (!cols.includes("confidence"))
    db.exec("ALTER TABLE analysis ADD COLUMN confidence TEXT");
}

// Run directly: `tsx scripts/migrate-analysis-verdict.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";
  const db = new Database(path);
  addVerdictColumns(db);
  console.log("migrated analysis table:", path);
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npx vitest run tests/migrate-analysis-verdict.test.ts`

- [ ] **Step 5: Apply to the real DB + commit**

```bash
PORTFOLIO_DB_PATH=./data/portfolio.db npx tsx scripts/migrate-analysis-verdict.ts
git add scripts/migrate-analysis-verdict.ts tests/migrate-analysis-verdict.test.ts
git commit -m "feat: idempotent migration adding verdict/confidence to analysis"
```

---

## Task 3: Screener value parser

**Files:**
- Create: `lib/screener-parse.ts`
- Create: `tests/screener-parse.test.ts`

`screener-mcp` returns display strings. This converts them to the numeric forms the DB expects.

- [ ] **Step 1: Write the failing test** (`tests/screener-parse.test.ts`)

```ts
import { test, expect } from "vitest";
import { parseScreenerNumber, parseCroreToPaise } from "@/lib/screener-parse";

test("parses plain and suffixed ratio strings", () => {
  expect(parseScreenerNumber("15.2")).toBe(15.2);
  expect(parseScreenerNumber("2.84 %")).toBe(2.84);
  expect(parseScreenerNumber("63.0 %")).toBe(63.0);
  expect(parseScreenerNumber("1,234.5")).toBe(1234.5);
  expect(parseScreenerNumber("—")).toBeNull();
  expect(parseScreenerNumber("")).toBeNull();
  expect(parseScreenerNumber(undefined)).toBeNull();
});

test("parses market cap crore string to paise", () => {
  // ₹ 8,14,737 Cr.  ->  814737 crore  ->  ×1e7 rupees  ->  ×100 paise
  expect(parseCroreToPaise("₹ 8,14,737 Cr.")).toBe(814737 * 1e7 * 100);
  expect(parseCroreToPaise("—")).toBeNull();
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx vitest run tests/screener-parse.test.ts`

- [ ] **Step 3: Create `lib/screener-parse.ts`**

```ts
/** Screener display string → number, or null for missing ("—", "", N/A). */
export function parseScreenerNumber(s: string | null | undefined): number | null {
  if (s == null) return null;
  const cleaned = s.replace(/[₹%×,\s]/g, "").replace(/Cr\.?/gi, "");
  if (cleaned === "" || cleaned === "—" || /^n\/?a$/i.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** "₹ 8,14,737 Cr." → paise (crore × 1e7 rupees × 100 paise). */
export function parseCroreToPaise(s: string | null | undefined): number | null {
  const crore = parseScreenerNumber(s);
  if (crore == null) return null;
  return Math.round(crore * 1e7 * 100);
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npx vitest run tests/screener-parse.test.ts`

- [ ] **Step 5: Commit**

```bash
git add lib/screener-parse.ts tests/screener-parse.test.ts
git commit -m "feat: screener display-string value parser"
```

---

## Task 4: Analysis writer

**Files:**
- Create: `lib/ingest/analysis-writer.ts`
- Create: `tests/analysis-writer.test.ts`

Mirrors the transactional-upsert pattern of `lib/ingest/writer.ts`.

- [ ] **Step 1: Write the failing test** (`tests/analysis-writer.test.ts`)

```ts
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { test, expect } from "vitest";
import { writeAnalysis, type AnalysisPayload } from "@/lib/ingest/analysis-writer";

function db() {
  const d = new Database(":memory:");
  d.exec(readFileSync("db/schema.sql", "utf8"));
  return d;
}

const payload: AnalysisPayload = {
  isin: "INE467B01029",
  asOfDate: "2026-07-21",
  fundamentals: {
    pe: 15.2, pb: null, roe: 51.8, roce: 63.0, debt_equity: 0.09,
    sales_growth_3y: 8.0, profit_growth_3y: 10.0, div_yield: 2.84,
    market_cap: 814737 * 1e7 * 100, promoter_holding: 71.8,
    source: "screener.in", source_url: "https://www.screener.in/company/TCS/",
    fetch_status: "ok",
  },
  extra: [{ metric_key: "opm", value_num: 24.5, unit: "%" }],
  peers: [
    { peer_symbol: "INFY", peer_company: "Infosys", pe: 14.7, roe: 40.0, roce: 39.9, sales_growth: 13.4 },
  ],
  analysis: {
    narrative: "High-quality IT compounder.", verdict: "HOLD", confidence: "High",
    model_version: "test", prompt_version: "v1",
  },
};

test("writes all four tables and is idempotent", () => {
  const d = db();
  writeAnalysis(d, payload);
  writeAnalysis(d, payload); // re-run same day → upsert, no dupes
  expect((d.prepare("SELECT COUNT(*) c FROM fundamentals").get() as any).c).toBe(1);
  expect((d.prepare("SELECT COUNT(*) c FROM fundamentals_extra").get() as any).c).toBe(1);
  expect((d.prepare("SELECT COUNT(*) c FROM peers").get() as any).c).toBe(1);
  const a = d.prepare("SELECT * FROM analysis WHERE isin=?").get("INE467B01029") as any;
  expect(a.verdict).toBe("HOLD");
  expect(a.confidence).toBe("High");
});

test("fetch_status=failed still records a row without crashing", () => {
  const d = db();
  writeAnalysis(d, {
    ...payload,
    fundamentals: { ...payload.fundamentals, fetch_status: "failed", pe: null },
  });
  expect((d.prepare("SELECT fetch_status FROM fundamentals").get() as any).fetch_status).toBe("failed");
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx vitest run tests/analysis-writer.test.ts`

- [ ] **Step 3: Create `lib/ingest/analysis-writer.ts`**

```ts
import type Database from "better-sqlite3";

export interface AnalysisPayload {
  isin: string;
  asOfDate: string; // YYYY-MM-DD (IST)
  fundamentals: {
    pe: number | null; pb: number | null; roe: number | null; roce: number | null;
    debt_equity: number | null; sales_growth_3y: number | null;
    profit_growth_3y: number | null; div_yield: number | null;
    market_cap: number | null; promoter_holding: number | null;
    source: string | null; source_url: string | null;
    fetch_status: "ok" | "stale" | "failed";
  };
  extra: { metric_key: string; value_num: number | null; unit: string | null }[];
  peers: {
    peer_symbol: string; peer_company: string | null;
    pe: number | null; roe: number | null; roce: number | null; sales_growth: number | null;
  }[];
  analysis: {
    narrative: string; verdict: "BUY" | "SELL" | "HOLD"; confidence: "Low" | "Medium" | "High";
    model_version: string; prompt_version: string;
  };
}

export function writeAnalysis(db: Database.Database, p: AnalysisPayload): void {
  const nowIso = new Date().toISOString();

  const fund = db.prepare(
    `INSERT INTO fundamentals(isin,as_of_date,pe,pb,roe,roce,debt_equity,sales_growth_3y,
       profit_growth_3y,div_yield,market_cap,promoter_holding,fetched_at,source,source_url,fetch_status)
     VALUES(@isin,@as_of_date,@pe,@pb,@roe,@roce,@debt_equity,@sales_growth_3y,
       @profit_growth_3y,@div_yield,@market_cap,@promoter_holding,@fetched_at,@source,@source_url,@fetch_status)
     ON CONFLICT(isin,as_of_date) DO UPDATE SET
       pe=excluded.pe,pb=excluded.pb,roe=excluded.roe,roce=excluded.roce,
       debt_equity=excluded.debt_equity,sales_growth_3y=excluded.sales_growth_3y,
       profit_growth_3y=excluded.profit_growth_3y,div_yield=excluded.div_yield,
       market_cap=excluded.market_cap,promoter_holding=excluded.promoter_holding,
       fetched_at=excluded.fetched_at,source=excluded.source,source_url=excluded.source_url,
       fetch_status=excluded.fetch_status`,
  );
  const extra = db.prepare(
    `INSERT INTO fundamentals_extra(isin,as_of_date,metric_key,value_num,unit)
     VALUES(@isin,@as_of_date,@metric_key,@value_num,@unit)
     ON CONFLICT(isin,as_of_date,metric_key) DO UPDATE SET
       value_num=excluded.value_num,unit=excluded.unit`,
  );
  const peer = db.prepare(
    `INSERT INTO peers(isin,as_of_date,peer_symbol,peer_company,pe,roe,roce,sales_growth)
     VALUES(@isin,@as_of_date,@peer_symbol,@peer_company,@pe,@roe,@roce,@sales_growth)
     ON CONFLICT(isin,as_of_date,peer_symbol) DO UPDATE SET
       peer_company=excluded.peer_company,pe=excluded.pe,roe=excluded.roe,
       roce=excluded.roce,sales_growth=excluded.sales_growth`,
  );
  const analysis = db.prepare(
    `INSERT INTO analysis(isin,narrative,verdict,confidence,generated_at,model_version,prompt_version)
     VALUES(@isin,@narrative,@verdict,@confidence,@generated_at,@model_version,@prompt_version)
     ON CONFLICT(isin) DO UPDATE SET
       narrative=excluded.narrative,verdict=excluded.verdict,confidence=excluded.confidence,
       generated_at=excluded.generated_at,model_version=excluded.model_version,
       prompt_version=excluded.prompt_version`,
  );

  const tx = db.transaction(() => {
    fund.run({ isin: p.isin, as_of_date: p.asOfDate, fetched_at: nowIso, ...p.fundamentals });
    for (const e of p.extra) extra.run({ isin: p.isin, as_of_date: p.asOfDate, ...e });
    for (const pr of p.peers) peer.run({ isin: p.isin, as_of_date: p.asOfDate, ...pr });
    analysis.run({ isin: p.isin, generated_at: nowIso, ...p.analysis });
  });
  tx();
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npx vitest run tests/analysis-writer.test.ts`

- [ ] **Step 5: Commit**

```bash
git add lib/ingest/analysis-writer.ts tests/analysis-writer.test.ts
git commit -m "feat: transactional analysis writer (fundamentals/extra/peers/analysis)"
```

---

## Task 5: Persist CLI

**Files:**
- Create: `scripts/persist-analysis.ts`

The agent calls this via Bash, passing the payload JSON in `ANALYSIS_PAYLOAD`.

- [ ] **Step 1: Create `scripts/persist-analysis.ts`**

```ts
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { writeAnalysis, type AnalysisPayload } from "@/lib/ingest/analysis-writer";

function istDate(now = Date.now()): string {
  return new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);
}

function main(): void {
  const dbPath = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";
  const raw = process.env.ANALYSIS_PAYLOAD;
  if (!raw) throw new Error("ANALYSIS_PAYLOAD env is required");
  const input = JSON.parse(raw) as Omit<AnalysisPayload, "asOfDate"> & { asOfDate?: string };
  const payload: AnalysisPayload = { ...input, asOfDate: input.asOfDate ?? istDate() };

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  try {
    writeAnalysis(db, payload);
  } finally {
    db.close();
  }
  process.stdout.write(
    JSON.stringify({ status: "ok", isin: payload.isin, asOfDate: payload.asOfDate }) + "\n",
  );
}

try {
  main();
} catch (err) {
  process.stdout.write(
    JSON.stringify({ status: "error", message: err instanceof Error ? err.message : String(err) }) + "\n",
  );
  process.exit(1);
}
```

- [ ] **Step 2: Smoke test it manually**

Run:
```bash
ANALYSIS_PAYLOAD='{"isin":"INETEST01011","fundamentals":{"pe":10,"pb":null,"roe":20,"roce":25,"debt_equity":0.1,"sales_growth_3y":12,"profit_growth_3y":15,"div_yield":1.5,"market_cap":100000000000,"promoter_holding":60,"source":"screener.in","source_url":"x","fetch_status":"ok"},"extra":[],"peers":[],"analysis":{"narrative":"test","verdict":"HOLD","confidence":"Medium","model_version":"m","prompt_version":"v1"}}' \
PORTFOLIO_DB_PATH=./data/portfolio.db npx tsx scripts/persist-analysis.ts
```
Expected: `{"status":"ok","isin":"INETEST01011","asOfDate":"2026-..."}`. Then clean up:
```bash
npx tsx -e 'import D from "better-sqlite3";const d=new D("./data/portfolio.db");d.prepare("DELETE FROM analysis WHERE isin=?").run("INETEST01011");d.prepare("DELETE FROM fundamentals WHERE isin=?").run("INETEST01011");console.log("cleaned")'
```

- [ ] **Step 3: Commit**

```bash
git add scripts/persist-analysis.ts
git commit -m "feat: persist-analysis CLI wrapping the analysis writer"
```

---

## Task 6: Wire the screener MCP server into .mcp.json

**Files:**
- Modify: `.mcp.json`

- [ ] **Step 1: Ensure screener-mcp is built**

Run: `ls /Users/ashunsah/Desktop/screener-mcp/dist/index.js`
Expected: file exists. If not: `cd /Users/ashunsah/Desktop/screener-mcp && npm run build`.

- [ ] **Step 2: Edit `.mcp.json`** — add the `screener` server alongside `agentboard`:

```json
{
  "mcpServers": {
    "agentboard": {
      "type": "http",
      "url": "https://jiraagent.vercel.app/api/mcp",
      "headers": {
        "Authorization": "Bearer <existing-token>"
      }
    },
    "screener": {
      "command": "node",
      "args": ["/Users/ashunsah/Desktop/screener-mcp/dist/index.js"]
    }
  }
}
```
(Keep the existing agentboard token value unchanged. `.mcp.json` is gitignored — do not commit it.)

- [ ] **Step 3: Reconnect MCP in Claude Code**

Run `/mcp` and confirm `screener` connects and lists `get_fundamentals`, `get_financials`, `get_peers`, `get_chart`. (Manual step — no commit; the file is gitignored.)

---

## Task 7: Create the fundamental-analyst agent

**Files:**
- Create: `.claude/agents/fundamental-analyst.md`

- [ ] **Step 1: Create `.claude/agents/fundamental-analyst.md`**

```markdown
---
name: fundamental-analyst
description: Sector-aware fundamental analysis of an Indian stock. Fetches data via the screener MCP, grades ratios, produces a BUY/SELL/HOLD call with reasoning, and persists it so the dashboard deep-dive populates. Invoke per stock (symbol + exchange).
tools:
  - Read
  - Bash
  - Skill
  - mcp__screener__get_fundamentals
  - mcp__screener__get_financials
  - mcp__screener__get_peers
  - mcp__screener__get_chart
  - mcp__kite__get_holdings
---

You are a fundamental-analysis agent for a single Indian stock. You are given a `symbol`
(and optional `exchange`, default NSE) and optionally an `isin`.

## Recommendation policy (shared with portfolio-agent)

This is a local, single-user tool, so you MAY give recommendations including BUY/SELL/HOLD.
Every recommendation MUST include: per-axis reasoning, the underlying numbers, and the
disclaimer "Educational only — not SEBI-registered investment advice. At your own risk."
You MUST NOT place, modify, or cancel any order.

## Procedure

1. **Gather** (call these screener tools; they take the symbol):
   - `get_fundamentals` → ratios, pros/cons, sector
   - `get_peers` → peer table + median
   - `get_financials` → multi-year P&L / balance sheet / cash flow
   - `get_chart` with `metric: "Price"` → for valuation-vs-history context
   If a fetch fails or the symbol is unknown, set fetch_status "failed" and still
   report; do not fabricate numbers.
2. **Position context:** if an isin/holding is provided or found via holdings, note avg
   cost, current P&L, and portfolio weight. (Read from data/portfolio.db is done by the
   persist step; for reasoning you may use numbers passed to you.)
3. **Grade** each ratio Good/Fair/Weak using SECTOR-AWARE judgement: banks/NBFCs on
   NIM/GNPA/CASA/ROE (not debt/equity); IT on margins/growth; cyclicals on the cycle.
4. **Synthesize** a BUY/SELL/HOLD verdict + confidence (Low/Medium/High) weighing four
   axes, each cited with numbers: Quality (graded fundamentals + trend direction),
   Valuation (vs peers AND vs own history), Position (your cost/P&L/weight), and the
   overall risk picture.
5. **Persist:** build the AnalysisPayload JSON (isin required; parse Screener display
   strings to numbers using the same rules as lib/screener-parse.ts — strip ₹/%/×/commas,
   market cap crore→paise ×1e9), then run:
   ```bash
   ANALYSIS_PAYLOAD='<json>' PORTFOLIO_DB_PATH=./data/portfolio.db npx tsx scripts/persist-analysis.ts
   ```
   Confirm it prints `{"status":"ok",...}`.
6. **Report** in chat: the scorecard, the verdict + confidence + per-axis reasoning, and
   the disclaimer.

## Notes
- ISIN is the DB key. In batch mode the caller passes it. If analyzing a non-held stock
  with no known ISIN, derive a stable fallback id `SYM-<symbol>` and note that fundamentals
  won't join to a holding.
- Never invent data. If Screener lacks a metric, leave it null.
```

- [ ] **Step 2: Verify the agent is discoverable**

Run: `ls .claude/agents/` — expect `fundamental-analyst.md` and `portfolio-agent.md`.
(Agent registration is picked up by Claude Code; no automated test.)

- [ ] **Step 3: Commit**

```bash
git add .claude/agents/fundamental-analyst.md
git commit -m "feat: fundamental-analyst agent definition"
```

---

## Task 8: Update portfolio-agent (shared policy + batch fan-out)

**Files:**
- Modify: `.claude/agents/portfolio-agent.md`

- [ ] **Step 1: Replace rule #4** in `.claude/agents/portfolio-agent.md`.

Old (remove):
```
4. **Never give financial advice.** State observations ("AURIONPRO is down 54% from your average price") not recommendations ("you should sell AURIONPRO").
```
New:
```
4. **Recommendations are allowed (local, single-user tool).** You MAY give buy/sell/hold
   and other recommendations, but ALWAYS with reasoning, the underlying numbers, and the
   disclaimer "Educational only — not SEBI-registered investment advice. At your own risk."
   You MUST NOT place, modify, or cancel orders (that boundary is unchanged).
```

- [ ] **Step 2: Add a batch fan-out note** to the orchestration section (after the fetch step):

```
- After `fetch-holdings`, you MAY analyze fundamentals for each holding by invoking the
  `fundamental-analyst` agent per stock (pass symbol, exchange, and isin from the holdings
  data). Run them in parallel where possible; a failure on one stock must not block others.
```

- [ ] **Step 3: Commit**

```bash
git add .claude/agents/portfolio-agent.md
git commit -m "feat: unify recommendation policy + add fundamental-analyst batch fan-out"
```

---

## Task 9: Surface verdict + confidence in the deep-dive UI

**Files:**
- Modify: `app/stock/[symbol]/page.tsx` (fetch verdict) and `components/portfolio/DeepDiveClient.tsx` (render)
- Modify: `lib/db/index.ts` — extend `getAnalysis` result typing if needed

- [ ] **Step 1: Confirm `getAnalysis` returns the new columns**

`getAnalysis` does `SELECT * FROM analysis`, so `verdict`/`confidence` already come back.
Update the `AnalysisRow` type in `lib/types.ts` to include them:

```ts
export interface AnalysisRow {
  isin: string;
  narrative: string | null;
  verdict: string | null;
  confidence: string | null;
  generated_at: string | null;
  model_version: string | null;
  prompt_version: string | null;
}
```

- [ ] **Step 2: Pass verdict/confidence into DeepDiveClient**

In `app/stock/[symbol]/page.tsx`, where `analysis` is currently derived
(`analysis = analysisRow?.narrative ?? null`), also pass the verdict:

```tsx
const analysisRowFull = row.isin ? await getAnalysis(row.isin) : null;
// ...pass to the client:
verdict={analysisRowFull?.verdict ?? null}
confidence={analysisRowFull?.confidence ?? null}
```
Add matching props `verdict?: string | null; confidence?: string | null;` to `DeepDiveClient`.

- [ ] **Step 3: Render a verdict badge** in `DeepDiveClient.tsx`, in the Analysis section header:

```tsx
{verdict && (
  <span
    className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold ${
      verdict === "BUY" ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
      : verdict === "SELL" ? "bg-red-50 text-red-700 border border-red-200"
      : "bg-amber-50 text-amber-700 border border-amber-200"
    }`}
  >
    {verdict}{confidence ? ` · ${confidence}` : ""}
  </span>
)}
```
Place it next to the "Analysis" `<h2>`. Keep the existing disclaimer line below the narrative.

- [ ] **Step 4: Build to verify**

Run: `npm run build`
Expected: exit 0, `/stock/[symbol]` compiles.

- [ ] **Step 5: Commit**

```bash
git add app/stock/[symbol]/page.tsx components/portfolio/DeepDiveClient.tsx lib/types.ts
git commit -m "feat: render BUY/SELL/HOLD verdict badge on deep-dive page"
```

---

## Task 10: End-to-end verification

**Files:** none (manual verification)

- [ ] **Step 1: Full test suite green**

Run: `npm run test`
Expected: all tests pass (existing + new parser/writer/schema/migration tests).

- [ ] **Step 2: Live agent run on one held stock**

In Claude Code, invoke the `fundamental-analyst` agent for a held stock with a known ISIN
(e.g. TCS / INE467B01029, NSE). Confirm:
- it calls the screener tools,
- prints a scorecard + BUY/SELL/HOLD + confidence + disclaimer,
- the persist CLI printed `{"status":"ok",...}`.

- [ ] **Step 3: Verify persistence + dashboard**

```bash
npx tsx -e 'import D from "better-sqlite3";const d=new D("./data/portfolio.db");console.log(d.prepare("SELECT verdict,confidence,substr(narrative,1,60) n FROM analysis WHERE isin=?").get("INE467B01029"))'
```
Then launch the dashboard and open `/stock/TCS?exchange=NSE`; confirm the fundamentals
scorecard, peers, narrative, and the verdict badge all render.

- [ ] **Step 4: Live batch smoke (2 stocks)**

Invoke the analyst for a second, different-sector held stock (e.g. a bank). Confirm
sector-aware grading differs (bank judged on NPA/NIM, not debt/equity) and both persist
without one blocking the other.

---

## Self-review notes

- **Spec coverage:** §3 architecture → Tasks 4,5,7; §4 analysis flow → Task 7; §5 persistence + schema change → Tasks 1,2,4,5; §5 numeric parsing → Task 3; §6 invocation/.mcp.json → Tasks 6,8; §7 error handling → writer `fetch_status` test (Task 4) + agent procedure (Task 7); §8 testing → Tasks 1–4,10; §9 shared policy → Tasks 7,8; UI verdict → Task 9.
- **Type consistency:** `AnalysisPayload` defined once in Task 4, imported by Task 5; `AnalysisRow` extended in Task 9 matches the schema in Task 1. `parseScreenerNumber`/`parseCroreToPaise` (Task 3) are the parsing rules the agent mirrors (Task 7).
- **Known judgement calls:** the agent parses Screener strings itself (guided by the same rules as `lib/screener-parse.ts`) rather than importing the lib, since it builds JSON in-context; the lib + its tests exist so the rules are specified and testable. Sector-grading is LLM-judgement in the agent prompt (not a hardcoded table) — acceptable since verdicts are explainable and stored with prompt_version.
