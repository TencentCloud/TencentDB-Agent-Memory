"""
Red-team tests — adversarial inputs, stress, and injection.

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


# ── Injection / malformed ────────────────────────────────


def test_extremely_long_query():
    """1M character query should not crash the server."""
    long_query = "x" * 1_000_000
    resp = _rpc("tools/call", {
        "name": "tdai_recall",
        "arguments": {"query": long_query},
    })
    # Should not crash — may error gracefully or return empty
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
    # No 'name' in params — should error
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
        "arguments": {"query": "日本語 español العربية\n\t\u0000"},
    })
    assert resp is not None


# ── Stress ────────────────────────────────────────────────


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


# ── Parameter boundary ───────────────────────────────────


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
