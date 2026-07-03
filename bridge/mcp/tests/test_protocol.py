"""
Protocol compliance tests --- verify JSON-RPC 2.0 MCP protocol behavior.

These tests run without a real TDAI Gateway by testing the protocol layer
directly (tools/list, initialize, error handling).
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

SERVER_PATH = Path(__file__).parent.parent / "server.py"


def _rpc(method: str, params: dict | None = None) -> dict:
    """Send a JSON-RPC call to the MCP server via stdio."""
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
        capture_output=True, text=True, timeout=10,
    )
    assert proc.returncode == 0, f"Server exited with {proc.returncode}: {proc.stderr}"
    return json.loads(proc.stdout)


def _raw_rpc(request_str: str) -> dict:
    """Send a raw string as the request."""
    proc = subprocess.run(
        [sys.executable, str(SERVER_PATH)],
        input=request_str,
        capture_output=True, text=True, timeout=10,
    )
    assert proc.returncode == 0, f"Server exited with {proc.returncode}: {proc.stderr}"
    return json.loads(proc.stdout)


# ------ Initialize ------------------------------------------------------------------------------------------------------------------------------


def test_initialize():
    resp = _rpc("initialize")
    assert resp.get("jsonrpc") == "2.0"
    result = resp.get("result", {})
    assert "protocolVersion" in result
    assert result.get("serverInfo", {}).get("name") == "bridge-mcp"


# ------ tools/list ------------------------------------------------------------------------------------------------------------------------------


def test_tools_list_returns_all_tools():
    resp = _rpc("tools/list")
    assert resp.get("jsonrpc") == "2.0"
    tools = resp.get("result", {}).get("tools", [])
    assert len(tools) == 5

    names = {t["name"] for t in tools}
    assert "tdai_health" in names
    assert "tdai_recall" in names
    assert "tdai_capture" in names
    assert "tdai_memory_search" in names
    assert "tdai_conversation_search" in names


def test_tools_list_tool_schemas():
    resp = _rpc("tools/list")
    tools = resp.get("result", {}).get("tools", [])

    for tool in tools:
        assert "name" in tool
        assert "description" in tool
        assert "inputSchema" in tool
        schema = tool["inputSchema"]
        assert schema.get("type") == "object"
        assert "properties" in schema


def test_recall_tool_has_required_query():
    resp = _rpc("tools/list")
    tools = resp.get("result", {}).get("tools", [])
    recall = next(t for t in tools if t["name"] == "tdai_recall")
    assert "query" in recall["inputSchema"].get("required", [])


def test_capture_tool_has_required_fields():
    resp = _rpc("tools/list")
    tools = resp.get("result", {}).get("tools", [])
    capture = next(t for t in tools if t["name"] == "tdai_capture")
    required = capture["inputSchema"].get("required", [])
    assert "user_content" in required
    assert "assistant_content" in required


# ------ tools/call (no Gateway = graceful degradation) ------------------


def test_health_no_gateway():
    resp = _rpc("tools/call", {
        "name": "tdai_health",
        "arguments": {},
    })
    assert resp.get("jsonrpc") == "2.0"
    content = resp.get("result", {}).get("content", [])
    assert len(content) > 0
    text = content[0].get("text", "")
    assert "available" in text  # returns false gracefully


def test_recall_no_gateway():
    resp = _rpc("tools/call", {
        "name": "tdai_recall",
        "arguments": {"query": "test"},
    })
    # Without bridge_adapter, may return error or gracefully degrade
    if "error" in resp:
        # Clean error --- no crash, no internal path leakage
        assert isinstance(resp["error"].get("message"), str)
        assert resp["error"]["code"] == -32603
    else:
        result = resp.get("result", {})
        content = result.get("content", [])
        assert len(content) > 0


def test_unknown_tool():
    resp = _rpc("tools/call", {
        "name": "nonexistent_tool",
        "arguments": {},
    })
    assert "error" in resp
    assert resp["error"]["code"] == -32601


def test_missing_method():
    resp = _raw_rpc(json.dumps({"jsonrpc": "2.0", "id": 1}))
    assert "error" in resp


# ------ Error handling ------------------------------------------------------------------------------------------------------------------


def test_malformed_json():
    """Invalid JSON should return parse error."""
    resp = _raw_rpc("{bad json}")
    assert resp.get("error", {}).get("code") == -32700


def test_wrong_jsonrpc_version():
    resp = _raw_rpc(json.dumps({"jsonrpc": "1.0", "method": "ping", "id": 1}))
    assert "error" in resp


def test_not_a_dict():
    resp = _raw_rpc('"just a string"')
    assert "error" in resp


def test_empty_input():
    """Empty input should return health check (local convenience)."""
    proc = subprocess.run(
        [sys.executable, str(SERVER_PATH)],
        input="",
        capture_output=True, text=True, timeout=10,
    )
    result = json.loads(proc.stdout)
    assert "available" in result


# ------ Initialize --- tools/list sequence ------------------------------------------------------------


def test_initialize_then_list():
    """Sequential initialize + tools/list in separate calls."""
    init = _rpc("initialize")
    assert init.get("result", {}).get("serverInfo", {}).get("name") == "bridge-mcp"

    listing = _rpc("tools/list")
    assert len(listing.get("result", {}).get("tools", [])) == 5
