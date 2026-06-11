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
