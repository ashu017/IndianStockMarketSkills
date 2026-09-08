import { loadStrategyEquityHistory } from "../lib/strategy-equity";
loadStrategyEquityHistory("quality_trend_momentum_breakout").then((r) => {
  console.log(JSON.stringify(r, null, 2).slice(0, 4000));
}).catch((e) => console.error("ERROR:", e));
