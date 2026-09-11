from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from unittest import mock


PLUGIN_ROOT = Path(__file__).resolve().parents[1]


class _GatewayHandler(BaseHTTPRequestHandler):
    requests: list[dict[str, Any]] = []
    _requests_lock = threading.Lock()

    def do_POST(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send({"error": "invalid Content-Length"}, status=400)
            return
        raw = self.rfile.read(length).decode("utf-8")
        try:
            body = json.loads(raw) if raw else {}
        except ValueError:
            self._send({"error": "invalid JSON"}, status=400)
            return
        with self._requests_lock:
            self.requests.append({"path": self.path, "body": body})

        if self.path == "/capture":
            self._send({"l0_recorded": 1, "scheduler_notified": True})
            return
        if self.path == "/recall":
            self._send(
                {
                    "context": "stable Dify profile",
                    "prepend_context": "remember Dify sessions",
                    "append_system_context": "stable Dify profile",
                    "strategy": "hybrid",
                    "memory_count": 1,
                    "debug_secret": "internal-field",
                }
            )
            return
        self._send({"error": "not found"}, status=404)

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _send(self, body: dict[str, Any], *, status: int = 200) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class MockDifyServerTest(unittest.TestCase):
    def setUp(self) -> None:
        with _GatewayHandler._requests_lock:
            _GatewayHandler.requests = []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _GatewayHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        host, port = self.server.server_address
        self.gateway_url = f"http://{host}:{port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def _load_mock_server_module(self) -> Any:
        module_path = PLUGIN_ROOT / "scripts" / "mock_dify_plugin_server.py"
        self.assertTrue(module_path.is_file(), str(module_path))
        spec = importlib.util.spec_from_file_location("mock_dify_plugin_server", module_path)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_mock_server_invokes_capture_and_recall_tools_through_gateway(self) -> None:
        module = self._load_mock_server_module()

        credentials = {"gateway_url": self.gateway_url, "gateway_timeout_seconds": 2}
        capture = module.invoke_tool(
            "tdai_capture",
            {
                "user_content": "Please remember Dify session wiring.",
                "assistant_content": "I will store it through TencentDB Agent Memory.",
                "session_key": "dify-e2e-session",
            },
            credentials,
        )
        recall = module.invoke_tool(
            "tdai_recall",
            {"query": "What should Dify remember?", "session_key": "dify-e2e-session"},
            credentials,
        )

        self.assertEqual(capture["ok"], True)
        self.assertEqual(capture["l0_recorded"], 1)
        self.assertEqual(recall["ok"], True)
        self.assertIn("Dify sessions", recall["context"])
        self.assertIn("stable Dify profile", recall["context"])
        self.assertLess(recall["context"].index("Dify sessions"), recall["context"].index("stable Dify profile"))
        self.assertNotIn("debug_secret", recall)
        with _GatewayHandler._requests_lock:
            request_paths = [request["path"] for request in _GatewayHandler.requests]
        self.assertEqual(request_paths, ["/capture", "/recall"])

    def test_mock_server_returns_tool_error_payload_as_successful_invocation(self) -> None:
        module = self._load_mock_server_module()

        result = module.invoke_tool("tdai_capture", {}, {"gateway_url": ""})

        self.assertEqual(result["ok"], False)
        self.assertIn("gateway_url", result["error"])

    def test_mock_server_reads_api_key_file_once_then_deletes_it(self) -> None:
        module = self._load_mock_server_module()
        with tempfile.NamedTemporaryFile("w", delete=False, encoding="utf-8") as key_file:
            key_file.write("secret-token")
            key_path = key_file.name
        self.addCleanup(lambda: Path(key_path).unlink(missing_ok=True))

        with mock.patch.dict(os.environ, {"TDAI_DIFY_GATEWAY_API_KEY_FILE": key_path}):
            self.assertEqual(module._gateway_api_key(), "secret-token")
            self.assertFalse(Path(key_path).exists())
            self.assertEqual(module._gateway_api_key(), "secret-token")

    def test_mock_server_reports_missing_api_key_file(self) -> None:
        module = self._load_mock_server_module()
        missing_path = str(Path(tempfile.gettempdir()) / "tdai-missing-key-file")

        with mock.patch.dict(os.environ, {"TDAI_DIFY_GATEWAY_API_KEY_FILE": missing_path}):
            with self.assertRaises(ValueError) as caught:
                module._gateway_api_key()
        self.assertIn("cannot read gateway API key file", str(caught.exception))
