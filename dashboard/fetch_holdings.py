"""Pure transform helpers for Kite holdings. No MCP calls happen here."""
from __future__ import annotations
import json
import os
import tempfile
from typing import Iterable


def normalize_holdings(raw: Iterable[dict], *, now: str) -> dict:
    holdings = []
    for h in raw:
        qty = int(h["quantity"])
        avg = float(h["average_price"])
        ltp = float(h["last_price"])
        invested = qty * avg
        current_value = qty * ltp
        pnl = float(h["pnl"])
        pnl_pct = (pnl / invested * 100.0) if invested else 0.0
        holdings.append({
            "symbol": h["tradingsymbol"],
            "exchange": h["exchange"],
            "qty": qty,
            "avg_price": avg,
            "ltp": ltp,
            "close_price": float(h["close_price"]),
            "invested": round(invested, 2),
            "current_value": round(current_value, 2),
            "pnl": round(pnl, 2),
            "pnl_pct": round(pnl_pct, 2),
            "day_change": float(h["day_change"]),
            "day_change_pct": float(h["day_change_percentage"]),
        })

    total_current = sum(h["current_value"] for h in holdings)
    for h in holdings:
        h["weight_pct"] = round(h["current_value"] / total_current * 100, 2) if total_current else 0.0

    total_invested = sum(h["invested"] for h in holdings)
    total_pnl = sum(h["pnl"] for h in holdings)
    total_pnl_pct = (total_pnl / total_invested * 100) if total_invested else 0.0
    day_pnl = sum(h["day_change"] * h["qty"] for h in holdings)
    prev_close_value = sum(h["close_price"] * h["qty"] for h in holdings)
    day_pnl_pct = (day_pnl / prev_close_value * 100) if prev_close_value else 0.0

    winners = sum(1 for h in holdings if h["pnl"] > 0)
    losers = sum(1 for h in holdings if h["pnl"] < 0)

    return {
        "fetched_at": now,
        "holdings": holdings,
        "summary": {
            "total_invested": round(total_invested, 2),
            "current_value": round(total_current, 2),
            "total_pnl": round(total_pnl, 2),
            "total_pnl_pct": round(total_pnl_pct, 2),
            "day_pnl": round(day_pnl, 2),
            "day_pnl_pct": round(day_pnl_pct, 2),
            "holdings_count": len(holdings),
            "winners": winners,
            "losers": losers,
        },
    }


def atomic_write_json(path: str, data: dict) -> None:
    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".holdings-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, path)
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
