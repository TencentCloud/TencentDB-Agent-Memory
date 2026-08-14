"""Tests for MCP server protocol compliance and tool routing."""

import json
import subprocess
import sys
import os

SERVER_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "mcp-server", "server.py")


def send_request(proc, request: dict) -> dict:
    line = json.dumps(request) + "\n"
    proc.stdin.write(line)
    proc.stdin.flush()
    response_line = proc.stdout.readline()
    return json.loads(response_line)


def start_server():
    env = os.environ.copy()
    env["TDAI_GATEWAY_URL"] = "http://127.0.0.1:19999"  # intentionally unreachable
    env["PYTHONUNBUFFERED"] = "1"
    return subprocess.Popen(
        [sys.executable, "-u", SERVER_PATH],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )


def test_initialize():
    proc = start_server()
    try:
        resp = send_request(proc, {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {},
        })
        assert resp["jsonrpc"] == "2.0"
        assert resp["id"] == 1
        assert resp["result"]["protocolVersion"] == "2024-11-05"
        assert "tools" in resp["result"]["capabilities"]
        assert resp["result"]["serverInfo"]["name"] == "tdai-memory"
    finally:
        proc.terminate()
        proc.wait()


def test_tools_list():
    proc = start_server()
    try:
        send_request(proc, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
        resp = send_request(proc, {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        tools = resp["result"]["tools"]
        assert len(tools) == 5
        names = {t["name"] for t in tools}
        assert names == {"tdai_health", "tdai_recall", "tdai_capture", "tdai_memory_search", "tdai_conversation_search"}
        for tool in tools:
            assert "inputSchema" in tool
            assert "description" in tool
    finally:
        proc.terminate()
        proc.wait()


def test_ping():
    proc = start_server()
    try:
        resp = send_request(proc, {"jsonrpc": "2.0", "id": 99, "method": "ping", "params": {}})
        assert resp["id"] == 99
        assert resp["result"] == {}
    finally:
        proc.terminate()
        proc.wait()


def test_unknown_method():
    proc = start_server()
    try:
        resp = send_request(proc, {"jsonrpc": "2.0", "id": 3, "method": "nonexistent", "params": {}})
        assert "error" in resp
        assert resp["error"]["code"] == -32601
    finally:
        proc.terminate()
        proc.wait()


def test_invalid_json():
    proc = start_server()
    try:
        proc.stdin.write("not valid json\n")
        proc.stdin.flush()
        response_line = proc.stdout.readline()
        resp = json.loads(response_line)
        assert "error" in resp
        assert resp["error"]["code"] == -32700
    finally:
        proc.terminate()
        proc.wait()


def test_tool_call_unknown_tool():
    proc = start_server()
    try:
        send_request(proc, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
        resp = send_request(proc, {
            "jsonrpc": "2.0", "id": 4, "method": "tools/call",
            "params": {"name": "nonexistent_tool", "arguments": {}},
        })
        content = resp["result"]["content"]
        assert resp["result"]["isError"] is True
        parsed = json.loads(content[0]["text"])
        assert "error" in parsed
    finally:
        proc.terminate()
        proc.wait()


def test_tool_call_gateway_unreachable():
    proc = start_server()
    try:
        send_request(proc, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
        resp = send_request(proc, {
            "jsonrpc": "2.0", "id": 5, "method": "tools/call",
            "params": {"name": "tdai_health", "arguments": {}},
        })
        content = resp["result"]["content"]
        assert resp["result"]["isError"] is True
        parsed = json.loads(content[0]["text"])
        assert "error" in parsed
    finally:
        proc.terminate()
        proc.wait()


def test_rate_limit():
    env = os.environ.copy()
    env["TDAI_GATEWAY_URL"] = "http://127.0.0.1:19999"
    env["TDAI_RATE_LIMIT_RPM"] = "2"
    env["PYTHONUNBUFFERED"] = "1"

    proc = subprocess.Popen(
        [sys.executable, "-u", SERVER_PATH],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )
    try:
        send_request(proc, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
        # First 2 should pass (even if gateway error)
        for i in range(2):
            send_request(proc, {
                "jsonrpc": "2.0", "id": 10 + i, "method": "tools/call",
                "params": {"name": "tdai_health", "arguments": {}},
            })
        # Third should be rate limited
        resp = send_request(proc, {
            "jsonrpc": "2.0", "id": 20, "method": "tools/call",
            "params": {"name": "tdai_health", "arguments": {}},
        })
        parsed = json.loads(resp["result"]["content"][0]["text"])
        assert "Rate limit" in parsed.get("error", "")
    finally:
        proc.terminate()
        proc.wait()


def test_recall_tool_schema():
    proc = start_server()
    try:
        send_request(proc, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
        resp = send_request(proc, {
            "jsonrpc": "2.0", "id": 6, "method": "tools/call",
            "params": {"name": "tdai_recall", "arguments": {"query": "test", "session_key": "s1"}},
        })
        assert "result" in resp
        assert "content" in resp["result"]
    finally:
        proc.terminate()
        proc.wait()


if __name__ == "__main__":
    tests = [
        test_initialize,
        test_tools_list,
        test_ping,
        test_unknown_method,
        test_invalid_json,
        test_tool_call_unknown_tool,
        test_tool_call_gateway_unreachable,
        test_rate_limit,
        test_recall_tool_schema,
    ]
    passed = 0
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  PASS: {t.__name__}")
            passed += 1
        except Exception as e:
            print(f"  FAIL: {t.__name__}: {e}")
            failed += 1
    print(f"\n{passed} passed, {failed} failed, {passed + failed} total")
    sys.exit(0 if failed == 0 else 1)
