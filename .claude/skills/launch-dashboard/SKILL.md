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
2. Otherwise run: `.venv/bin/python -m dashboard.launch`
3. Capture the printed URL and PID, report them to the user.

## Failure modes

- **All ports 8501–8510 busy:** report the error and tell the user to run `pkill -f streamlit` or pick a free port range.
- **Streamlit not installed:** tell the user to run `.venv/bin/pip install -r dashboard/requirements.txt` from the project root.
- **dashboard/app.py missing:** report which file is missing.
