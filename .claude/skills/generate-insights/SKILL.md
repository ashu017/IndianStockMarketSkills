---
name: generate-insights
description: Read data/holdings.json and write a 150-250 word markdown insights summary to data/insights.md. Covers winners, losers, concentration risk, and notable day moves.
---

# generate-insights

Synthesize a tight, scannable markdown summary of the user's portfolio using `data/holdings.json`. The dashboard renders this file as the "AI Insights" panel.

## When to use

After `fetch-holdings` writes `data/holdings.json`. Always re-run when holdings change.

## Steps

1. Read `data/holdings.json`. If it does not exist or is empty, write `data/insights.md` with the single line `_No holdings to analyze._` and stop.
2. Identify:
   - Top 3 winners by `pnl` (₹) and by `pnl_pct` (%)
   - Top 3 losers by `pnl` (₹) and by `pnl_pct` (%)
   - Top 3 holdings by `weight_pct` (concentration)
   - Day's biggest movers (up and down) by `day_change_pct`
3. Write a 150–250 word markdown summary covering:
   - **Headline:** overall portfolio P&L and day P&L
   - **Carrying the book:** top 1–2 winners and how much P&L they contribute
   - **Drag:** top 1–2 losers
   - **Concentration:** flag if top 3 > 40% of weight
   - **Today's notable moves:** biggest up and down movers
4. Atomic write to `data/insights.md` (write to a `.tmp` sibling, then `os.rename`).
5. Report: "Wrote insights (X words)."

## Style

- Indian markets, Indian rupees (₹).
- Plain markdown — headers (`##`), bold for emphasis. No tables (the dashboard renders them separately).
- Be specific: name stocks, give numbers. Avoid generic advice ("consider diversifying" only when concentration > 40%).
- No financial advice. Observations only.
