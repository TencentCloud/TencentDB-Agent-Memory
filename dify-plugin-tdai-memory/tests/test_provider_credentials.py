from __future__ import annotations

import json
import sys
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
PLUGIN_ROOT_TEXT = str(PLUGIN_ROOT)
if PLUGIN_ROOT_TEXT not in sys.path:
    sys.path.insert(0, PLUGIN_ROOT_TEXT)


class _StubToolProvider:
    pass


class _StubToolProviderCredentialValidationError(Exception):
    pass


def _install_dify_stubs() -> None:
    dify_plugin = sys.modules.get("dify_plugin") or types.ModuleType("dify_plugin")
    if not hasattr(dify_plugin, "ToolProvider"):
        dify_plugin.ToolProvider = _StubToolProvider

    errors = sys.modules.get("dify_plugin.errors") or types.ModuleType("dify_plugin.errors")
    error_tool_module = sys.modules.get("dify_plugin.errors.tool") or types.ModuleType("dify_plugin.errors.tool")
    if not hasattr(error_tool_module, "ToolProviderCredentialValidationError"):
        error_tool_module.ToolProviderCredentialValidationError = _StubToolProviderCredentialValidationError

    sys.modules["dify_plugin"] = dify_plugin
    sys.modules["dify_plugin.errors"] = errors
    sys.modules["dify_plugin.errors.tool"] = error_tool_module


_install_dify_stubs()

from dify_plugin.errors.tool import ToolProviderCredentialValidationError  # noqa: E402
from provider.tdai_memory import TdaiMemoryProvider  # noqa: E402


class _ValidationGatewayHandler(BaseHTTPRequestHandler):
    response_status = 200
    response_body: dict[str, Any] = {"results": "", "total": 0, "strategy": "keyword"}
    requests: list[dict[str, Any]] = []
    _state_lock = threading.Lock()

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length).decode("utf-8")
        body = json.loads(raw) if raw else {}
        with self._state_lock:
            self.requests.append({"path": self.path, "body": body})
            response_status = self.response_status
            response_body = self.response_body

        if self.path != "/search/memories":
            self._send({"error": "not found"}, status=404)
            return
        self._send(response_body, status=response_status)

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _send(self, body: dict[str, Any], *, status: int = 200) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class ProviderCredentialsTest(unittest.TestCase):
    @classmethod
    def tearDownClass(cls) -> None:
        sys.modules.pop("dify_plugin", None)
        sys.modules.pop("dify_plugin.errors", None)
        sys.modules.pop("dify_plugin.errors.tool", None)

    def setUp(self) -> None:
        with _ValidationGatewayHandler._state_lock:
            _ValidationGatewayHandler.response_status = 200
            _ValidationGatewayHandler.response_body = {"results": "", "total": 0, "strategy": "keyword"}
            _ValidationGatewayHandler.requests = []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _ValidationGatewayHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        host, port = self.server.server_address
        self.gateway_url = f"http://{host}:{port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def _requests(self) -> list[dict[str, Any]]:
        with _ValidationGatewayHandler._state_lock:
            return list(_ValidationGatewayHandler.requests)

    def test_validate_credentials_requires_gateway_url(self) -> None:
        provider = TdaiMemoryProvider()

        with self.assertRaises(ToolProviderCredentialValidationError):
            provider._validate_credentials({})

    def test_validate_credentials_uses_read_only_search_handshake(self) -> None:
        provider = TdaiMemoryProvider()

        provider._validate_credentials({"gateway_url": self.gateway_url, "gateway_timeout_seconds": 2})

        requests = self._requests()
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0]["path"], "/search/memories")
        self.assertEqual(
            requests[0]["body"],
            {"query": "__dify_credential_validation__", "limit": 1},
        )

    def test_validate_credentials_rejects_gateway_http_error(self) -> None:
        with _ValidationGatewayHandler._state_lock:
            _ValidationGatewayHandler.response_status = 401
            _ValidationGatewayHandler.response_body = {"error": "Unauthorized", "code": "UNAUTHORIZED"}
        provider = TdaiMemoryProvider()

        with self.assertRaises(ToolProviderCredentialValidationError) as caught:
            provider._validate_credentials({"gateway_url": self.gateway_url, "gateway_timeout_seconds": 2})
        self.assertEqual(str(caught.exception), "Gateway credential validation failed (HTTP 401)")
        self.assertNotIn("Unauthorized", str(caught.exception))

    def test_validate_credentials_rejects_api_key_over_remote_http(self) -> None:
        provider = TdaiMemoryProvider()

        with self.assertRaises(ToolProviderCredentialValidationError):
            provider._validate_credentials(
                {"gateway_url": "http://example.invalid:8420", "gateway_api_key": "secret-token"}
            )
