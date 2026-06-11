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
