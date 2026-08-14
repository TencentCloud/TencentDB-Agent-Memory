#!/usr/bin/env python3
"""
TencentDB Agent Memory - MCP stdio server.

Pure JSON-RPC 2.0 over stdin/stdout. No external MCP framework dependency.
Exposes 5 tools that proxy to the TDAI Gateway HTTP API.

Compatible with: Claude Code, Trae IDE, Codex CLI, Cursor, CodeBuddy, Windsurf.
"""

from __future__ import annotations

import json
import sys
import os
import time
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
from typing import Any, Dict, List, Optional

GATEWAY_URL = os.environ.get("TDAI_GATEWAY_URL", "http://127.0.0.1:8420")
API_KEY = os.environ.get("TDAI_API_KEY", "")
SERVICE_ID = os.environ.get("TDAI_SERVICE_ID", "default")
RATE_LIMIT_RPM = int(os.environ.get("TDAI_RATE_LIMIT_RPM", "60"))

_request_timestamps: List[float] = []
_circuit_failures = 0
_circuit_open_until = 0.0
CIRCUIT_THRESHOLD = 5
CIRCUIT_COOLDOWN = 30.0


def _rate_limit_check() -> Optional[str]:
    now = time.time()
    window = now - 60
    _request_timestamps[:] = [t for t in _request_timestamps if t > window]
    if len(_request_timestamps) >= RATE_LIMIT_RPM:
        return f"Rate limit exceeded ({RATE_LIMIT_RPM} req/min)"
    _request_timestamps.append(now)
    return None


def _circuit_check() -> Optional[str]:
    global _circuit_open_until
    if _circuit_failures >= CIRCUIT_THRESHOLD:
        if time.time() < _circuit_open_until:
            return "Circuit breaker open - gateway unavailable"
        _reset_circuit()
    return None


def _record_success():
    global _circuit_failures, _circuit_open_until
    _circuit_failures = 0


def _record_failure():
    global _circuit_failures, _circuit_open_until
    _circuit_failures += 1
    if _circuit_failures >= CIRCUIT_THRESHOLD:
        _circuit_open_until = time.time() + CIRCUIT_COOLDOWN


def _reset_circuit():
    global _circuit_failures, _circuit_open_until
    _circuit_failures = 0
    _circuit_open_until = 0.0


def _auth_header() -> Dict[str, str]:
    if API_KEY:
        return {"Authorization": f"Bearer {API_KEY}"}
    return {}


def _gateway_request(method: str, path: str, body: Optional[dict] = None) -> dict:
    url = f"{GATEWAY_URL}{path}"
    headers: Dict[str, str] = {"Content-Type": "application/json"}
    headers.update(_auth_header())
    data = json.dumps(body).encode() if body else None
    req = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode())
            _record_success()
            return result
    except HTTPError as e:
        _record_failure()
        try:
            err_body = json.loads(e.read().decode())
            raise GatewayError(err_body.get("error", str(e)), e.code)
        except (json.JSONDecodeError, AttributeError):
            raise GatewayError(str(e), e.code)
    except URLError as e:
        _record_failure()
        raise GatewayError(f"Gateway unreachable: {e.reason}", 503)


class GatewayError(Exception):
    def __init__(self, message: str, code: int = 500):
        super().__init__(message)
        self.code = code


TOOLS = [
    {
        "name": "tdai_health",
        "description": "Check TDAI memory gateway health status",
        "inputSchema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "tdai_recall",
        "description": "Recall relevant memories for a given query. Returns context to prepend to the prompt.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "The user message or query to recall memories for"},
                "session_key": {"type": "string", "description": "Session identifier for context scoping"},
            },
            "required": ["query", "session_key"],
        },
    },
    {
        "name": "tdai_capture",
        "description": "Capture a conversation turn into memory (user message + assistant response).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "user_content": {"type": "string", "description": "The user's message"},
                "assistant_content": {"type": "string", "description": "The assistant's response"},
                "session_key": {"type": "string", "description": "Session identifier"},
            },
            "required": ["user_content", "assistant_content", "session_key"],
        },
    },
    {
        "name": "tdai_memory_search",
        "description": "Search extracted L1 memories by query. Returns structured memory records.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
                "limit": {"type": "integer", "description": "Max results (default 10)"},
                "type": {"type": "string", "description": "Filter by memory type"},
                "scene": {"type": "string", "description": "Filter by scene"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "tdai_conversation_search",
        "description": "Search raw L0 conversation history.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
                "limit": {"type": "integer", "description": "Max results (default 10)"},
                "session_key": {"type": "string", "description": "Scope search to a specific session"},
            },
            "required": ["query"],
        },
    },
]


def handle_tool_call(name: str, arguments: dict) -> dict:
    rate_err = _rate_limit_check()
    if rate_err:
        return {"error": rate_err}

    circuit_err = _circuit_check()
    if circuit_err:
        return {"error": circuit_err}

    try:
        if name == "tdai_health":
            return _gateway_request("GET", "/health")

        elif name == "tdai_recall":
            return _gateway_request("POST", "/recall", {
                "query": arguments["query"],
                "session_key": arguments["session_key"],
            })

        elif name == "tdai_capture":
            return _gateway_request("POST", "/capture", {
                "user_content": arguments["user_content"],
                "assistant_content": arguments["assistant_content"],
                "session_key": arguments["session_key"],
            })

        elif name == "tdai_memory_search":
            body: Dict[str, Any] = {"query": arguments["query"]}
            if "limit" in arguments:
                body["limit"] = arguments["limit"]
            if "type" in arguments:
                body["type"] = arguments["type"]
            if "scene" in arguments:
                body["scene"] = arguments["scene"]
            return _gateway_request("POST", "/search/memories", body)

        elif name == "tdai_conversation_search":
            body = {"query": arguments["query"]}
            if "limit" in arguments:
                body["limit"] = arguments["limit"]
            if "session_key" in arguments:
                body["session_key"] = arguments["session_key"]
            return _gateway_request("POST", "/search/conversations", body)

        else:
            return {"error": f"Unknown tool: {name}"}

    except GatewayError as e:
        return {"error": str(e), "code": e.code}


def handle_request(request: dict) -> Optional[dict]:
    method = request.get("method", "")
    req_id = request.get("id")

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {
                    "name": "tdai-memory",
                    "version": "0.3.6",
                },
            },
        }

    elif method == "notifications/initialized":
        return None

    elif method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {"tools": TOOLS},
        }

    elif method == "tools/call":
        params = request.get("params", {})
        tool_name = params.get("name", "")
        arguments = params.get("arguments", {})
        result = handle_tool_call(tool_name, arguments)

        is_error = "error" in result
        content = [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}]

        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {"content": content, "isError": is_error},
        }

    elif method == "ping":
        return {"jsonrpc": "2.0", "id": req_id, "result": {}}

    else:
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": -32601, "message": f"Method not found: {method}"},
        }


def main():
    sys.stderr.write(f"[tdai-memory-mcp] Starting MCP server (gateway={GATEWAY_URL})\n")
    sys.stderr.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError as e:
            error_resp = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32700, "message": f"Parse error: {e}"},
            }
            sys.stdout.write(json.dumps(error_resp) + "\n")
            sys.stdout.flush()
            continue

        response = handle_request(request)
        if response is not None:
            sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
