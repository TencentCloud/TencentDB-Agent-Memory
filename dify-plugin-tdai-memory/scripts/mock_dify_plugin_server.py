#!/usr/bin/env python3
"""Small local server that invokes the Dify tool classes without Dify.

This is a quickstart/e2e harness, not production runtime. It installs a tiny
`dify_plugin` stub, loads the real tool classes, and forwards invocations to
the configured TencentDB Agent Memory Gateway.
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import sys
import threading
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from typing import Any


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
PLUGIN_ROOT_TEXT = str(PLUGIN_ROOT)
if PLUGIN_ROOT_TEXT not in sys.path:
    sys.path.insert(0, PLUGIN_ROOT_TEXT)

TOOL_CLASSES = {
    "tdai_health": ("tools.tdai_health", "TdaiHealthTool"),
    "tdai_recall": ("tools.tdai_recall", "TdaiRecallTool"),
    "tdai_capture": ("tools.tdai_capture", "TdaiCaptureTool"),
    "tdai_memory_search": ("tools.tdai_memory_search", "TdaiMemorySearchTool"),
    "tdai_conversation_search": ("tools.tdai_conversation_search", "TdaiConversationSearchTool"),
    "tdai_session_end": ("tools.tdai_session_end", "TdaiSessionEndTool"),
}
MAX_BODY_BYTES = 1_048_576
_api_key_cache: str | None = None
_api_key_lock = threading.Lock()


class _StubTool:
    def create_json_message(self, payload: dict[str, Any]) -> dict[str, Any]:
        return payload


class _StubToolProvider:
    pass


class _StubToolProviderCredentialValidationError(Exception):
    pass


def install_dify_stubs() -> None:
    dify_plugin = sys.modules.get("dify_plugin") or types.ModuleType("dify_plugin")
    if not hasattr(dify_plugin, "Tool"):
        dify_plugin.Tool = _StubTool
    if not hasattr(dify_plugin, "ToolProvider"):
        dify_plugin.ToolProvider = _StubToolProvider

    entities = sys.modules.get("dify_plugin.entities") or types.ModuleType("dify_plugin.entities")
    tool_module = sys.modules.get("dify_plugin.entities.tool") or types.ModuleType("dify_plugin.entities.tool")
    if not hasattr(tool_module, "ToolInvokeMessage"):
        tool_module.ToolInvokeMessage = dict

    errors = sys.modules.get("dify_plugin.errors") or types.ModuleType("dify_plugin.errors")
    error_tool_module = sys.modules.get("dify_plugin.errors.tool") or types.ModuleType("dify_plugin.errors.tool")
    if not hasattr(error_tool_module, "ToolProviderCredentialValidationError"):
        error_tool_module.ToolProviderCredentialValidationError = _StubToolProviderCredentialValidationError

    sys.modules["dify_plugin"] = dify_plugin
    sys.modules["dify_plugin.entities"] = entities
    sys.modules["dify_plugin.entities.tool"] = tool_module
    sys.modules["dify_plugin.errors"] = errors
    sys.modules["dify_plugin.errors.tool"] = error_tool_module


install_dify_stubs()


def gateway_credentials() -> dict[str, Any]:
    return {
        "gateway_url": os.environ.get("TDAI_DIFY_GATEWAY_URL", "http://127.0.0.1:8420"),
        "gateway_api_key": _gateway_api_key(),
        "gateway_timeout_seconds": os.environ.get("TDAI_DIFY_GATEWAY_TIMEOUT_SECONDS", "10"),
    }


def _gateway_api_key() -> str:
    global _api_key_cache
    if _api_key_cache is not None:
        return _api_key_cache

    with _api_key_lock:
        if _api_key_cache is not None:
            return _api_key_cache

        key_file = os.environ.get("TDAI_DIFY_GATEWAY_API_KEY_FILE", "")
        if key_file:
            key_path = Path(key_file)
            try:
                _api_key_cache = key_path.read_text(encoding="utf-8").strip()
            except (FileNotFoundError, PermissionError) as exc:
                raise ValueError(f"cannot read gateway API key file: {key_path}") from exc
            key_path.unlink(missing_ok=True)
            return _api_key_cache

        _api_key_cache = os.environ.get("TDAI_DIFY_GATEWAY_API_KEY", "")
        return _api_key_cache


def invoke_tool(tool_name: str, parameters: dict[str, Any], credentials: dict[str, Any]) -> dict[str, Any]:
    if not str(credentials.get("gateway_url") or "").strip():
        return {"ok": False, "operation": tool_name, "error": "gateway_url is required"}
    module_name, class_name = TOOL_CLASSES[tool_name]
    module = importlib.import_module(module_name)
    tool_class = getattr(module, class_name)
    tool = tool_class()
    tool.runtime = SimpleNamespace(credentials=credentials)
    messages = list(tool._invoke(parameters))
    if not messages:
        return {"ok": False, "operation": tool_name, "error": "tool produced no output"}
    message = messages[0]
    if isinstance(message, dict):
        return message
    return {"ok": False, "operation": tool_name, "error": f"unexpected output: {type(message).__name__}"}


class MockDifyHandler(BaseHTTPRequestHandler):
    server_version = "TdaiDifyMock/0.1"

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send({"ok": True, "tools": sorted(TOOL_CLASSES)})
            return
        self._send({"ok": False, "error": "not found"}, status=404)

    def do_POST(self) -> None:
        prefix = "/invoke/"
        if not self.path.startswith(prefix):
            self._send({"ok": False, "error": "not found"}, status=404)
            return
        tool_name = self.path[len(prefix) :]
        if tool_name not in TOOL_CLASSES:
            self._send({"ok": False, "error": f"unknown tool: {tool_name}"}, status=404)
            return
        try:
            parameters = self._read_json()
            result = invoke_tool(tool_name, parameters, gateway_credentials())
            self._send(result)
        except ValueError as exc:
            self._send({"ok": False, "error": str(exc)}, status=400)
        except Exception as exc:
            self._send({"ok": False, "error": f"mock server failed: {exc}"}, status=500)

    def log_message(self, format: str, *args: Any) -> None:
        if self.path != "/health":
            super().log_message(format, *args)

    def _read_json(self) -> dict[str, Any]:
        raw_length = self.headers.get("Content-Length", "0")
        try:
            length = int(raw_length)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"invalid Content-Length header: {raw_length!r}") from exc
        if length < 0:
            raise ValueError("invalid Content-Length header: negative length")
        if length > MAX_BODY_BYTES:
            raise ValueError(f"request body exceeds {MAX_BODY_BYTES} bytes")
        try:
            raw = self.rfile.read(length).decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValueError("request body must be valid UTF-8") from exc
        if not raw:
            return {}
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            raise ValueError("request body must be a JSON object")
        return parsed

    def _send(self, body: dict[str, Any], *, status: int = 200) -> None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run a local mock Dify server for TDAI tools.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18420)
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), MockDifyHandler)
    print(f"Mock Dify server listening on http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
