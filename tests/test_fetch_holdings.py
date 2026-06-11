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
