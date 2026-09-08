import { runTechnicalBacktest } from "../lib/backtest";

async function main() {
  for (const rr of [3, 2, 1.5]) {
    const result = await runTechnicalBacktest("local", { targetRMultiple: rr });
    const s = result.summary;
    console.log(`\n=== R:R = 1:${rr} ===`);
    console.log(`trades=${s.n_trades} symbols=${s.n_symbols_traded}`);
    console.log(`win_rate=${s.win_rate_pct?.toFixed(1)}% avg_return=${s.avg_return_pct?.toFixed(3)}% median_return=${s.median_return_pct?.toFixed(3)}%`);
    console.log(`profit_factor=${s.profit_factor === Infinity ? "inf" : s.profit_factor?.toFixed(3)} avg_days_held=${s.avg_bars_held?.toFixed(1)}`);
    console.log(`exit_reasons=${JSON.stringify(s.exit_reasons)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
