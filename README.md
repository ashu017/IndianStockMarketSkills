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
