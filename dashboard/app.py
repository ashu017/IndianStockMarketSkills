"""Streamlit dashboard for Zerodha Kite holdings — Vercel/Apple Card style.

Reads data/holdings.json and data/insights.md (paths configurable via
PORTFOLIO_DATA_DIR env var for testability). No Kite calls — refresh
re-reads files only.
"""
from __future__ import annotations
import json
import os
import sys
from pathlib import Path

import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
import streamlit as st

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from dashboard.launch import is_stale  # noqa: E402

DATA_DIR = Path(os.environ.get("PORTFOLIO_DATA_DIR", REPO_ROOT / "data"))
HOLDINGS_PATH = DATA_DIR / "holdings.json"
INSIGHTS_PATH = DATA_DIR / "insights.md"
STALE_SECONDS = 300

ACCENT = "#7C5CFF"
POSITIVE = "#4ADE80"
NEGATIVE = "#FB7185"
SURFACE = "#111114"
SURFACE_2 = "#16161A"
BORDER = "rgba(255,255,255,0.08)"
TEXT = "#EDEDED"
TEXT_MUTED = "#9A9AA0"

CSS = f"""
<style>
  /* App-wide */
  .stApp {{
    background:
      radial-gradient(1200px 600px at 0% -10%, rgba(124,92,255,0.10), transparent 60%),
      radial-gradient(900px 500px at 100% 0%, rgba(74,222,128,0.06), transparent 60%),
      #0A0A0B;
  }}
  section.main > div {{ padding-top: 1.5rem; }}

  /* Hide Streamlit chrome */
  #MainMenu, footer, header {{ visibility: hidden; }}

  /* Typography */
  html, body, [class*="css"] {{
    font-family: -apple-system, BlinkMacSystemFont, "Inter", "SF Pro Display",
                 "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    letter-spacing: -0.01em;
  }}
  h1, h2, h3, h4 {{ letter-spacing: -0.02em; }}
  h1 {{ font-weight: 700; }}

  /* Card surfaces */
  div[data-testid="stMetric"] {{
    background: linear-gradient(180deg, {SURFACE} 0%, {SURFACE_2} 100%);
    border: 1px solid {BORDER};
    border-radius: 16px;
    padding: 18px 20px;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 24px rgba(0,0,0,0.25);
    transition: transform 120ms ease, border-color 120ms ease;
  }}
  div[data-testid="stMetric"]:hover {{
    border-color: rgba(255,255,255,0.14);
    transform: translateY(-1px);
  }}
  div[data-testid="stMetricLabel"] p {{
    color: {TEXT_MUTED} !important;
    font-size: 0.78rem !important;
    font-weight: 500 !important;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }}
  div[data-testid="stMetricValue"] {{
    font-size: 1.7rem !important;
    font-weight: 700 !important;
    font-variant-numeric: tabular-nums;
    color: {TEXT};
  }}
  div[data-testid="stMetricDelta"] {{
    font-size: 0.85rem !important;
    font-weight: 500 !important;
    font-variant-numeric: tabular-nums;
  }}

  /* Headline accent: first metric gets gradient */
  div[data-testid="stMetric"]:first-child div[data-testid="stMetricValue"] {{
    background: linear-gradient(135deg, #FFFFFF 0%, {ACCENT} 90%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }}

  /* Section headings */
  h2, h3 {{
    color: {TEXT};
    margin-top: 2.2rem !important;
    margin-bottom: 0.8rem !important;
  }}
  div[data-testid="stMarkdownContainer"] h3 {{
    font-size: 1.05rem;
    font-weight: 600;
    color: {TEXT};
    text-transform: none;
    letter-spacing: -0.01em;
  }}

  /* Insights card */
  .insights-card {{
    background: linear-gradient(180deg, {SURFACE} 0%, {SURFACE_2} 100%);
    border: 1px solid {BORDER};
    border-radius: 16px;
    padding: 22px 26px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.25);
  }}
  .insights-card h2 {{
    font-size: 1rem !important;
    font-weight: 600 !important;
    color: {TEXT_MUTED} !important;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin: 14px 0 6px 0 !important;
  }}
  .insights-card h2:first-child {{ margin-top: 0 !important; }}
  .insights-card p {{
    color: {TEXT};
    line-height: 1.65;
    font-size: 0.95rem;
  }}
  .insights-card strong {{ color: #FFFFFF; }}

  /* Dataframes */
  div[data-testid="stDataFrame"] {{
    background: linear-gradient(180deg, {SURFACE} 0%, {SURFACE_2} 100%);
    border: 1px solid {BORDER};
    border-radius: 16px;
    padding: 8px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.25);
  }}

  /* Buttons */
  div[data-testid="stButton"] > button {{
    background: {SURFACE};
    border: 1px solid {BORDER};
    border-radius: 10px;
    color: {TEXT};
    font-weight: 500;
    padding: 8px 16px;
    transition: all 120ms ease;
  }}
  div[data-testid="stButton"] > button:hover {{
    background: {SURFACE_2};
    border-color: {ACCENT};
    color: {TEXT};
  }}

  /* Alert tweaks */
  div[data-testid="stAlert"] {{
    border-radius: 12px;
    border: 1px solid {BORDER};
  }}

  /* Plotly chart card */
  div[data-testid="stPlotlyChart"] {{
    background: linear-gradient(180deg, {SURFACE} 0%, {SURFACE_2} 100%);
    border: 1px solid {BORDER};
    border-radius: 16px;
    padding: 12px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.25);
  }}

  /* Caption */
  div[data-testid="stCaptionContainer"] {{
    color: {TEXT_MUTED};
    font-size: 0.8rem;
  }}

  /* Hero block */
  .hero {{
    margin: 0.4rem 0 1.6rem 0;
  }}
  .hero h1 {{
    font-size: 2.2rem !important;
    margin: 0 !important;
    background: linear-gradient(135deg, #FFFFFF 0%, {ACCENT} 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }}
  .hero p {{
    color: {TEXT_MUTED};
    margin: 4px 0 0 0;
    font-size: 0.95rem;
  }}
</style>
"""

PLOTLY_TEMPLATE = go.layout.Template(
    layout=go.Layout(
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
        font=dict(family="Inter, -apple-system, sans-serif", color=TEXT, size=12),
        colorway=[ACCENT, POSITIVE, NEGATIVE, "#60A5FA", "#FBBF24"],
        margin=dict(t=10, l=10, r=10, b=10),
    )
)


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
    st.markdown('<div class="hero"><h1>Portfolio</h1><p>Local dashboard · Zerodha Kite</p></div>', unsafe_allow_html=True)
    st.info("No holdings data found. Run `/portfolio` in Claude Code to fetch your holdings.")


def render_hero(summary: dict, fetched_at: str) -> None:
    pnl = summary["total_pnl"]
    pnl_pct = summary["total_pnl_pct"]
    arrow = "▲" if pnl >= 0 else "▼"
    st.markdown(
        f"""
        <div class="hero">
          <h1>Portfolio</h1>
          <p>{summary['holdings_count']} holdings · {arrow} ₹{abs(pnl):,.0f} ({pnl_pct:+.2f}%) all-time · last fetched {fetched_at[:19].replace('T', ' ')}</p>
        </div>
        """,
        unsafe_allow_html=True,
    )


def render_kpis(summary: dict) -> None:
    c1, c2, c3, c4, c5 = st.columns(5)
    c1.metric("Current Value", f"₹{summary['current_value']:,.0f}")
    c2.metric("Total Invested", f"₹{summary['total_invested']:,.0f}")
    c3.metric(
        "Total P&L",
        f"₹{summary['total_pnl']:,.0f}",
        f"{summary['total_pnl_pct']:+.2f}%",
    )
    c4.metric(
        "Day P&L",
        f"₹{summary['day_pnl']:,.0f}",
        f"{summary['day_pnl_pct']:+.2f}%",
    )
    c5.metric(
        "Holdings",
        f"{summary['holdings_count']}",
        f"{summary['winners']}W / {summary['losers']}L",
    )


def render_insights(insights: str | None) -> None:
    if not insights:
        st.caption("No insights generated yet. Run `/portfolio` to produce them.")
        return
    st.markdown(f'<div class="insights-card">{insights_to_html(insights)}</div>', unsafe_allow_html=True)


def insights_to_html(md: str) -> str:
    """Lightweight markdown → HTML for the insights card.

    Streamlit's st.markdown can't be wrapped in a custom div with unsafe_allow_html
    while preserving its renderer, so we do a minimal pass for the patterns the
    insights skill produces: ## headers, **bold**, paragraphs.
    """
    import re
    html_parts = []
    for block in md.strip().split("\n\n"):
        block = block.strip()
        if not block:
            continue
        if block.startswith("## "):
            html_parts.append(f"<h2>{block[3:].strip()}</h2>")
        else:
            text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", block)
            text = text.replace("\n", " ")
            html_parts.append(f"<p>{text}</p>")
    return "".join(html_parts)


def color_pnl(v):
    if isinstance(v, (int, float)):
        if v > 0:
            return f"color: {POSITIVE}"
        if v < 0:
            return f"color: {NEGATIVE}"
    return ""


def render_holdings_table(holdings: list[dict]) -> None:
    st.markdown("### Holdings")
    df = pd.DataFrame(holdings)
    cols = [
        "symbol", "exchange", "qty", "avg_price", "ltp",
        "invested", "current_value", "day_change_pct",
        "pnl", "pnl_pct", "weight_pct",
    ]
    df = df[cols].rename(columns={
        "symbol": "Symbol",
        "exchange": "Exch",
        "qty": "Qty",
        "avg_price": "Avg",
        "ltp": "LTP",
        "invested": "Invested",
        "current_value": "Current",
        "day_change_pct": "Day %",
        "pnl": "P&L",
        "pnl_pct": "P&L %",
        "weight_pct": "Weight",
    })
    styled = df.style.format({
        "Avg": "{:,.2f}",
        "LTP": "{:,.2f}",
        "Invested": "₹{:,.0f}",
        "Current": "₹{:,.0f}",
        "Day %": "{:+.2f}%",
        "P&L": "₹{:,.0f}",
        "P&L %": "{:+.2f}%",
        "Weight": "{:.2f}%",
    }).map(color_pnl, subset=["P&L", "P&L %", "Day %"])
    st.dataframe(styled, use_container_width=True, hide_index=True, height=420)


def render_allocation(holdings: list[dict]) -> None:
    st.markdown("### Allocation")
    df = pd.DataFrame(holdings)
    fig = px.treemap(
        df,
        path=["symbol"],
        values="current_value",
        color="pnl_pct",
        color_continuous_scale=[
            [0.0, NEGATIVE],
            [0.5, "#2A2A2F"],
            [1.0, POSITIVE],
        ],
        color_continuous_midpoint=0,
        custom_data=["current_value", "pnl", "pnl_pct"],
    )
    fig.update_traces(
        textfont=dict(family="Inter, sans-serif", size=13, color="white"),
        marker=dict(line=dict(color="#0A0A0B", width=2)),
        hovertemplate="<b>%{label}</b><br>Value: ₹%{customdata[0]:,.0f}<br>P&L: ₹%{customdata[1]:,.0f} (%{customdata[2]:+.2f}%)<extra></extra>",
    )
    fig.update_layout(
        template=PLOTLY_TEMPLATE,
        height=420,
        margin=dict(t=10, l=10, r=10, b=10),
        coloraxis_colorbar=dict(
            title=dict(text="P&L %", font=dict(color=TEXT_MUTED)),
            tickfont=dict(color=TEXT_MUTED),
            outlinewidth=0,
            thickness=10,
        ),
    )
    st.plotly_chart(fig, use_container_width=True, config={"displayModeBar": False})


def render_winners_losers(holdings: list[dict]) -> None:
    df = pd.DataFrame(holdings)
    winners = df.nlargest(5, "pnl")[["symbol", "pnl", "pnl_pct"]].rename(
        columns={"symbol": "Symbol", "pnl": "P&L", "pnl_pct": "P&L %"}
    )
    losers = df.nsmallest(5, "pnl")[["symbol", "pnl", "pnl_pct"]].rename(
        columns={"symbol": "Symbol", "pnl": "P&L", "pnl_pct": "P&L %"}
    )
    fmt = {"P&L": "₹{:,.0f}", "P&L %": "{:+.2f}%"}
    c1, c2 = st.columns(2)
    with c1:
        st.markdown("### Top Winners")
        st.dataframe(
            winners.style.format(fmt).map(color_pnl, subset=["P&L", "P&L %"]),
            hide_index=True, use_container_width=True,
        )
    with c2:
        st.markdown("### Top Losers")
        st.dataframe(
            losers.style.format(fmt).map(color_pnl, subset=["P&L", "P&L %"]),
            hide_index=True, use_container_width=True,
        )


def render_concentration(holdings: list[dict]) -> None:
    df = pd.DataFrame(holdings).sort_values("weight_pct", ascending=False)
    top3_share = df.head(3)["weight_pct"].sum()
    top3_names = ", ".join(df.head(3)["symbol"].tolist())
    st.markdown("### Concentration")
    if top3_share > 40:
        st.warning(
            f"Top 3 holdings make up {top3_share:.1f}% of your portfolio "
            f"({top3_names}). Consider diversifying."
        )
    else:
        st.success(
            f"Top 3: {top3_share:.1f}% ({top3_names}) — healthy diversification."
        )


def render_footer(fetched_at: str) -> None:
    st.caption(f"Last fetched: {fetched_at}")


def render_staleness_banner(fetched_at: str) -> None:
    if is_stale(fetched_at, threshold_seconds=STALE_SECONDS):
        st.warning(
            "Data is more than 5 minutes old. Run `/portfolio refresh` in Claude to update."
        )


def main() -> None:
    st.set_page_config(
        page_title="Portfolio",
        layout="wide",
        initial_sidebar_state="collapsed",
    )
    st.markdown(CSS, unsafe_allow_html=True)

    data = load_holdings()
    if data is None:
        render_empty_state()
        return

    render_hero(data["summary"], data["fetched_at"])

    top = st.columns([1, 1, 1, 1, 1, 0.6])
    with top[5]:
        if st.button("Refresh", use_container_width=True):
            st.rerun()

    render_staleness_banner(data["fetched_at"])

    if not data["holdings"]:
        st.info("Your portfolio is currently empty.")
        render_footer(data["fetched_at"])
        return

    render_kpis(data["summary"])

    st.markdown("### Insights")
    render_insights(load_insights())

    left, right = st.columns([1.4, 1])
    with left:
        render_holdings_table(data["holdings"])
    with right:
        render_allocation(data["holdings"])

    render_winners_losers(data["holdings"])
    render_concentration(data["holdings"])
    render_footer(data["fetched_at"])


main()
