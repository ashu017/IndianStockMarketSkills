# Fundamental Analysis Agent — Design

**Date:** 2026-07-21
**Status:** Approved design, pending implementation plan
**Related:** `screener-mcp` (standalone repo), `2026-07-06-portfolio-replatform-design.md`, `2026-07-06-api-definitions.md`

## 1. Summary

A single reusable Claude Code subagent, **`fundamental-analyst`**, that performs
sector-aware fundamental analysis of an Indian stock and persists the result so the
dashboard deep-dive scorecard populates. Invoked per-stock (on-demand for one symbol,
and fanned out in parallel across all holdings during `/portfolio`). It produces a
graded ratio scorecard, a narrative, and an explicit **BUY / SELL / HOLD** call with
confidence and per-axis reasoning, written into the existing `fundamentals` /
`fundamentals_extra` / `peers` / `analysis` tables.

Unlike the read-only `portfolio-agent`, this agent **reads and persists** (via a Node
script; it never writes SQLite directly). It has **no Kite order tools**.

## 2. Goals / Non-goals

### Goals
- One reusable `fundamental-analyst` agent, invoked per stock (symbol + exchange).
- Sector-aware grading (banks on NIM/GNPA/CASA, not D/E; IT on margins; etc.).
- An explicit buy/sell/hold verdict + confidence, weighing four evidence axes.
- Persist structured rows + narrative + verdict so the dashboard deep-dive lights up.
- Two entry points: on-demand single stock, and parallel batch inside `/portfolio`.

### Non-goals (deferred / out of scope)
- Live trading / order placement (the agent has no Kite write tools).
- Real-time intraday fundamentals (Screener updates daily at best).
- Replacing the `portfolio-agent`'s no-advice stance — this agent OWNS the advice
  behavior explicitly; the portfolio-agent is unchanged.

## 3. Architecture

```
                 ┌───────────────────────────────────────────┐
   invoke(symbol,│         fundamental-analyst agent           │
     exchange)   │                                             │
   ─────────────▶│  1. screener-mcp: get_fundamentals,         │
                 │     get_peers, get_financials, get_chart    │
                 │  2. lib/db getHolding → your position       │
                 │  3. grade vs sector thresholds (lib/grades) │
                 │  4. synthesize BUY/SELL/HOLD + narrative    │
                 │  5. persist via scripts/persist-analysis.ts │
                 └───────────────┬─────────────────────────────┘
                                 ▼
        fundamentals / fundamentals_extra / peers / analysis (SQLite)
                                 ▼
              dashboard /stock/[symbol] deep-dive scorecard
```

**Agent definition:** `.claude/agents/fundamental-analyst.md`.
**Tools granted:** the 4 `screener-mcp` tools (`get_fundamentals`, `get_peers`,
`get_financials`, `get_chart`), `Read`, `Bash` (to run the persist script + read
holdings), `Skill`. Explicitly **no** `mcp__kite__place_order`/modify/cancel.

## 4. Analysis flow (per stock)

Given `symbol` + `exchange`:

1. **Gather** (parallel):
   - `get_fundamentals` → ratio scorecard, pros/cons, sector
   - `get_peers` → peer table + sector median
   - `get_financials` → multi-year P&L / balance sheet / cash flow (trend direction)
   - `get_chart` → historical P/E or price (valuation-vs-own-history)
   - `lib/db getHolding(user, symbol, exchange)` → avg cost, CMP, P&L%, weight
2. **Grade** each ratio Good/Fair/Weak via sector-keyed thresholds (`lib/grades.ts`).
3. **Synthesize the call** weighing four axes:
   - **Quality** — graded fundamentals + financial-trend direction
   - **Valuation** — cheap/expensive vs peers AND vs own history
   - **Position** — your avg cost, unrealized P&L, portfolio weight (informs trim/add)
   - → **BUY / SELL / HOLD** + confidence (Low/Med/High), each axis cited with numbers
4. **Guardrails:** every verdict carries per-axis rationale + an "educational, not
   SEBI-registered advice, at your own risk" disclaimer. Stored with model/prompt version.

## 5. Persistence & data flow

The agent (an LLM) cannot write SQLite directly. It calls **`scripts/persist-analysis.ts`**
with a structured JSON payload (via `Bash` + env or a temp file). The script upserts:

- **`fundamentals`** — typed numeric columns (pe, pb, roe, roce, debt_equity, growth,
  div_yield, market_cap, promoter_holding), keyed `(isin, as_of_date)`.
- **`fundamentals_extra`** — sector metrics (e.g. `nim`, `gross_npa`, `casa`), keyed
  `(isin, as_of_date, metric_key)`.
- **`peers`** — peer rows, keyed `(isin, as_of_date, peer_symbol)`.
- **`analysis`** — narrative + **verdict** + **confidence**, keyed `(isin)` (latest-wins),
  with `model_version` / `prompt_version`.

### Schema change (required)
The `analysis` table currently lacks verdict fields. Add via migration:
```sql
ALTER TABLE analysis ADD COLUMN verdict TEXT;      -- 'BUY' | 'SELL' | 'HOLD'
ALTER TABLE analysis ADD COLUMN confidence TEXT;   -- 'Low' | 'Medium' | 'High'
```
The deep-dive UI's Analysis section renders the verdict + confidence alongside the narrative.

### Numeric parsing
`screener-mcp` returns display strings ("₹ 8,14,737 Cr.", "15.2", "2.84 %", "—"). A single
`parseScreenerValue` helper converts them: crore→paise for `market_cap`, strip `×`/`%`,
map "—"/"" → null. Lives in the persist script (or a shared `lib/screener-parse.ts`).

### Symbol → ISIN
DB tables key on ISIN; Screener uses symbol. ISIN comes from the holdings row
(`stock_meta.isin`) — trivial in batch mode. For an ad-hoc non-held stock with no ISIN,
persist keyed by a symbol-derived fallback id and still return the chat verdict.

## 6. Invocation & batch

- **On-demand:** invoke `fundamental-analyst` with one symbol → full analysis, persist,
  chat verdict.
- **Batch in `/portfolio`:** after `fetch-holdings`, the portfolio-agent fans the analyst
  out across all holdings in **parallel** (bounded concurrency). Each stock is independent.
- **`.mcp.json`:** add the `screener` MCP server (points at the built `screener-mcp`
  `dist/index.js`) so the agent has the tools. (Currently not wired.)

## 7. Error handling (per-stock, non-blocking)

- **Fetch fails / symbol not found** → write `fetch_status='failed'`, skip persisting bad
  data, report which stocks failed. One bad stock never blocks the batch.
- **Idempotency / TTL** → `(isin, as_of_date)` keying makes same-day re-runs upsert; a TTL
  check skips stocks already analyzed today unless forced.
- **Screener markup drift** → surfaces as parse gaps; `fetch_status` flags partial data
  rather than persisting garbage.

## 8. Testing

- **`scripts/persist-analysis.ts`** — unit tests: fixture payload → in-memory SQLite,
  assert rows in all 4 tables + idempotent re-run overwrites (no dupes).
- **`parseScreenerValue`** — unit tests: "₹8,14,737 Cr."→paise, "15.2"→15.2,
  "2.84 %"→2.84, "—"→null.
- **`analysis` migration** — schema test confirms `verdict` + `confidence` columns exist.
- **Agent behavior** — live end-to-end on 2–3 real stocks (TCS, a bank, a loss-maker);
  verify persisted rows + verdict are sane and the dashboard deep-dive renders them.

## 9. Guardrails & disclaimers

- Verdict is educational, explicitly **not** SEBI-registered investment advice; disclaimer
  stored with and surfaced next to every call.
- Every verdict is explainable: per-axis reasoning + the underlying numbers are persisted.
- Auditable: `model_version` + `prompt_version` stamped on each `analysis` row.
- No trade execution — agent cannot place/modify/cancel orders.
