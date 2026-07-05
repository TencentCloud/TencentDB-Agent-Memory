from __future__ import annotations

import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
PLUGIN_ROOT_TEXT = str(PLUGIN_ROOT)
if PLUGIN_ROOT_TEXT not in sys.path:
    sys.path.insert(0, PLUGIN_ROOT_TEXT)

from tools.client import TdaiGatewayClient, TdaiGatewayError  # noqa: E402


class _GatewayHandler(BaseHTTPRequestHandler):
    response_status = 200
    response_body: dict[str, Any] = {}
    response_content_type = "application/json"
    response_raw_body: str | None = None
    response_headers: dict[str, str] = {}
    requests: list[dict[str, Any]] = []
    _state_lock = threading.Lock()

    def do_GET(self) -> None:
        self._record_request(None)
        self._send_json()

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length).decode("utf-8")
        self._record_request(json.loads(raw) if raw else None)
        self._send_json()

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _record_request(self, body: dict[str, Any] | None) -> None:
        with self._state_lock:
            self.requests.append(
                {
                    "method": self.command,
                    "path": self.path,
                    "headers": dict(self.headers),
                    "body": body,
                }
            )

    def _send_json(self) -> None:
        with self._state_lock:
            raw = self.response_raw_body
            body = self.response_body
            status = self.response_status
            content_type = self.response_content_type
            headers = dict(self.response_headers)
        data = (raw if raw is not None else json.dumps(body)).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        for name, value in headers.items():
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class TdaiGatewayClientTest(unittest.TestCase):
    def setUp(self) -> None:
        with _GatewayHandler._state_lock:
            _GatewayHandler.response_status = 200
            _GatewayHandler.response_body = {}
            _GatewayHandler.response_content_type = "application/json"
            _GatewayHandler.response_raw_body = None
            _GatewayHandler.response_headers = {}
            _GatewayHandler.requests = []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _GatewayHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        host, port = self.server.server_address
        self.base_url = f"http://{host}:{port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def _gateway_requests(self) -> list[dict[str, Any]]:
        with _GatewayHandler._state_lock:
            return list(_GatewayHandler.requests)

    def _set_gateway_response(
        self,
        body: dict[str, Any],
        *,
        status: int = 200,
        content_type: str = "application/json",
        raw_body: str | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        with _GatewayHandler._state_lock:
            _GatewayHandler.response_status = status
            _GatewayHandler.response_body = body
            _GatewayHandler.response_content_type = content_type
            _GatewayHandler.response_raw_body = raw_body
            _GatewayHandler.response_headers = headers or {}

    def test_recall_posts_json_with_bearer_auth(self) -> None:
        self._set_gateway_response(
            {
                "context": "remember TypeScript imports",
                "strategy": "hybrid",
                "memory_count": 2,
            }
        )

        client = TdaiGatewayClient(self.base_url, api_key="secret-token", timeout=2)
        result = client.recall("What should I remember?", "dify-conv-1", user_id="u-42")

        self.assertEqual(result["context"], "remember TypeScript imports")
        requests = self._gateway_requests()
        self.assertEqual(len(requests), 1)
        request = requests[0]
        self.assertEqual(request["method"], "POST")
        self.assertEqual(request["path"], "/recall")
        self.assertEqual(request["headers"]["Authorization"], "Bearer secret-token")
        self.assertEqual(request["headers"]["Content-Type"], "application/json")
        self.assertEqual(
            request["body"],
            {
                "query": "What should I remember?",
                "session_key": "dify-conv-1",
                "user_id": "u-42",
            },
        )

    def test_gateway_error_exposes_status_code_and_error_code(self) -> None:
        self._set_gateway_response({"error": "Unauthorized", "code": "UNAUTHORIZED"}, status=401)

        client = TdaiGatewayClient(self.base_url, api_key="wrong", timeout=2)

        with self.assertRaises(TdaiGatewayError) as caught:
            client.search_memories("anything", limit=3)

        self.assertEqual(caught.exception.status_code, 401)
        self.assertEqual(caught.exception.code, "UNAUTHORIZED")
        self.assertIn("Unauthorized", str(caught.exception))

    def test_health_uses_get_without_json_body(self) -> None:
        self._set_gateway_response(
            {
                "status": "ok",
                "version": "0.3.6",
                "uptime": 10,
                "stores": {"vectorStore": True, "embeddingService": False},
            }
        )

        client = TdaiGatewayClient(self.base_url, timeout=2)
        result = client.health()

        self.assertEqual(result["status"], "ok")
        requests = self._gateway_requests()
        self.assertEqual(len(requests), 1)
        request = requests[0]
        self.assertEqual(request["method"], "GET")
        self.assertEqual(request["path"], "/health")
        self.assertNotIn("Content-Type", request["headers"])

    def test_non_json_success_response_exposes_status_and_body(self) -> None:
        self._set_gateway_response({}, content_type="text/plain", raw_body="proxy returned html")

        client = TdaiGatewayClient(self.base_url, timeout=2)

        with self.assertRaises(TdaiGatewayError) as caught:
            client.health()

        self.assertEqual(caught.exception.status_code, 200)
        self.assertEqual(caught.exception.response, "proxy returned html")
        self.assertIn("Unexpected Content-Type", str(caught.exception))

    def test_json_suffix_content_type_is_accepted(self) -> None:
        self._set_gateway_response({"status": "ok"}, content_type="application/vnd.api+json")

        client = TdaiGatewayClient(self.base_url, timeout=2)
        result = client.health()

        self.assertEqual(result["status"], "ok")

    def test_empty_non_json_success_response_is_rejected(self) -> None:
        self._set_gateway_response({}, content_type="text/html", raw_body="")

        client = TdaiGatewayClient(self.base_url, timeout=2)

        with self.assertRaises(TdaiGatewayError) as caught:
            client.health()

        self.assertEqual(caught.exception.status_code, 200)
        self.assertIn("Unexpected Content-Type", str(caught.exception))

    def test_empty_json_success_response_returns_empty_object(self) -> None:
        self._set_gateway_response({}, raw_body="")

        client = TdaiGatewayClient(self.base_url, timeout=2)
        result = client.health()

        self.assertEqual(result, {})

    def test_non_object_json_success_response_is_rejected(self) -> None:
        self._set_gateway_response({}, raw_body='["not", "an", "object"]')

        client = TdaiGatewayClient(self.base_url, timeout=2)

        with self.assertRaises(TdaiGatewayError) as caught:
            client.health()

        self.assertEqual(caught.exception.status_code, 200)
        self.assertEqual(caught.exception.response, ["not", "an", "object"])
        self.assertIn("Expected JSON object", str(caught.exception))
        self.assertIn("HTTP 200", str(caught.exception))

    def test_redirect_response_is_not_followed(self) -> None:
        self._set_gateway_response({}, status=302, headers={"Location": "/redirected"})

        client = TdaiGatewayClient(self.base_url, api_key="secret-token", timeout=2)

        with self.assertRaises(TdaiGatewayError) as caught:
            client.recall("query", "dify-conv-1")

        self.assertEqual(caught.exception.status_code, 302)
        self.assertEqual(len(self._gateway_requests()), 1)

    def test_from_credentials_uses_default_timeout_for_non_positive_values(self) -> None:
        zero_timeout_client = TdaiGatewayClient.from_credentials(
            {"gateway_url": self.base_url, "gateway_timeout_seconds": "0"}
        )
        negative_timeout_client = TdaiGatewayClient.from_credentials(
            {"gateway_url": self.base_url, "gateway_timeout_seconds": "-1"}
        )

        self.assertEqual(zero_timeout_client.timeout, 10)
        self.assertEqual(negative_timeout_client.timeout, 10)

    def test_from_credentials_accepts_missing_credentials(self) -> None:
        client = TdaiGatewayClient.from_credentials(None)

        self.assertEqual(client.base_url, "http://127.0.0.1:8420")
        self.assertEqual(client.api_key, "")
        self.assertEqual(client.timeout, 10)

    def test_capture_rejects_empty_content_without_gateway_request(self) -> None:
        client = TdaiGatewayClient(self.base_url, timeout=2)

        with self.assertRaises(TdaiGatewayError):
            client.capture("", "assistant reply", "dify-conv-1")
        with self.assertRaises(TdaiGatewayError):
            client.capture("user message", "", "dify-conv-1")
        with self.assertRaises(TdaiGatewayError):
            client.capture("   ", "assistant reply", "dify-conv-1")
        with self.assertRaises(TdaiGatewayError):
            client.capture("user message", "   ", "dify-conv-1")
        with self.assertRaises(TdaiGatewayError):
            client.capture(None, "assistant reply", "dify-conv-1")  # type: ignore[arg-type]
        with self.assertRaises(TdaiGatewayError):
            client.capture("user message", None, "dify-conv-1")  # type: ignore[arg-type]
        with self.assertRaises(TdaiGatewayError):
            client.capture(42, "assistant reply", "dify-conv-1")  # type: ignore[arg-type]

        self.assertEqual(self._gateway_requests(), [])

    def test_capture_posts_json_on_success(self) -> None:
        self._set_gateway_response({"l0_recorded": 1, "scheduler_notified": True})

        client = TdaiGatewayClient(self.base_url, timeout=2)
        result = client.capture(
            "remember this",
            "stored",
            "dify-conv-1",
            session_id="dify-session-id",
            user_id="user-1",
        )

        self.assertEqual(result["l0_recorded"], 1)
        requests = self._gateway_requests()
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0]["path"], "/capture")
        self.assertEqual(
            requests[0]["body"],
            {
                "user_content": "remember this",
                "assistant_content": "stored",
                "session_key": "dify-conv-1",
                "session_id": "dify-session-id",
                "user_id": "user-1",
            },
        )

    def test_search_and_session_methods_post_expected_payloads(self) -> None:
        client = TdaiGatewayClient(self.base_url, timeout=2)

        self._set_gateway_response({"results": "memory", "total": 1, "strategy": "keyword"})
        memory_result = client.search_memories("remember", limit=99, type_filter="fact", scene="dev")

        self._set_gateway_response({"total": 3, "conversations": ["conv-1"]})
        conversation_result = client.search_conversations("thread", limit=0, session_key="dify-conv-1")

        self._set_gateway_response({"flushed": True})
        session_result = client.end_session("dify-conv-1", user_id="user-1")

        self.assertEqual(memory_result["results"], "memory")
        self.assertEqual(conversation_result["total"], 3)
        self.assertEqual(session_result["flushed"], True)
        requests = self._gateway_requests()
        self.assertEqual([request["path"] for request in requests], ["/search/memories", "/search/conversations", "/session/end"])
        self.assertEqual(requests[0]["body"], {"query": "remember", "limit": 50, "type": "fact", "scene": "dev"})
        self.assertEqual(requests[1]["body"], {"query": "thread", "limit": 1, "session_key": "dify-conv-1"})
        self.assertEqual(requests[2]["body"], {"session_key": "dify-conv-1", "user_id": "user-1"})

    def test_session_key_validation_rejects_empty_values(self) -> None:
        client = TdaiGatewayClient(self.base_url, timeout=2)

        with self.assertRaises(TdaiGatewayError):
            client.recall("query", "")
        with self.assertRaises(TdaiGatewayError):
            client.capture("user", "assistant", " ")
        with self.assertRaises(TdaiGatewayError):
            client.end_session("")

        self.assertEqual(self._gateway_requests(), [])

    def test_search_memories_rejects_invalid_limit(self) -> None:
        client = TdaiGatewayClient(self.base_url, timeout=2)

        with self.assertRaises(TdaiGatewayError):
            client.search_memories("query", limit="bad")

    def test_rejects_unsupported_gateway_url_scheme(self) -> None:
        with self.assertRaises(TdaiGatewayError):
            TdaiGatewayClient("file:///tmp/gateway.sock")

    def test_rejects_api_key_over_remote_plain_http(self) -> None:
        with self.assertRaises(TdaiGatewayError):
            TdaiGatewayClient("http://example.com:8420", api_key="secret-token")
