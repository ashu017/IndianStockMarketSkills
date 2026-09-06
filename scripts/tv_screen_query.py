#!/usr/bin/env python3
"""
Query the live TradingView screener for the India market with a fixed set of
technical filters, and print one JSON line to stdout.

Called by scripts/technical-screener.ts (spawned as a subprocess) rather than
via the tradingview-mcp Node server — see the design note in that file for why.

This script performs NO local computation: every filter and every returned value
is server-side, live-as-of-now TradingView data. It does not read or write the
project's SQLite DB.

Filters (all tunable via env, matching lib/verdict.ts's naming where the concept
overlaps, so the two screens read as the same recipe applied on two data sources):
  TV_RSI_MIN / TV_RSI_MAX       RSI band (default 45..70 — momentum without overbought)
  TV_REQUIRE_GOLDEN_CROSS       "1" (default) requires close > SMA200 AND SMA50 > SMA200
  TV_REQUIRE_MACD_BULL          "1" (default) requires MACD.macd > MACD.signal
  TV_MIN_REL_VOLUME             relative_volume_10d_calc floor (default 1.2)
  TV_MIN_MARKET_CAP_CR          market cap floor in INR crore (default 5000)
  TV_MIN_ADX                    trend-strength floor (default 0, i.e. off)
  TV_TOP_N                      rows to return, ranked by Recommend.All desc (default 30)

Env:
  none required beyond the filters above.

Exit codes: 0 on success (even zero matches), 1 on any exception — the caller
should treat stdout as authoritative only when combined with a 0 exit code.
"""
import json
import os
import sys


def env_float(name: str, default: float) -> float:
    v = os.environ.get(name)
    return float(v) if v else default


def env_int(name: str, default: int) -> int:
    v = os.environ.get(name)
    return int(v) if v else default


def env_bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None:
        return default
    return v == "1"


COLUMNS = [
    "name", "exchange", "close", "volume", "market_cap_basic", "sector",
    "RSI", "ADX", "ADX+DI", "ADX-DI", "MACD.macd", "MACD.signal",
    "SMA20", "SMA50", "SMA200", "relative_volume_10d_calc",
    "Perf.1M", "Perf.3M", "Perf.6M", "Recommend.All",
]


def main() -> None:
    from tradingview_screener import Query, Column as col

    rsi_min = env_float("TV_RSI_MIN", 45.0)
    rsi_max = env_float("TV_RSI_MAX", 70.0)
    require_golden_cross = env_bool("TV_REQUIRE_GOLDEN_CROSS", True)
    require_macd_bull = env_bool("TV_REQUIRE_MACD_BULL", True)
    min_rel_volume = env_float("TV_MIN_REL_VOLUME", 1.2)
    min_market_cap_cr = env_float("TV_MIN_MARKET_CAP_CR", 5000.0)
    min_adx = env_float("TV_MIN_ADX", 0.0)
    top_n = env_int("TV_TOP_N", 30)

    conditions = [
        col("exchange") == "NSE",  # avoid NSE/BSE duplicate rows for the same stock
        col("RSI").between(rsi_min, rsi_max),
        col("relative_volume_10d_calc") >= min_rel_volume,
        col("market_cap_basic") >= min_market_cap_cr * 1_00_00_000,  # crore -> rupees
    ]
    if require_golden_cross:
        conditions.append(col("close") > col("SMA200"))
        conditions.append(col("SMA50") > col("SMA200"))
    if require_macd_bull:
        conditions.append(col("MACD.macd") > col("MACD.signal"))
    if min_adx > 0:
        conditions.append(col("ADX") >= min_adx)

    query = (
        Query()
        .set_markets("india")
        .select(*COLUMNS)
        .where(*conditions)
        .order_by("Recommend.All", ascending=False)
        .limit(top_n)
    )

    total_matched, df = query.get_scanner_data()

    rows = []
    for _, r in df.iterrows():
        symbol = str(r["ticker"]).split(":", 1)[-1]  # "NSE:RELIANCE" -> "RELIANCE"
        rows.append({
            "symbol": symbol,
            "exchange": r["exchange"],
            "close": _num(r["close"]),
            "volume": _num(r["volume"]),
            "market_cap_basic": _num(r["market_cap_basic"]),
            "sector": r["sector"] if isinstance(r["sector"], str) else None,
            "rsi": _num(r["RSI"]),
            "adx": _num(r["ADX"]),
            "adx_plus_di": _num(r["ADX+DI"]),
            "adx_minus_di": _num(r["ADX-DI"]),
            "macd": _num(r["MACD.macd"]),
            "macd_signal": _num(r["MACD.signal"]),
            "sma20": _num(r["SMA20"]),
            "sma50": _num(r["SMA50"]),
            "sma200": _num(r["SMA200"]),
            "relative_volume_10d": _num(r["relative_volume_10d_calc"]),
            "perf_1m": _num(r["Perf.1M"]),
            "perf_3m": _num(r["Perf.3M"]),
            "perf_6m": _num(r["Perf.6M"]),
            "recommend_all": _num(r["Recommend.All"]),
        })

    print(json.dumps({
        "status": "ok",
        "total_matched": int(total_matched),
        "returned": len(rows),
        "filters": {
            "rsi_min": rsi_min, "rsi_max": rsi_max,
            "require_golden_cross": require_golden_cross,
            "require_macd_bull": require_macd_bull,
            "min_rel_volume": min_rel_volume,
            "min_market_cap_cr": min_market_cap_cr,
            "min_adx": min_adx,
            "top_n": top_n,
        },
        "rows": rows,
    }))


def _num(v):
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f else None  # NaN check without importing math


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001 — this is the process boundary
        print(json.dumps({"status": "error", "message": str(e)}))
        sys.exit(1)
