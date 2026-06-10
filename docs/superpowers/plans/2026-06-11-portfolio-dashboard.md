# Portfolio Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude Code agent + 3 skills + Streamlit dashboard that lets a Zerodha Kite user run `/portfolio` and get a local dashboard at `http://localhost:8501` with KPIs, holdings table, allocation chart, and AI-generated insights.

**Architecture:** Three Python helper scripts implement the core logic (fetch/transform, dashboard launcher, dashboard app). Three Claude skills wrap the helpers as orchestration steps. One agent + one slash command tie it all together. Data flows via JSON+MD files in `data/` — Claude/agent owns fetch, dashboard owns render.

**Tech Stack:** Python 3.10+, Streamlit, Plotly, pytest, jsonschema; Claude Code skills/agents/commands as the orchestration layer; Zerodha Kite MCP for the data source.

---

## File Structure

**Python source (logic — testable):**
- `dashboard/fetch_holdings.py` — pure functions: `normalize_holdings(raw_kite_response) -> dict`, `atomic_write(path, data)`. **No** MCP calls (the skill makes those — this module only transforms).
- `dashboard/launch.py` — `find_free_port(start, end) -> int`, `launch_streamlit(port) -> int (pid)`, `is_stale(fetched_at, threshold_seconds) -> bool`. Used by `launch-dashboard` skill and the dashboard itself.
- `dashboard/app.py` — Streamlit app. Imports from `launch.py` for staleness check. Renders all sections.
- `dashboard/requirements.txt` — pinned deps.

**Tests:**
- `tests/__init__.py` — empty
- `tests/fixtures/kite_holdings_response.json` — 5-stock sample
- `tests/fixtures/holdings_normalized.json` — expected normalized output
- `tests/fixtures/holdings_schema.json` — JSON schema for output contract
- `tests/test_fetch_holdings.py` — transform math + schema validation + atomic write
- `tests/test_launch.py` — port finder + staleness logic
- `tests/test_app.py` — Streamlit `AppTest` smoke test (renders, empty state)

**Claude integration (orchestration):**
- `.claude/skills/fetch-holdings/SKILL.md`
- `.claude/skills/generate-insights/SKILL.md`
- `.claude/skills/launch-dashboard/SKILL.md`
- `.claude/agents/portfolio-agent.md`
- `.claude/commands/portfolio.md`

**Data (gitignored, runtime-created):**
- `data/holdings.json`
- `data/insights.md`
- `.streamlit.pid`, `.streamlit.port`

**Misc:**
- `.gitignore`
- `README.md`

---

## Task 1: Project Skeleton

**Files:**
- Create: `.gitignore`
- Create: `README.md`
- Create: `dashboard/requirements.txt`
- Create: `tests/__init__.py`

- [ ] **Step 1: Create `.gitignore`**

```gitignore
# Python
__pycache__/
*.pyc
*.pyo
.pytest_cache/
.venv/
venv/
*.egg-info/

# Runtime data
data/
.streamlit.pid
.streamlit.port
*.tmp

# OS
.DS_Store
```

- [ ] **Step 2: Create `dashboard/requirements.txt`**

```
streamlit==1.39.0
plotly==5.24.1
pandas==2.2.3
pytest==8.3.3
jsonschema==4.23.0
```

- [ ] **Step 3: Create `tests/__init__.py`** (empty file — establishes the test package)

- [ ] **Step 4: Create `README.md`**

```markdown
# Portfolio Dashboard

Claude Code agent + skills + Streamlit dashboard for Zerodha Kite portfolio holdings.

## Quick start

1. Install the Kite MCP server in Claude Code:
   ```bash
   claude mcp add --transport sse kite https://mcp.kite.trade/sse
   ```
2. Install Python deps:
   ```bash
   pip install -r dashboard/requirements.txt
   ```
3. In Claude Code, run:
   ```
   /portfolio
   ```
4. A browser opens at `http://localhost:8501` showing your dashboard.

## Refresh

Run `/portfolio refresh` in Claude Code to re-fetch holdings and update the dashboard.

## Architecture

See `docs/superpowers/specs/2026-06-11-portfolio-dashboard-design.md`.
```

- [ ] **Step 5: Set up Python venv and install**

Run:
```bash
cd /Users/ashunsah/Desktop/Stocks
python3 -m venv .venv
source .venv/bin/activate
pip install -r dashboard/requirements.txt
```
Expected: deps install cleanly.

- [ ] **Step 6: Commit**

```bash
git add .gitignore README.md dashboard/requirements.txt tests/__init__.py
git commit -m "chore: project skeleton for portfolio dashboard"
```

---

## Task 2: Test Fixtures

**Files:**
- Create: `tests/fixtures/kite_holdings_response.json`
- Create: `tests/fixtures/holdings_normalized.json`
- Create: `tests/fixtures/holdings_schema.json`

- [ ] **Step 1: Create `tests/fixtures/kite_holdings_response.json`** (5-holding sample mirroring the real Kite MCP shape; covers a winner, a loser, an ETF, BSE+NSE)

```json
[
  {
    "tradingsymbol": "MTARTECH",
    "exchange": "NSE",
    "quantity": 12,
    "average_price": 1944.2125,
    "last_price": 7106.5,
    "close_price": 7458.0,
    "pnl": 61947.45,
    "day_change": -351.5,
    "day_change_percentage": -4.713
  },
  {
    "tradingsymbol": "AURIONPRO",
    "exchange": "NSE",
    "quantity": 17,
    "average_price": 1615.532352,
    "last_price": 742.0,
    "close_price": 766.4,
    "pnl": -14850.05,
    "day_change": -24.4,
    "day_change_percentage": -3.184
  },
  {
    "tradingsymbol": "ASIANPAINT",
    "exchange": "BSE",
    "quantity": 5,
    "average_price": 2936.31,
    "last_price": 2700.0,
    "close_price": 2708.1,
    "pnl": -1181.55,
    "day_change": -8.1,
    "day_change_percentage": -0.299
  },
  {
    "tradingsymbol": "JUNIORBEES",
    "exchange": "NSE",
    "quantity": 35,
    "average_price": 734.818571,
    "last_price": 748.52,
    "close_price": 755.35,
    "pnl": 479.55,
    "day_change": -6.83,
    "day_change_percentage": -0.904
  },
  {
    "tradingsymbol": "AXISBANK",
    "exchange": "BSE",
    "quantity": 5,
    "average_price": 1076.15,
    "last_price": 1314.6,
    "close_price": 1292.6,
    "pnl": 1192.25,
    "day_change": 22.0,
    "day_change_percentage": 1.702
  }
]
```

- [ ] **Step 2: Create `tests/fixtures/holdings_normalized.json`** (expected output of normalizer; values pre-computed by hand)

```json
{
  "fetched_at": "2026-06-11T00:00:00+00:00",
  "holdings": [
    {
      "symbol": "MTARTECH",
      "exchange": "NSE",
      "qty": 12,
      "avg_price": 1944.2125,
      "ltp": 7106.5,
      "close_price": 7458.0,
      "invested": 23330.55,
      "current_value": 85278.0,
      "pnl": 61947.45,
      "pnl_pct": 265.53,
      "day_change": -351.5,
      "day_change_pct": -4.713,
      "weight_pct": 78.86
    },
    {
      "symbol": "AURIONPRO",
      "exchange": "NSE",
      "qty": 17,
      "avg_price": 1615.532352,
      "ltp": 742.0,
      "close_price": 766.4,
      "invested": 27464.05,
      "current_value": 12614.0,
      "pnl": -14850.05,
      "pnl_pct": -54.07,
      "day_change": -24.4,
      "day_change_pct": -3.184,
      "weight_pct": 11.66
    },
    {
      "symbol": "ASIANPAINT",
      "exchange": "BSE",
      "qty": 5,
      "avg_price": 2936.31,
      "ltp": 2700.0,
      "close_price": 2708.1,
      "invested": 14681.55,
      "current_value": 13500.0,
      "pnl": -1181.55,
      "pnl_pct": -8.05,
      "day_change": -8.1,
      "day_change_pct": -0.299,
      "weight_pct": 12.48
    },
    {
      "symbol": "JUNIORBEES",
      "exchange": "NSE",
      "qty": 35,
      "avg_price": 734.818571,
      "ltp": 748.52,
      "close_price": 755.35,
      "invested": 25718.65,
      "current_value": 26198.2,
      "pnl": 479.55,
      "pnl_pct": 1.86,
      "day_change": -6.83,
      "day_change_pct": -0.904,
      "weight_pct": 24.22
    },
    {
      "symbol": "AXISBANK",
      "exchange": "BSE",
      "qty": 5,
      "avg_price": 1076.15,
      "ltp": 1314.6,
      "close_price": 1292.6,
      "invested": 5380.75,
      "current_value": 6573.0,
      "pnl": 1192.25,
      "pnl_pct": 22.16,
      "day_change": 22.0,
      "day_change_pct": 1.702,
      "weight_pct": 6.08
    }
  ],
  "summary": {
    "total_invested": 96575.55,
    "current_value": 144163.2,
    "total_pnl": 47587.65,
    "total_pnl_pct": 49.28,
    "day_pnl": -4849.4,
    "day_pnl_pct": -3.25,
    "holdings_count": 5,
    "winners": 3,
    "losers": 2
  }
}
```

Note: `weight_pct` values are intentionally based on `current_value / sum(current_value) * 100` per design. Numbers above are rounded to 2 decimals for display; tests use `pytest.approx` with `abs=0.05`. The `fetched_at` is fixed in the fixture; the normalizer accepts an explicit `now` parameter for testability (see Task 3).

- [ ] **Step 3: Create `tests/fixtures/holdings_schema.json`** (JSON schema for the output contract)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["fetched_at", "holdings", "summary"],
  "properties": {
    "fetched_at": {"type": "string", "format": "date-time"},
    "holdings": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "symbol", "exchange", "qty", "avg_price", "ltp", "close_price",
          "invested", "current_value", "pnl", "pnl_pct",
          "day_change", "day_change_pct", "weight_pct"
        ],
        "properties": {
          "symbol": {"type": "string"},
          "exchange": {"type": "string", "enum": ["NSE", "BSE"]},
          "qty": {"type": "integer"},
          "avg_price": {"type": "number"},
          "ltp": {"type": "number"},
          "close_price": {"type": "number"},
          "invested": {"type": "number"},
          "current_value": {"type": "number"},
          "pnl": {"type": "number"},
          "pnl_pct": {"type": "number"},
          "day_change": {"type": "number"},
          "day_change_pct": {"type": "number"},
          "weight_pct": {"type": "number"}
        }
      }
    },
    "summary": {
      "type": "object",
      "required": [
        "total_invested", "current_value", "total_pnl", "total_pnl_pct",
        "day_pnl", "day_pnl_pct", "holdings_count", "winners", "losers"
      ],
      "properties": {
        "total_invested": {"type": "number"},
        "current_value": {"type": "number"},
        "total_pnl": {"type": "number"},
        "total_pnl_pct": {"type": "number"},
        "day_pnl": {"type": "number"},
        "day_pnl_pct": {"type": "number"},
        "holdings_count": {"type": "integer"},
        "winners": {"type": "integer"},
        "losers": {"type": "integer"}
      }
    }
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures/
git commit -m "test: add fixtures for normalizer (5-stock sample + schema)"
```

---

## Task 3: `normalize_holdings` — Transform Logic (TDD)

**Files:**
- Test: `tests/test_fetch_holdings.py`
- Create: `dashboard/__init__.py` (empty)
- Create: `dashboard/fetch_holdings.py`

- [ ] **Step 1: Write failing test for `normalize_holdings`**

Create `tests/test_fetch_holdings.py`:

```python
import json
from pathlib import Path
import pytest
from jsonschema import validate

FIXTURES = Path(__file__).parent / "fixtures"


def load_fixture(name: str):
    return json.loads((FIXTURES / name).read_text())


def test_normalize_holdings_matches_expected():
    from dashboard.fetch_holdings import normalize_holdings

    raw = load_fixture("kite_holdings_response.json")
    expected = load_fixture("holdings_normalized.json")

    result = normalize_holdings(raw, now="2026-06-11T00:00:00+00:00")

    assert result["fetched_at"] == expected["fetched_at"]
    assert len(result["holdings"]) == len(expected["holdings"])

    for got, want in zip(result["holdings"], expected["holdings"]):
        assert got["symbol"] == want["symbol"]
        assert got["exchange"] == want["exchange"]
        assert got["qty"] == want["qty"]
        assert got["invested"] == pytest.approx(want["invested"], abs=0.05)
        assert got["current_value"] == pytest.approx(want["current_value"], abs=0.05)
        assert got["pnl_pct"] == pytest.approx(want["pnl_pct"], abs=0.05)
        assert got["weight_pct"] == pytest.approx(want["weight_pct"], abs=0.05)

    s = result["summary"]
    e = expected["summary"]
    assert s["holdings_count"] == e["holdings_count"]
    assert s["winners"] == e["winners"]
    assert s["losers"] == e["losers"]
    assert s["total_invested"] == pytest.approx(e["total_invested"], abs=0.05)
    assert s["current_value"] == pytest.approx(e["current_value"], abs=0.05)
    assert s["total_pnl"] == pytest.approx(e["total_pnl"], abs=0.05)
    assert s["total_pnl_pct"] == pytest.approx(e["total_pnl_pct"], abs=0.05)


def test_normalize_holdings_empty():
    from dashboard.fetch_holdings import normalize_holdings

    result = normalize_holdings([], now="2026-06-11T00:00:00+00:00")

    assert result["holdings"] == []
    assert result["summary"]["holdings_count"] == 0
    assert result["summary"]["winners"] == 0
    assert result["summary"]["losers"] == 0
    assert result["summary"]["total_invested"] == 0
    assert result["summary"]["current_value"] == 0
    assert result["summary"]["total_pnl"] == 0
    assert result["summary"]["total_pnl_pct"] == 0
    assert result["summary"]["day_pnl"] == 0
    assert result["summary"]["day_pnl_pct"] == 0


def test_normalize_holdings_schema_valid():
    from dashboard.fetch_holdings import normalize_holdings

    raw = load_fixture("kite_holdings_response.json")
    schema = load_fixture("holdings_schema.json")

    result = normalize_holdings(raw, now="2026-06-11T00:00:00+00:00")

    validate(instance=result, schema=schema)


def test_normalize_holdings_empty_schema_valid():
    from dashboard.fetch_holdings import normalize_holdings

    schema = load_fixture("holdings_schema.json")

    result = normalize_holdings([], now="2026-06-11T00:00:00+00:00")

    validate(instance=result, schema=schema)
```

- [ ] **Step 2: Create empty `dashboard/__init__.py`** so `dashboard.*` imports work.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /Users/ashunsah/Desktop/Stocks && source .venv/bin/activate && pytest tests/test_fetch_holdings.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'dashboard.fetch_holdings'`.

- [ ] **Step 4: Implement `normalize_holdings`**

Create `dashboard/fetch_holdings.py`:

```python
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pytest tests/test_fetch_holdings.py::test_normalize_holdings_matches_expected tests/test_fetch_holdings.py::test_normalize_holdings_empty tests/test_fetch_holdings.py::test_normalize_holdings_schema_valid tests/test_fetch_holdings.py::test_normalize_holdings_empty_schema_valid -v`
Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add dashboard/__init__.py dashboard/fetch_holdings.py tests/test_fetch_holdings.py
git commit -m "feat: normalize_holdings transform with schema validation"
```

---

## Task 4: `atomic_write_json` — Crash-Safe Writes (TDD)

**Files:**
- Test: `tests/test_fetch_holdings.py` (append)

- [ ] **Step 1: Append test for atomic write**

Add to `tests/test_fetch_holdings.py`:

```python
def test_atomic_write_creates_file(tmp_path):
    from dashboard.fetch_holdings import atomic_write_json

    target = tmp_path / "out.json"
    atomic_write_json(str(target), {"a": 1})

    assert target.exists()
    assert json.loads(target.read_text()) == {"a": 1}


def test_atomic_write_replaces_existing(tmp_path):
    from dashboard.fetch_holdings import atomic_write_json

    target = tmp_path / "out.json"
    target.write_text('{"old": true}')

    atomic_write_json(str(target), {"new": True})

    assert json.loads(target.read_text()) == {"new": True}


def test_atomic_write_failure_leaves_original(tmp_path, monkeypatch):
    from dashboard import fetch_holdings

    target = tmp_path / "out.json"
    target.write_text('{"old": true}')

    def boom(*a, **kw):
        raise RuntimeError("disk full")

    monkeypatch.setattr(fetch_holdings.os, "replace", boom)

    with pytest.raises(RuntimeError):
        fetch_holdings.atomic_write_json(str(target), {"new": True})

    assert json.loads(target.read_text()) == {"old": True}
    leftover_tmps = list(tmp_path.glob(".holdings-*.tmp"))
    assert leftover_tmps == []
```

- [ ] **Step 2: Run tests**

Run: `pytest tests/test_fetch_holdings.py -v`
Expected: 7 passed (4 prior + 3 new). Implementation already exists from Task 3.

- [ ] **Step 3: Commit**

```bash
git add tests/test_fetch_holdings.py
git commit -m "test: cover atomic_write_json crash-safety"
```

---

## Task 5: `find_free_port` and `is_stale` Helpers (TDD)

**Files:**
- Test: `tests/test_launch.py`
- Create: `dashboard/launch.py`

- [ ] **Step 1: Write failing tests**

Create `tests/test_launch.py`:

```python
import socket
from datetime import datetime, timedelta, timezone

import pytest


def test_find_free_port_returns_port_in_range():
    from dashboard.launch import find_free_port

    p = find_free_port(8501, 8510)
    assert 8501 <= p <= 8510


def test_find_free_port_skips_occupied():
    from dashboard.launch import find_free_port

    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    occupied_port = s.getsockname()[1]
    try:
        result = find_free_port(occupied_port, occupied_port + 5)
        assert result != occupied_port
        assert occupied_port < result <= occupied_port + 5
    finally:
        s.close()


def test_find_free_port_raises_when_all_busy():
    from dashboard.launch import find_free_port

    sockets = []
    try:
        base = 0
        # Bind 3 ephemeral ports and then claim them as our scan range.
        for _ in range(3):
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.bind(("127.0.0.1", 0))
            s.listen(1)
            sockets.append(s)
        ports = sorted(s.getsockname()[1] for s in sockets)
        if ports != list(range(ports[0], ports[0] + 3)):
            pytest.skip("non-contiguous ephemeral ports allocated")
        with pytest.raises(RuntimeError, match="no free port"):
            find_free_port(ports[0], ports[-1])
    finally:
        for s in sockets:
            s.close()


def test_is_stale_true_when_old():
    from dashboard.launch import is_stale

    six_min_ago = (datetime.now(timezone.utc) - timedelta(minutes=6)).isoformat()
    assert is_stale(six_min_ago, threshold_seconds=300) is True


def test_is_stale_false_when_fresh():
    from dashboard.launch import is_stale

    one_min_ago = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
    assert is_stale(one_min_ago, threshold_seconds=300) is False


def test_is_stale_handles_missing():
    from dashboard.launch import is_stale

    assert is_stale(None, threshold_seconds=300) is True
    assert is_stale("", threshold_seconds=300) is True
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_launch.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'dashboard.launch'`.

- [ ] **Step 3: Implement helpers**

Create `dashboard/launch.py`:

```python
"""Background launcher and helpers for the Streamlit dashboard."""
from __future__ import annotations
import socket
import subprocess
import sys
import time
import webbrowser
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
APP_PATH = REPO_ROOT / "dashboard" / "app.py"
PID_FILE = REPO_ROOT / ".streamlit.pid"
PORT_FILE = REPO_ROOT / ".streamlit.port"


def find_free_port(start: int, end: int) -> int:
    for port in range(start, end + 1):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"no free port in range {start}-{end}")


def is_stale(fetched_at: str | None, *, threshold_seconds: int) -> bool:
    if not fetched_at:
        return True
    try:
        ts = datetime.fromisoformat(fetched_at)
    except ValueError:
        return True
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    age = (datetime.now(timezone.utc) - ts).total_seconds()
    return age > threshold_seconds


def launch_streamlit(port: int) -> int:
    if not APP_PATH.exists():
        raise FileNotFoundError(f"Streamlit app not found at {APP_PATH}")

    proc = subprocess.Popen(
        [
            sys.executable, "-m", "streamlit", "run", str(APP_PATH),
            "--server.port", str(port),
            "--server.headless", "true",
            "--browser.gatherUsageStats", "false",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    PID_FILE.write_text(str(proc.pid))
    PORT_FILE.write_text(str(port))
    return proc.pid


def main() -> int:
    try:
        port = find_free_port(8501, 8510)
    except RuntimeError as e:
        print(f"ERROR: {e}. Run `pkill -f streamlit` to free ports.", file=sys.stderr)
        return 1

    try:
        pid = launch_streamlit(port)
    except FileNotFoundError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1

    time.sleep(2)
    url = f"http://localhost:{port}"
    webbrowser.open(url)
    print(f"Dashboard running at {url} (PID {pid})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_launch.py -v`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add dashboard/launch.py tests/test_launch.py
git commit -m "feat: launch helpers (find_free_port, is_stale, launch_streamlit)"
```

---

## Task 6: Streamlit Dashboard (`app.py`)

**Files:**
- Create: `dashboard/app.py`
- Test: `tests/test_app.py`

- [ ] **Step 1: Write failing smoke tests**

Create `tests/test_app.py`:

```python
import json
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"


@pytest.fixture
def sample_holdings(tmp_path, monkeypatch):
    fixtures = Path(__file__).parent / "fixtures"
    expected = json.loads((fixtures / "holdings_normalized.json").read_text())

    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / "holdings.json").write_text(json.dumps(expected))
    (data_dir / "insights.md").write_text("# Insights\n\nSample insights.")

    monkeypatch.setenv("PORTFOLIO_DATA_DIR", str(data_dir))
    return data_dir


def test_app_renders_with_holdings(sample_holdings):
    from streamlit.testing.v1 import AppTest

    at = AppTest.from_file(str(REPO_ROOT / "dashboard" / "app.py"))
    at.run(timeout=15)

    assert not at.exception
    metric_labels = {m.label for m in at.metric}
    assert "Current Value" in metric_labels
    assert "Total Invested" in metric_labels
    assert "Total P&L" in metric_labels


def test_app_renders_empty_state(tmp_path, monkeypatch):
    from streamlit.testing.v1 import AppTest

    data_dir = tmp_path / "data"
    data_dir.mkdir()
    monkeypatch.setenv("PORTFOLIO_DATA_DIR", str(data_dir))

    at = AppTest.from_file(str(REPO_ROOT / "dashboard" / "app.py"))
    at.run(timeout=15)

    assert not at.exception
    body = " ".join(m.value for m in at.markdown)
    assert "Run `/portfolio`" in body
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_app.py -v`
Expected: FAIL with `FileNotFoundError` (no `dashboard/app.py`) or `AppTest` import errors.

- [ ] **Step 3: Create `dashboard/app.py`**

```python
"""Streamlit dashboard for Zerodha Kite holdings.

Reads data/holdings.json and data/insights.md (paths configurable via
PORTFOLIO_DATA_DIR env var for testability). No Kite calls — refresh
re-reads files only.
"""
from __future__ import annotations
import json
import os
from pathlib import Path

import pandas as pd
import plotly.express as px
import streamlit as st

from dashboard.launch import is_stale

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("PORTFOLIO_DATA_DIR", REPO_ROOT / "data"))
HOLDINGS_PATH = DATA_DIR / "holdings.json"
INSIGHTS_PATH = DATA_DIR / "insights.md"
STALE_SECONDS = 300


def load_holdings() -> dict | None:
    if not HOLDINGS_PATH.exists():
        return None
    try:
        return json.loads(HOLDINGS_PATH.read_text())
    except json.JSONDecodeError:
        return None


def load_insights() -> str | None:
    if not INSIGHTS_PATH.exists():
        return None
    return INSIGHTS_PATH.read_text()


def render_empty_state() -> None:
    st.title("Portfolio Dashboard")
    st.info("No holdings data found. Run `/portfolio` in Claude Code to fetch your holdings.")


def render_kpis(summary: dict) -> None:
    c1, c2, c3, c4, c5 = st.columns(5)
    c1.metric("Current Value", f"₹{summary['current_value']:,.0f}")
    c2.metric("Total Invested", f"₹{summary['total_invested']:,.0f}")
    c3.metric(
        "Total P&L",
        f"₹{summary['total_pnl']:,.0f}",
        f"{summary['total_pnl_pct']:.2f}%",
    )
    c4.metric(
        "Day P&L",
        f"₹{summary['day_pnl']:,.0f}",
        f"{summary['day_pnl_pct']:.2f}%",
    )
    c5.metric(
        "Holdings",
        f"{summary['holdings_count']}",
        f"{summary['winners']}W / {summary['losers']}L",
    )


def render_insights(insights: str | None) -> None:
    st.subheader("AI Insights")
    if insights:
        st.markdown(insights)
    else:
        st.caption("No insights generated yet. Run `/portfolio` to produce them.")


def render_holdings_table(holdings: list[dict]) -> None:
    st.subheader("Holdings")
    df = pd.DataFrame(holdings)
    cols = [
        "symbol", "exchange", "qty", "avg_price", "ltp",
        "invested", "current_value", "day_change_pct",
        "pnl", "pnl_pct", "weight_pct",
    ]
    df = df[cols]
    st.dataframe(
        df.style.format({
            "avg_price": "{:,.2f}",
            "ltp": "{:,.2f}",
            "invested": "₹{:,.0f}",
            "current_value": "₹{:,.0f}",
            "day_change_pct": "{:+.2f}%",
            "pnl": "₹{:,.0f}",
            "pnl_pct": "{:+.2f}%",
            "weight_pct": "{:.2f}%",
        }).map(
            lambda v: "color: green" if isinstance(v, (int, float)) and v > 0
            else ("color: red" if isinstance(v, (int, float)) and v < 0 else ""),
            subset=["pnl", "pnl_pct", "day_change_pct"],
        ),
        use_container_width=True,
        hide_index=True,
    )


def render_allocation(holdings: list[dict]) -> None:
    st.subheader("Allocation by Holding")
    df = pd.DataFrame(holdings)
    fig = px.treemap(
        df,
        path=["symbol"],
        values="current_value",
        color="pnl_pct",
        color_continuous_scale="RdYlGn",
        color_continuous_midpoint=0,
    )
    fig.update_layout(margin=dict(t=10, l=10, r=10, b=10), height=400)
    st.plotly_chart(fig, use_container_width=True)


def render_winners_losers(holdings: list[dict]) -> None:
    df = pd.DataFrame(holdings)
    winners = df.nlargest(5, "pnl")[["symbol", "pnl", "pnl_pct"]]
    losers = df.nsmallest(5, "pnl")[["symbol", "pnl", "pnl_pct"]]
    c1, c2 = st.columns(2)
    with c1:
        st.subheader("Top 5 Winners")
        st.dataframe(winners, hide_index=True, use_container_width=True)
    with c2:
        st.subheader("Top 5 Losers")
        st.dataframe(losers, hide_index=True, use_container_width=True)


def render_concentration(holdings: list[dict]) -> None:
    df = pd.DataFrame(holdings).sort_values("weight_pct", ascending=False)
    top3_share = df.head(3)["weight_pct"].sum()
    st.subheader("Concentration Risk")
    if top3_share > 40:
        st.warning(
            f"Top 3 holdings make up {top3_share:.1f}% of your portfolio "
            f"({', '.join(df.head(3)['symbol'].tolist())}). Consider diversifying."
        )
    else:
        st.success(f"Top 3 holdings: {top3_share:.1f}% — healthy diversification.")


def render_footer(fetched_at: str) -> None:
    st.caption(f"Last fetched: {fetched_at}")


def render_staleness_banner(fetched_at: str) -> None:
    if is_stale(fetched_at, threshold_seconds=STALE_SECONDS):
        st.warning(
            "Data is more than 5 minutes old. Run `/portfolio refresh` in Claude to update."
        )


def main() -> None:
    st.set_page_config(page_title="Portfolio Dashboard", layout="wide")

    data = load_holdings()
    if data is None:
        render_empty_state()
        return

    if st.button("Refresh"):
        st.rerun()

    render_staleness_banner(data["fetched_at"])

    if not data["holdings"]:
        st.title("Portfolio Dashboard")
        st.info("Your portfolio is currently empty.")
        render_footer(data["fetched_at"])
        return

    st.title("Portfolio Dashboard")
    render_kpis(data["summary"])
    render_insights(load_insights())
    render_holdings_table(data["holdings"])
    render_allocation(data["holdings"])
    render_winners_losers(data["holdings"])
    render_concentration(data["holdings"])
    render_footer(data["fetched_at"])


main()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_app.py -v`
Expected: 2 passed.

- [ ] **Step 5: Manual smoke check**

Run:
```bash
mkdir -p data
cp tests/fixtures/holdings_normalized.json data/holdings.json
echo "# Insights\n\nManual smoke test." > data/insights.md
streamlit run dashboard/app.py --server.headless true --server.port 8501
```
Open `http://localhost:8501`. Verify: KPIs show, table renders, treemap appears, winners/losers panels populated. Stop with Ctrl+C. Remove `data/` (covered by `.gitignore`) before committing.

- [ ] **Step 6: Commit**

```bash
rm -rf data/
git add dashboard/app.py tests/test_app.py
git commit -m "feat: streamlit dashboard with KPIs, table, treemap, insights"
```

---

## Task 7: `fetch-holdings` Skill

**Files:**
- Create: `.claude/skills/fetch-holdings/SKILL.md`

- [ ] **Step 1: Create the skill file**

```markdown
---
name: fetch-holdings
description: Fetch the user's Zerodha Kite holdings via MCP, normalize them, and write data/holdings.json. Use whenever the user asks to refresh, view, or analyze their portfolio.
---

# fetch-holdings

Pull the user's current holdings from the Kite MCP server, transform them with the project normalizer, and write the canonical `data/holdings.json` that all downstream skills read.

## When to use

- The user runs `/portfolio` (orchestrated by `portfolio-agent`)
- The user runs `/portfolio refresh`
- Any other skill needs fresh holdings data

## Steps

1. Call `mcp__kite__get_holdings` (no parameters).
2. If the tool returns a "Please log in" error, call `mcp__kite__login`, return the login URL to the user as a clickable markdown link, and STOP. Do not proceed.
3. If the call returns an array (possibly empty), continue.
4. From the project root (`/Users/ashunsah/Desktop/Stocks`), run:

   ```bash
   python -c "
   import json, sys
   from datetime import datetime, timezone
   from dashboard.fetch_holdings import normalize_holdings, atomic_write_json
   raw = json.load(sys.stdin)
   now = datetime.now(timezone.utc).isoformat()
   atomic_write_json('data/holdings.json', normalize_holdings(raw, now=now))
   print('wrote data/holdings.json with', len(raw), 'holdings')
   " <<'EOF'
   <PASTE THE RAW MCP JSON ARRAY HERE>
   EOF
   ```

5. Verify `data/holdings.json` exists and is valid JSON.
6. Report: "Fetched N holdings, total value ₹X, day P&L ₹Y" (read from the summary).

## Failure modes

- **Auth required:** halt with login URL.
- **MCP timeout:** retry once after 2 seconds. On second failure, surface the error and leave any existing `data/holdings.json` untouched.
- **Empty holdings:** still write a valid file (empty array, zeroed summary). Report "no holdings found" and continue.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/fetch-holdings/SKILL.md
git commit -m "feat: fetch-holdings skill"
```

---

## Task 8: `generate-insights` Skill

**Files:**
- Create: `.claude/skills/generate-insights/SKILL.md`

- [ ] **Step 1: Create the skill file**

```markdown
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
4. Atomic write to `data/insights.md` (write to `.tmp`, then rename).
5. Report: "Wrote insights (X words)."

## Style

- Indian markets, Indian rupees (₹).
- Plain markdown — headers (`##`), bold for emphasis. No tables (the dashboard renders them separately).
- Be specific: name stocks, give numbers. Avoid generic advice ("consider diversifying" only when concentration > 40%).
- No financial advice. Observations only.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/generate-insights/SKILL.md
git commit -m "feat: generate-insights skill"
```

---

## Task 9: `launch-dashboard` Skill

**Files:**
- Create: `.claude/skills/launch-dashboard/SKILL.md`

- [ ] **Step 1: Create the skill file**

```markdown
---
name: launch-dashboard
description: Launch the Streamlit portfolio dashboard in the background and open the browser. Use after fetch-holdings + generate-insights have produced data files.
---

# launch-dashboard

Spawn the Streamlit dashboard as a detached process and open it in the user's default browser.

## When to use

After `fetch-holdings` and `generate-insights` have written `data/holdings.json` and `data/insights.md`.

## Steps

1. From the project root (`/Users/ashunsah/Desktop/Stocks`), check if a Streamlit process is already running:
   - If `.streamlit.pid` exists and the process is alive (`kill -0 <pid>` returns 0), tell the user the dashboard is already running at `http://localhost:<port-from-.streamlit.port>` and stop.
2. Otherwise run: `python -m dashboard.launch`
3. Capture the printed URL and PID, report them to the user.

## Failure modes

- **All ports 8501–8510 busy:** report the error and tell the user to run `pkill -f streamlit` or pick a free port range.
- **Streamlit not installed:** tell the user to run `pip install -r dashboard/requirements.txt` from the project root.
- **dashboard/app.py missing:** report which file is missing.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/launch-dashboard/SKILL.md
git commit -m "feat: launch-dashboard skill"
```

---

## Task 10: `portfolio-agent` and `/portfolio` Slash Command

**Files:**
- Create: `.claude/agents/portfolio-agent.md`
- Create: `.claude/commands/portfolio.md`

- [ ] **Step 1: Create `.claude/agents/portfolio-agent.md`**

```markdown
---
name: portfolio-agent
description: Manages a user's Zerodha Kite portfolio. Orchestrates fetch-holdings, generate-insights, and launch-dashboard skills, and answers ad-hoc portfolio questions.
tools:
  - Read
  - Write
  - Bash
  - Skill
  - mcp__kite__get_holdings
  - mcp__kite__get_positions
  - mcp__kite__get_quotes
  - mcp__kite__get_ltp
  - mcp__kite__get_ohlc
  - mcp__kite__get_historical_data
  - mcp__kite__get_profile
  - mcp__kite__get_margins
  - mcp__kite__get_orders
  - mcp__kite__get_trades
  - mcp__kite__get_order_history
  - mcp__kite__get_order_trades
  - mcp__kite__get_gtts
  - mcp__kite__get_mf_holdings
  - mcp__kite__login
  - mcp__kite__search_instruments
---

You manage a user's Zerodha Kite portfolio. Your operating principles:

1. **On `/portfolio` or `/portfolio refresh`:** invoke skills in order — `fetch-holdings` → `generate-insights` → `launch-dashboard`. Report the dashboard URL when done.
2. **On follow-up questions:** read `data/holdings.json` first, then call Kite MCP for live quotes if the question requires current prices.
3. **Read-only by default.** You have access to order tools (`mcp__kite__place_order`, `mcp__kite__modify_order`, `mcp__kite__cancel_order`, `mcp__kite__place_gtt_order`, `mcp__kite__modify_gtt_order`, `mcp__kite__delete_gtt_order`) but they are NOT in your tool list. If the user asks you to place, modify, or cancel an order, refuse and tell them to do it themselves in the Kite app — explicit confirmation is required and live trading via AI is out of scope for v1.
4. **Never give financial advice.** State observations ("AURIONPRO is down 54% from your average price") not recommendations ("you should sell AURIONPRO").
5. **Cite numbers.** Always reference specific values from `data/holdings.json` when answering.

The dashboard runs at the URL reported by `launch-dashboard`. The user can keep it open while chatting with you.
```

- [ ] **Step 2: Create `.claude/commands/portfolio.md`**

```markdown
---
description: Fetch the latest Zerodha holdings, generate AI insights, and launch the local dashboard.
argument-hint: [refresh]
---

Use the `portfolio-agent` to run the orchestration:

1. Invoke the `fetch-holdings` skill.
2. Invoke the `generate-insights` skill.
3. Invoke the `launch-dashboard` skill.
4. Report the dashboard URL to the user.

If the argument is `refresh`, perform the same chain (it overwrites the data files).

If the user is not logged in to Kite, surface the login URL from `mcp__kite__login` and stop.
```

- [ ] **Step 3: Commit**

```bash
git add .claude/agents/portfolio-agent.md .claude/commands/portfolio.md
git commit -m "feat: portfolio-agent and /portfolio slash command"
```

---

## Task 11: End-to-End Manual Verification

- [ ] **Step 1: Restart Claude Code session** so it picks up the new skills, agent, and command.

- [ ] **Step 2: Run `/portfolio` in Claude Code**

Expected:
- If logged in: agent runs all 3 skills, browser opens at `http://localhost:8501`, dashboard shows real holdings.
- If not logged in: agent prints a Kite login URL. User logs in, runs `/portfolio` again.

- [ ] **Step 3: Verify dashboard sections**

In the browser:
- KPIs row populated with real numbers
- Insights panel shows generated markdown
- Holdings table sortable, color-coded
- Allocation treemap rendered
- Winners/losers panels populated
- Concentration callout present (warning or success)
- Footer shows `fetched_at` timestamp

- [ ] **Step 4: Verify staleness banner**

Wait 6 minutes, click the dashboard's "Refresh" button. Expected: yellow banner appears saying data is stale and to run `/portfolio refresh`.

- [ ] **Step 5: Run `/portfolio refresh`**

Expected: holdings re-fetched, dashboard auto-reloads (Streamlit detects file changes).

- [ ] **Step 6: Run all unit tests one final time**

Run: `cd /Users/ashunsah/Desktop/Stocks && source .venv/bin/activate && pytest tests/ -v`
Expected: all tests pass.

- [ ] **Step 7: Final commit (if anything was tweaked)**

```bash
git status
# If clean, nothing to commit
# If files changed during smoke testing, commit them with a "fix:" or "chore:" message
```

---

## Self-Review Checklist (already run)

- **Spec coverage:** every spec section maps to at least one task — fetch (Task 7), insights (Task 8), launch (Task 9), agent (Task 10), dashboard sections (Task 6), error handling (woven through Tasks 3, 5, 6, 7, 9), atomic writes (Tasks 3, 4), staleness banner (Tasks 5, 6), tests (Tasks 3, 4, 5, 6).
- **Placeholders:** none — every code block contains the actual implementation.
- **Type consistency:** `normalize_holdings`, `atomic_write_json`, `find_free_port`, `is_stale`, `launch_streamlit` are referenced consistently across tasks. JSON keys match between fixtures, schema, and consumer code.
