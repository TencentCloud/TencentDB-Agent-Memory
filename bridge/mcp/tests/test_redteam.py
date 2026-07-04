"""
Red-team tests --- adversarial inputs, stress, and injection.

These tests run without a real TDAI Gateway to verify the MCP server
handles malicious and malformed inputs safely.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

SERVER_PATH = Path(__file__).parent.parent / "server.py"


def _rpc(method: str, params: dict | None = None) -> dict:
    request = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
    }
    if params is not None:
        request["params"] = params
    proc = subprocess.run(
        [sys.executable, str(SERVER_PATH)],
        input=json.dumps(request),
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0, f"Server exited with {proc.returncode}: {proc.stderr}"
    return json.loads(proc.stdout)


def _raw_rpc(request_str: str) -> dict:
    proc = subprocess.run(
        [sys.executable, str(SERVER_PATH)],
        input=request_str,
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0, f"Server exited with {proc.returncode}: {proc.stderr}"
    return json.loads(proc.stdout)


# ------ Injection / malformed ------------------------------------------------------------------------------------------------


def test_extremely_long_query():
    """1M character query should not crash the server."""
    long_query = "x" * 1_000_000
    resp = _rpc("tools/call", {
        "name": "tdai_recall",
        "arguments": {"query": long_query},
    })
    # Should not crash --- may error gracefully or return empty
    assert resp is not None


def test_non_string_query():
    """Non-string query should not cause type errors."""
    resp = _rpc("tools/call", {
        "name": "tdai_recall",
        "arguments": {"query": 12345},
    })
    assert resp is not None


def test_null_query():
    resp = _rpc("tools/call", {
        "name": "tdai_recall",
        "arguments": {"query": None},
    })
    assert resp is not None


def test_missing_tool_name():
    resp = _rpc("tools/call", {
        "arguments": {},
    })
    # No 'name' in params --- should error
    assert "error" in resp or "result" in resp


def test_tool_name_is_not_string():
    resp = _rpc("tools/call", {
        "name": 42,
        "arguments": {},
    })
    assert resp is not None


def test_empty_arguments():
    """Empty arguments should not crash."""
    resp = _rpc("tools/call", {
        "name": "tdai_health",
        "arguments": {},
    })
    assert resp is not None
    # May error or return gracefully
    if "error" in resp:
        assert resp["error"]["code"] in (-32602, -32603)


def test_deeply_nested_params():
    """Deeply nested JSON should not cause stack overflow."""
    nested = {"a": {"b": {"c": {"d": {"e": "x"}}}}}
    resp = _rpc("tools/call", {
        "name": "tdai_recall",
        "arguments": {"query": str(nested)},
    })
    assert resp is not None


def test_unicode_injection():
    """Unicode special characters should not break JSON."""
    resp = _rpc("tools/call", {
        "name": "tdai_recall",
        "arguments": {"query": "--- espa--ol --------------\n\t\u0000"},
    })
    assert resp is not None


# ------ Stress ------------------------------------------------------------------------------------------------------------------------------------------------


def test_rapid_consecutive_calls():
    """10 rapid calls should not crash or degrade."""
    for i in range(10):
        resp = _rpc("tools/list")
        assert len(resp.get("result", {}).get("tools", [])) == 5


def test_interleaved_methods():
    """Mixed call types in sequence."""
    methods = ["tools/list", "tools/call", "tools/list", "initialize", "tools/list"]
    for m in methods:
        if m == "tools/call":
            resp = _rpc(m, {"name": "tdai_health", "arguments": {}})
        else:
            resp = _rpc(m)
        assert resp is not None


# ------ Parameter boundary ---------------------------------------------------------------------------------------------------------


def test_negative_limit():
    """Negative limit should be clamped gracefully."""
    resp = _rpc("tools/call", {
        "name": "tdai_recall",
        "arguments": {"query": "test", "limit": -1},
    })
    assert resp is not None


def test_very_large_limit():
    """Large limit should be clamped gracefully."""
    resp = _rpc("tools/call", {
        "name": "tdai_recall",
        "arguments": {"query": "test", "limit": 999999},
    })
    assert resp is not None


def test_extra_unexpected_fields():
    """Extra fields should be ignored, not crash."""
    resp = _rpc("tools/call", {
        "name": "tdai_health",
        "arguments": {},
        "_extra": {"malicious": "payload"},
    })
    assert resp is not None


# ------ Gate: rate-limit self-fallback recovery -------------------------------------------------------------------------


def test_rate_limit_self_fallback_recovery():
    """Self-fallback is fail-open; after reset the gate enforces rate limit again."""
    import bridge.mcp.server as srv

    # Save original state
    orig_threshold = srv._RATE_LIMIT_SELF_THRESHOLD
    orig_failures = srv._RATE_LIMIT_SELF_FAILURES
    orig_open_until = srv._RATE_LIMIT_SELF_OPEN_UNTIL
    orig_bucket = list(srv._rate_limit_bucket)

    try:
        srv._RATE_LIMIT_SELF_THRESHOLD = 2
        srv._RATE_LIMIT_SELF_FAILURES = 0
        srv._RATE_LIMIT_SELF_OPEN_UNTIL = 0.0
        srv._rate_limit_bucket = []

        # Fill bucket to the limit
        for _ in range(srv._RATE_LIMIT_MAX_CALLS):
            ok, msg = srv._check_rate_limit()
            assert ok, f"Unexpected rate limit: {msg}"

        # Should now be limited
        ok, _ = srv._check_rate_limit()
        assert not ok, "Rate limit should be exceeded"

        # Simulate internal errors - trigger self-fallback
        srv._RATE_LIMIT_SELF_FAILURES = srv._RATE_LIMIT_SELF_THRESHOLD
        srv._RATE_LIMIT_SELF_OPEN_UNTIL = time.time() + srv._RATE_LIMIT_SELF_DURATION

        # Fail-open: rate limit check should now pass (bypassed)
        ok, msg = srv._check_rate_limit()
        assert ok, f"Should be fail-open during self-fallback: {msg}"

        # "Recovery": self-fallback expires and state resets
        srv._RATE_LIMIT_SELF_OPEN_UNTIL = 0.0
        srv._RATE_LIMIT_SELF_FAILURES = 0
        srv._rate_limit_bucket = []

        # Normal operation resumes
        for _ in range(srv._RATE_LIMIT_MAX_CALLS):
            ok, _ = srv._check_rate_limit()
            assert ok
        ok, _ = srv._check_rate_limit()
        assert not ok, "Rate limit should be enforced after recovery"
    finally:
        srv._RATE_LIMIT_SELF_THRESHOLD = orig_threshold
        srv._RATE_LIMIT_SELF_FAILURES = orig_failures
        srv._RATE_LIMIT_SELF_OPEN_UNTIL = orig_open_until
        srv._rate_limit_bucket = orig_bucket


# ------ Gate: circuit breaker cooldown escalation ------------------------------------------------------------------------------


def test_circuit_breaker_cooldown_escalation():
    """Cooldown grows (doubles) after each open cycle."""
    import bridge.mcp.server as srv

    orig_failures = srv._circuit_failures
    orig_open_until = srv._circuit_open_until
    orig_cooldown_current = srv._CIRCUIT_COOLDOWN_CURRENT

    try:
        srv._circuit_failures = 0
        srv._circuit_open_until = 0.0
        srv._CIRCUIT_COOLDOWN_CURRENT = srv._CIRCUIT_COOLDOWN

        base = srv._CIRCUIT_COOLDOWN  # 60

        # 1st open cycle
        for _ in range(srv._CIRCUIT_THRESHOLD):
            srv._record_failure()
        assert srv._CIRCUIT_COOLDOWN_CURRENT == base * 2  # 120

        # Simulate half-open recovery
        srv._circuit_open_until = 0.0
        srv._record_success()  # resets cooldown to base

        assert srv._CIRCUIT_COOLDOWN_CURRENT == base

        # 2nd open cycle (doubles from base again)
        for _ in range(srv._CIRCUIT_THRESHOLD):
            srv._record_failure()
        assert srv._CIRCUIT_COOLDOWN_CURRENT == base * 2  # 120

    finally:
        srv._circuit_failures = orig_failures
        srv._circuit_open_until = orig_open_until
        srv._CIRCUIT_COOLDOWN_CURRENT = orig_cooldown_current


# ------ Gate: audit ring buffer overflow ------------------------------------------------------------------------------


def test_audit_ring_buffer_overflow():
    """Extreme number of audit calls does not crash the ring buffer."""
    import bridge.mcp.server as srv

    orig_size = srv._AUDIT_LOG_MAX_SIZE
    orig_queue = list(srv._audit_log_queue)
    orig_rate = srv._AUDIT_SAMPLE_RATE

    try:
        srv._AUDIT_LOG_MAX_SIZE = 5
        srv._audit_log_queue = []
        srv._AUDIT_SAMPLE_RATE = 1.0

        for i in range(200):
            srv._audit_log("ALLOWED", "test", f"tool_{i}", f"detail_{i}")

        # Queue should never exceed max size
        assert len(srv._audit_log_queue) == 5

    finally:
        srv._AUDIT_LOG_MAX_SIZE = orig_size
        srv._audit_log_queue = orig_queue
        srv._AUDIT_SAMPLE_RATE = orig_rate


# ------ Gate: audit sampling boundaries -------------------------------------------------------------------------------


def test_audit_sampling_does_not_crash():
    """Extreme sample rates (0.0, 1.0) do not crash audit logging."""
    import bridge.mcp.server as srv

    orig_rate = srv._AUDIT_SAMPLE_RATE
    orig_queue = list(srv._audit_log_queue)

    try:
        srv._audit_log_queue = []

        # sample_rate = 0.0 - should skip everything
        srv._AUDIT_SAMPLE_RATE = 0.0
        for i in range(20):
            srv._audit_log("ALLOWED", "test", f"tool_{i}")
        # At most 1 random fluke (random() returning exactly 0.0)
        assert len(srv._audit_log_queue) <= 1

        # sample_rate = 1.0 - should keep everything
        srv._AUDIT_SAMPLE_RATE = 1.0
        for i in range(20):
            srv._audit_log("ALLOWED", "test", f"tool_{i}")
        assert len(srv._audit_log_queue) == 20

    finally:
        srv._AUDIT_SAMPLE_RATE = orig_rate
        srv._audit_log_queue = orig_queue
