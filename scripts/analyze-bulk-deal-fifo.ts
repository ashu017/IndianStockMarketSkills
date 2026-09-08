import Database from "better-sqlite3";
import { computeBulkDealFifoAnalysis } from "../lib/bulk-deal-fifo";

/**
 * FIFO-reconstructs institutional clients' actual bulk-deal buy→sell trades,
 * excludes clients whose overall trading pattern is HFT/market-maker-like
 * (median holding period <= threshold across ALL their realized trades —
 * see lib/bulk-deal-fifo.ts), and reports the rest, keyed by firm.
 *
 * Usage: PORTFOLIO_DB_PATH=./data/portfolio.db npx tsx scripts/analyze-bulk-deal-fifo.ts
 */

const DB_PATH = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";

function main() {
  const db = new Database(DB_PATH, { readonly: true });
  const r = computeBulkDealFifoAnalysis(db);

  console.log(`Institutional BUY rows in bulk_deals: ${r.total_institutional_buy_rows}`);
  console.log(`Realized (matched buy→sell) trades, all firms: ${r.realized_trade_count_all_firms}`);
  console.log(`Firms classified HFT/market-maker-like (median hold <= ${r.hft_holding_days_threshold}d) and excluded: ${r.hft_firms_excluded_count}`);
  console.log(`Realized trades excluded via that firm filter: ${r.hft_realized_trades_excluded_count}`);
  console.log(`Non-HFT realized trades remaining: ${r.non_hft_realized_trade_count}`);
  console.log(`Unmatched sell events (no prior disclosed buy lot): ${r.unmatched_sell_events} (qty ${r.unmatched_sell_qty.toLocaleString("en-IN")})`);
  console.log(`Open lots at end of data (unrealized): ${r.open_lots_count} (qty ${r.open_lots_qty.toLocaleString("en-IN")})`);
  console.log("");

  if (!r.overall) {
    console.log("No non-HFT realized trades to report.");
    db.close();
    return;
  }

  console.log(`=== Overall, non-HFT firms only (n=${r.non_hft_realized_trade_count}) ===`);
  console.log(`Simple mean return:   ${r.overall.mean_return_pct.toFixed(2)}%`);
  console.log(`Simple median return: ${r.overall.median_return_pct.toFixed(2)}%`);
  console.log(`Qty-weighted return:  ${r.overall.qty_weighted_return_pct.toFixed(2)}%`);
  console.log(`Win rate (per trade): ${r.overall.win_rate_pct.toFixed(1)}%`);
  console.log(`Median holding period: ${r.overall.median_holding_days.toFixed(0)} days (mean: ${r.overall.mean_holding_days.toFixed(0)} days)`);

  for (const b of r.holding_buckets) {
    console.log(
      `  ${b.label.padEnd(15)} n=${b.n}  mean=${b.mean_return_pct.toFixed(2)}%  median=${b.median_return_pct.toFixed(2)}%  win_rate=${b.win_rate_pct.toFixed(1)}%`,
    );
  }

  console.log(`\n=== Most active non-HFT firms by realized trade count (top 20) ===`);
  for (const f of r.top_active_firms) {
    console.log(
      `${f.client_name.padEnd(45).slice(0, 45)} n=${String(f.n).padEnd(5)} qty_wtd_return=${f.qty_weighted_return_pct.toFixed(2).padStart(7)}%  ` +
        `win_rate=${f.win_rate_pct.toFixed(1).padStart(5)}%  median_hold=${f.median_holding_days.toFixed(0)}d`,
    );
  }

  console.log(`\n=== Best qty-weighted return, non-HFT firms with >=5 realized trades (top 15) ===`);
  for (const f of r.best_firms) {
    console.log(
      `${f.client_name.padEnd(45).slice(0, 45)} n=${String(f.n).padEnd(5)} qty_wtd_return=${f.qty_weighted_return_pct.toFixed(2).padStart(7)}%  ` +
        `win_rate=${f.win_rate_pct.toFixed(1).padStart(5)}%  median_hold=${f.median_holding_days.toFixed(0)}d`,
    );
  }

  console.log(`\n=== Worst qty-weighted return, non-HFT firms with >=5 realized trades (bottom 15) ===`);
  for (const f of r.worst_firms) {
    console.log(
      `${f.client_name.padEnd(45).slice(0, 45)} n=${String(f.n).padEnd(5)} qty_wtd_return=${f.qty_weighted_return_pct.toFixed(2).padStart(7)}%  ` +
        `win_rate=${f.win_rate_pct.toFixed(1).padStart(5)}%  median_hold=${f.median_holding_days.toFixed(0)}d`,
    );
  }

  db.close();
}

main();
