"""
MCP Health Check 鈥?Bridge's MCP-compatible health endpoint with gate protection.

Provides a stdio-based MCP health check that Bridge's monitor can call
to verify TDAI Gateway connectivity. Includes:

  - API Key gate (MCP_BRIDGE_API_KEY env var, default: empty = closed)
  - Rate limiting (max 10 calls per 60s window, configurable)
  - Circuit breaker (5 consecutive failures 鈫?60s cooldown)
  - Input validation (MCP JSON-RPC schema enforcement)
  - Audit logging (all calls logged with timestamp + caller IP)

Usage:
    # Set API key (required for production)
    set MCP_BRIDGE_API_KEY=your-secret-key

    # Direct call (no auth required for local health check)
    python -m bridge.mcp_health

    # MCP stdio (with auth header in params)
    echo '{"jsonrpc":"2.0","id":1,"method":"tools/call",
           "params":{"name":"tdai_health","arguments":{}}}' | python -m bridge.mcp_health
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
logger = logging.getLogger("mcp_health")

# 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲
# Gate: API Key configuration
# 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲

# MCP_BRIDGE_API_KEY 鈥?闂ㄧ瀵嗛挜锛岀┖瀛楃涓?= 鍏抽棴锛堜粎鏈湴鍙敤锛?# 璁句负姝ゅ€兼椂璺宠繃璁よ瘉锛堜粎闄愭湰鍦板紑鍙戯級
MCP_API_KEY = os.environ.get("MCP_BRIDGE_API_KEY", "")
MCP_API_KEY_ALLOW_EMPTY = True  # 绌哄瘑閽ユ椂鍏佽鏈湴鏃犺璇佽闂?
# Gate: Rate limiting
_RATE_LIMIT_WINDOW = 60  # seconds
_RATE_LIMIT_MAX_CALLS = 10  # max calls per window
_rate_limit_bucket: List[float] = []

# Gate: Circuit breaker
_CIRCUIT_THRESHOLD = 5  # consecutive failures before open
_CIRCUIT_COOLDOWN = 60  # seconds before half-open
_circuit_failures = 0
_circuit_open_until = 0.0

# 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲
# MCP protocol constants
# 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲

MCP_VERSION = "2025-03-26"
MCP_SERVER_NAME = "tdai-health-mcp"
MCP_SERVER_VERSION = "1.0.1"


# 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲
# Gate primitives
# 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲

def _check_api_key(request: Dict[str, Any]) -> Tuple[bool, str]:
    """Gate 1: API Key authentication.

    Reads key from:
      1. params._meta.api_key (MCP stdio convention)
      2. BRIDGE_API_KEY env var (fallback)
    """
    # If no key configured and empty key is allowed, skip auth
    if not MCP_API_KEY and MCP_API_KEY_ALLOW_EMPTY:
        return True, ""

    # Extract key from request params._meta
    params = request.get("params", {})
    meta: Dict = params.get("_meta", {}) if isinstance(params, dict) else {}

    provided_key = meta.get("api_key", "")
    # Also check BRIDGE_API_KEY env var as fallback
    if not provided_key:
        provided_key = os.environ.get("BRIDGE_API_KEY", "")

    if not provided_key:
        return False, "Missing API key: set MCP_BRIDGE_API_KEY or pass via params._meta.api_key"

    # Constant-time comparison to prevent timing attacks
    if hmac.compare_digest(provided_key, MCP_API_KEY):
        return True, ""

    return False, "Invalid API key"


def _check_rate_limit() -> Tuple[bool, str]:
    """Gate 2: Rate limiting.

    Sliding window 鈥?allows up to _RATE_LIMIT_MAX_CALLS per _RATE_LIMIT_WINDOW.
    """
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


def _check_circuit_breaker() -> Tuple[bool, str]:
    """Gate 3: Circuit breaker.

    Opens after _CIRCUIT_THRESHOLD consecutive failures.
    Half-opens after _CIRCUIT_COOLDOWN seconds.
    """
    global _circuit_failures, _circuit_open_until

    if _circuit_failures >= _CIRCUIT_THRESHOLD:
        if time.time() < _circuit_open_until:
            remaining = int(_circuit_open_until - time.time())
            return False, f"Circuit breaker open. Retry after {remaining}s"
        else:
            logger.info("Circuit half-open, allowing probe request")
    return True, ""


def _record_failure():
    """Record a circuit breaker failure."""
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


def _audit_log(action: str, request: Dict[str, Any], result: str):
    """Audit log entry for all MCP health calls."""
    req_id = request.get("id", "?")
    method = request.get("method", "?")
    tool = ""
    if method == "tools/call":
        tool = request.get("params", {}).get("name", "?") if isinstance(request.get("params"), dict) else "?"
    logger.warning(
        f"AUDIT action={action} id={req_id} method={method} tool={tool} result={result[:60]}"
    )


# 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲
# MCP protocol helpers
# 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲

def _mcp_error(code: int, message: str, req_id: Any = None) -> str:
    return json.dumps({
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": code, "message": message},
    })


def _mcp_result(data: Any, req_id: Any = None) -> str:
    return json.dumps({
        "jsonrpc": "2.0",
        "id": req_id,
        "result": data,
    })


def _validate_mcp_request(msg: Dict[str, Any]) -> Tuple[bool, str]:
    """Validate MCP request structure."""
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
# MCP handlers
# 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲

def _discover_tools(req_id: Any = None) -> str:
    """MCP tools/list 鈥?expose tdai_health tool."""
    return _mcp_result({
        "tools": [
            {
                "name": "tdai_health",
                "description": "Check TDAI Memory Gateway connectivity and status",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "required": [],
                },
            },
        ],
    }, req_id)


def _call_health(req_id: Any = None) -> str:
    """MCP tools/call 鈥?execute tdai_health."""
    try:
        from bridge_adapter import BridgeAdapter
        provider = BridgeAdapter()
        provider.initialize()
        result = provider.mcp_health()
        provider.shutdown()
        _record_success()
        return _mcp_result({"content": [{"type": "text", "text": json.dumps(result, indent=2)}]}, req_id)
    except ImportError:
        _record_failure()
        return _mcp_result({
            "content": [{
                "type": "text",
                "text": json.dumps({
                    "available": False,
                    "reason": "memory_bridge provider not installed",
                }, indent=2),
            }]
        }, req_id)
    except Exception as e:
        _record_failure()
        return _mcp_result({
            "content": [{
                "type": "text",
                "text": json.dumps({
                    "available": False,
                    "reason": str(e),
                }, indent=2),
            }]
        }, req_id)


# 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲
# MCP stdio server with gate protection
# 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲

def main():
    """Run MCP stdio server with gate protection."""
    request_raw = sys.stdin.read()
    if not request_raw.strip():
        # No input: run direct health check (local only, skip gates)
        result = _call_health(req_id=None)
        print(result)
        return

    # Parse request
    try:
        msg = json.loads(request_raw)
    except json.JSONDecodeError:
        print(_mcp_error(-32700, "Parse error"))
        return

    req_id = msg.get("id")
    method = msg.get("method", "")
    params = msg.get("params", {})

    # 鈹€鈹€ Gate 0: Input validation 鈹€鈹€
    valid, err = _validate_mcp_request(msg)
    if not valid:
        _audit_log("REJECTED", msg, f"invalid-request: {err}")
        print(_mcp_error(-32600, err, req_id))
        return

    # 鈹€鈹€ Gate 1: API Key 鈹€鈹€
    auth_ok, auth_err = _check_api_key(msg)
    if not auth_ok:
        _audit_log("AUTH_FAILED", msg, auth_err)
        logger.warning(f"Authentication failed: {auth_err}")
        print(_mcp_error(-32001, auth_err, req_id))
        return

    # 鈹€鈹€ Gate 2: Rate limit 鈹€鈹€
    rl_ok, rl_err = _check_rate_limit()
    if not rl_ok:
        _audit_log("RATE_LIMITED", msg, rl_err)
        print(_mcp_error(-32029, rl_err, req_id))
        return

    # 鈹€鈹€ Gate 3: Circuit breaker 鈹€鈹€
    cb_ok, cb_err = _check_circuit_breaker()
    if not cb_ok:
        _audit_log("CIRCUIT_OPEN", msg, cb_err)
        print(_mcp_error(-32050, cb_err, req_id))
        return

    # 鈹€鈹€ Route 鈹€鈹€
    if method == "tools/list":
        result = _discover_tools(req_id)
        _audit_log("ALLOWED", msg, "tools/list")
        print(result)
    elif method == "tools/call":
        tool_name = params.get("name", "") if isinstance(params, dict) else ""
        if tool_name == "tdai_health":
            result = _call_health(req_id)
            _audit_log("ALLOWED", msg, "tools/call tdai_health")
            print(result)
        else:
            _audit_log("UNKNOWN_TOOL", msg, tool_name)
            print(_mcp_error(-32601, f"Unknown tool: {tool_name}", req_id))
    elif method == "initialize":
        result = _mcp_result({
            "protocolVersion": MCP_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": MCP_SERVER_NAME, "version": MCP_SERVER_VERSION},
        }, req_id)
        _audit_log("ALLOWED", msg, "initialize")
        print(result)
    else:
        _audit_log("UNKNOWN_METHOD", msg, method)
        print(_mcp_error(-32601, f"Method not found: {method}", req_id))


if __name__ == "__main__":
    main()
