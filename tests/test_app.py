import json
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent


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
    body = " ".join(i.value for i in at.info)
    assert "Run `/portfolio`" in body
