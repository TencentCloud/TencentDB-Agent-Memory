"""
MCP stdio server 鈥?wraps TdaiAdapter as MCP tools.

Built-in gates (API key + rate limit + circuit breaker + audit) provide
defense-in-depth for desktop/loopback mode. In production these gates
are supplemented by agentgateway (Linux Foundation) 鈥?if agentgateway
fails, the local gates remain active as a safety net.

Architecture:
  Production: MCP Client 鈫?agentgateway (auth/rate-limit/OTEL/OPA)
                              鈫?                         bridge/mcp/server.py (self-gated fallback)
                              鈫?                         TdaiAdapter 鈫?Gateway

  Desktop:    MCP Client 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈫?bridge/mcp/server.py (gates active)

Usage:
    # Desktop (no auth required for loopback)
    python -m bridge.mcp.server

    # Production (API key required)
    set MCP_BRIDGE_API_KEY=your-key
    python -m bridge.mcp.server

Environment:
    MCP_BRIDGE_API_KEY    API key for tools/call. Empty = loopback allowed.
                          When set, client must pass key in params._meta.api_key.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("bridge.mcp")


# 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲
# Gate: API Key
# 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲

_MCP_API_KEY = os.environ.get("MCP_BRIDGE_API_KEY") or os.environ.get("TDAI_API_KEY", "")
# When True (default for desktop), empty key = no auth required (loopback).
# Set to False for strict mode.
_MCP_API_KEY_ALLOW_EMPTY = True


def _check_api_key(request: Dict[str, Any]) -> Tuple[bool, str]:
    """Gate 1: API Key authentication."""
    # If no key configured and empty key is allowed, skip auth
    if not _MCP_API_KEY and _MCP_API_KEY_ALLOW_EMPTY:
        return True, ""

    params = request.get("params", {})
    meta: Dict = params.get("_meta", {}) if isinstance(params, dict) else {}
    provided_key = meta.get("api_key", "")

    if not provided_key:
        return (
            False,
            "Missing API key: set MCP_BRIDGE_API_KEY or pass via params._meta.api_key",
        )

    if hmac.compare_digest(provided_key, _MCP_API_KEY):
        return True, ""

    return False, "Invalid API key"


# 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲
# Gate: Rate limiting
# 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲

_RATE_LIMIT_WINDOW = 60  # seconds
_RATE_LIMIT_MAX_CALLS = 60  # max calls per window
_rate_limit_bucket: List[float] = []


def _check_rate_limit() -> Tuple[bool, str]:
    """Gate 2: Sliding window rate limit."""
    now = time.time()
    global _rate_limit_bucket
    # Prune expired entries
    _rate_limit_bucket = [t for t in _rate_limit_bucket if now - t < _RATE_LIMIT_WINDOW]
    if len(_rate_limit_bucket) >= _RATE_LIMIT_MAX_CALLS:
        oldest = _rate_limit_bucket[0] if _rate_limit_bucket else now
        retry_after = int(_RATE_LIMIT_WINDOW - (now - oldest))
        return False, f"Rate limit exceeded. Retry after {retry_after}s"
    _rate_limit_bucket.append(now)
    return True, ""


# 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲
# Gate: Circuit breaker
# 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲

_CIRCUIT_THRESHOLD = 10  # consecutive failures before open
_CIRCUIT_COOLDOWN = 60  # seconds before half-open
_circuit_failures = 0
_circuit_open_until = 0.0


def _check_circuit_breaker() -> Tuple[bool, str]:
    """Gate 3: Circuit breaker."""
    global _circuit_failures, _circuit_open_until
    if _circuit_failures >= _CIRCUIT_THRESHOLD:
        if time.time() < _circuit_open_until:
            remaining = int(_circuit_open_until - time.time())
            return False, f"Circuit breaker open. Retry after {remaining}s"
        else:
            logger.info("Circuit half-open, allowing probe request")
    return True, ""


def _record_failure():
    """Record circuit breaker failure."""
    global _circuit_failures, _circuit_open_until
    _circuit_failures += 1
    if _circuit_failures >= _CIRCUIT_THRESHOLD:
        _circuit_open_until = time.time() + _CIRCUIT_COOLDOWN
        logger.error(
            f"Circuit OPEN after {_circuit_failures} failures "
            f"(cooldown={_CIRCUIT_COOLDOWN}s)"
        )


def _record_success():
    """Reset circuit breaker on success."""
    global _circuit_failures
    _circuit_failures = 0


# 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲
# Gate: Audit logging
# 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲


def _audit_log(action: str, method: str, tool: str, detail: str = ""):
    """Audit log entry for all MCP calls."""
    logger.warning(f"AUDIT action={action} method={method} tool={tool} detail={detail[:120]}")


# 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲
# Helpers
# 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲


def _err(code: int, msg: str, req_id: Any = None) -> str:
    return json.dumps({"jsonrpc": "2.0", "id": req_id,
                        "error": {"code": code, "message": msg}})


def _ok(data: Any, req_id: Any = None) -> str:
    return json.dumps({"jsonrpc": "2.0", "id": req_id, "result": data})


def _text_content(text: str) -> list:
    return [{"type": "text", "text": text}]


# 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲
# Tool handlers (lazy-import TdaiAdapter)
# 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲

_ADAPTER: Any = None


def _get_adapter():
    global _ADAPTER
    if _ADAPTER is None:
        from bridge_adapter import BridgeAdapter  # type: ignore[import-untyped]
        _ADAPTER = BridgeAdapter()
        _ADAPTER.initialize()
    return _ADAPTER


def _handle_tdai_health(params: Any, req_id: Any) -> str:
    try:
        provider = _get_adapter()
        result = provider.mcp_health()
        _record_success()
        return _ok({"content": _text_content(json.dumps(result, indent=2))}, req_id)
    except Exception as e:
        _record_failure()
        return _ok({"content": _text_content(
            json.dumps({"available": False, "reason": str(e)}))}, req_id)


def _handle_tdai_recall(params: dict, req_id: Any) -> str:
    try:
        query = params.get("query", "")
        limit = params.get("limit", 5)
        provider = _get_adapter()
        result = provider.recall(query, limit)
        _record_success()
        return _ok({"content": _text_content(json.dumps(result, indent=2))}, req_id)
    except Exception as e:
        _record_failure()
        return _err(-32603, str(e), req_id)


def _handle_tdai_capture(params: dict, req_id: Any) -> str:
    try:
        user_content = params.get("user_content", "")
        assistant_content = params.get("assistant_content", "")
        session_id = params.get("session_id", "")
        provider = _get_adapter()
        ok = provider.capture(user_content, assistant_content, session_id)
        _record_success()
        return _ok({"content": _text_content(json.dumps({"success": ok}))}, req_id)
    except Exception as e:
        _record_failure()
        return _err(-32603, str(e), req_id)


def _handle_tdai_memory_search(params: dict, req_id: Any) -> str:
    try:
        query = params.get("query", "")
        limit = params.get("limit", 5)
        provider = _get_adapter()
        results = provider.search_memory(query, limit)
        _record_success()
        return _ok({"content": _text_content(json.dumps(results, indent=2))}, req_id)
    except Exception as e:
        _record_failure()
        return _err(-32603, str(e), req_id)


def _handle_tdai_conversation_search(params: dict, req_id: Any) -> str:
    try:
        query = params.get("query", "")
        limit = params.get("limit", 5)
        provider = _get_adapter()
        results = provider.search_conversation(query, limit)
        _record_success()
        return _ok({"content": _text_content(json.dumps(results, indent=2))}, req_id)
    except Exception as e:
        _record_failure()
        return _err(-32603, str(e), req_id)


_TOOL_HANDLERS = {
    "tdai_health": _handle_tdai_health,
    "tdai_recall": _handle_tdai_recall,
    "tdai_capture": _handle_tdai_capture,
    "tdai_memory_search": _handle_tdai_memory_search,
    "tdai_conversation_search": _handle_tdai_conversation_search,
}

_TOOL_DEFS = [
    {
        "name": "tdai_health",
        "description": "Check TDAI Gateway connectivity and status",
        "inputSchema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "tdai_recall",
        "description": "Recall cross-session memories for the current query",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
                "limit": {"type": "integer", "description": "Max memories (default 5)"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "tdai_capture",
        "description": "Store a conversation turn in TDAI L0",
        "inputSchema": {
            "type": "object",
            "properties": {
                "user_content": {"type": "string", "description": "User message"},
                "assistant_content": {"type": "string", "description": "Assistant response"},
                "session_id": {"type": "string", "description": "Optional session key"},
            },
            "required": ["user_content", "assistant_content"],
        },
    },
    {
        "name": "tdai_memory_search",
        "description": "Search L1 atomic memories by query",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
                "limit": {"type": "integer", "description": "Max results (default 5)"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "tdai_conversation_search",
        "description": "Search L0 conversation history by query",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
                "limit": {"type": "integer", "description": "Max results (default 5)"},
            },
            "required": ["query"],
        },
    },
]


# 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲
# JSON-RPC validation
# 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲


def _validate_mcp_request(msg: Dict[str, Any]) -> Tuple[bool, str]:
    if not isinstance(msg, dict):
        return False, "Request must be a JSON object"
    if "jsonrpc" not in msg:
        return False, "Missing jsonrpc field"
    if msg.get("jsonrpc") != "2.0":
        return False, "Only jsonrpc 2.0 supported"
    if "method" not in msg:
        return False, "Missing method field"
    return True, ""


# 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲
# MCP stdio server with gates
# 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲


def main():
    """Run MCP stdio server. Reads JSON-RPC from stdin, writes to stdout."""
    request_raw = sys.stdin.read()
    if not request_raw.strip():
        # No input: return simple health status without importing adapter
        try:
            avail = _get_adapter().is_available()
        except Exception:
            avail = False
        print(json.dumps({"available": avail}))
        return

    # 鈹€鈹€ Parse 鈹€鈹€
    try:
        msg = json.loads(request_raw)
    except json.JSONDecodeError:
        print(_err(-32700, "Parse error"))
        return

    req_id = msg.get("id") if isinstance(msg, dict) else None
    method = msg.get("method", "") if isinstance(msg, dict) else ""

    # 鈹€鈹€ Gate 0: Input validation 鈹€鈹€
    valid, err = _validate_mcp_request(msg)
    if not valid:
        _audit_log("REJECTED", method, "", err)
        print(_err(-32600, err, req_id))
        return

    # 鈹€鈹€ Initialize (bypass gates) 鈹€鈹€
    if method == "initialize":
        _audit_log("ALLOWED", method, "", "")
        print(_ok({
            "protocolVersion": "2025-03-26",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "bridge-mcp", "version": "1.0.0"},
        }, req_id))
        return

    # 鈹€鈹€ tools/list (bypass gates) 鈹€鈹€
    if method == "tools/list":
        _audit_log("ALLOWED", method, "", "")
        print(_ok({"tools": _TOOL_DEFS}, req_id))
        return

    # 鈹€鈹€ tools/call (gates apply) 鈹€鈹€
    if method == "tools/call":
        params = msg.get("params", {})
        if not isinstance(params, dict):
            _audit_log("REJECTED", method, "", "invalid params type")
            print(_err(-32602, "Invalid params", req_id))
            return

        tool_name = params.get("name", "")

        # Gate 1: API Key
        auth_ok, auth_err = _check_api_key(msg)
        if not auth_ok:
            _audit_log("AUTH_FAILED", method, tool_name, auth_err)
            print(_err(-32001, auth_err, req_id))
            return

        # Gate 2: Rate limit
        rl_ok, rl_err = _check_rate_limit()
        if not rl_ok:
            _audit_log("RATE_LIMITED", method, tool_name, rl_err)
            print(_err(-32029, rl_err, req_id))
            return

        # Gate 3: Circuit breaker
        cb_ok, cb_err = _check_circuit_breaker()
        if not cb_ok:
            _audit_log("CIRCUIT_OPEN", method, tool_name, cb_err)
            print(_err(-32050, cb_err, req_id))
            return

        # Route
        tool_params = params.get("arguments", {})
        handler = _TOOL_HANDLERS.get(tool_name)
        if handler is None:
            _audit_log("UNKNOWN_TOOL", method, tool_name)
            print(_err(-32601, f"Unknown tool: {tool_name}", req_id))
            return

        _audit_log("ALLOWED", method, tool_name)
        result = handler(tool_params, req_id)
        print(result)
        return

    # 鈹€鈹€ Unknown method 鈹€鈹€
    _audit_log("UNKNOWN_METHOD", method, "")
    print(_err(-32601, f"Method not found: {method}", req_id))


if __name__ == "__main__":
    main()
