from __future__ import annotations

from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
from typing import Any, Iterator
import unittest

from memory_tencentdb_gateway import TdaiGatewayClient, TdaiGatewayError


class _Handler(BaseHTTPRequestHandler):
    requests: list[dict[str, Any]] = []
    status = 200
    response: Any = {"status": "ok"}

    def do_GET(self) -> None:
        self._handle(None)

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length)) if length else None
        self._handle(body)

    def _handle(self, body: Any) -> None:
        type(self).requests.append(
            {
                "method": self.command,
                "path": self.path,
                "body": body,
                "authorization": self.headers.get("Authorization"),
            }
        )
        payload = json.dumps(type(self).response).encode("utf-8")
        self.send_response(type(self).status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_: Any) -> None:
        return


@contextmanager
def gateway(response: Any, *, status: int = 200) -> Iterator[tuple[str, type[_Handler]]]:
    handler = type("TestHandler", (_Handler,), {})
    handler.requests = []
    handler.status = status
    handler.response = response
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", handler
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


class TdaiGatewayClientTests(unittest.TestCase):
    def test_maps_recall_auth_and_identity(self) -> None:
        with gateway({"context": "prefers concise answers"}) as (url, handler):
            client = TdaiGatewayClient(url, api_key=" secret ")
            response = client.recall("style", "crewai:demo", user_id="alice")

        self.assertEqual(response["context"], "prefers concise answers")
        self.assertEqual(
            handler.requests,
            [
                {
                    "method": "POST",
                    "path": "/recall",
                    "body": {
                        "query": "style",
                        "session_key": "crewai:demo",
                        "user_id": "alice",
                    },
                    "authorization": "Bearer secret",
                }
            ],
        )

    def test_maps_capture_and_clamps_search_limit(self) -> None:
        with gateway({"ok": True}) as (url, handler):
            client = TdaiGatewayClient(url)
            client.capture("task", "result", "crewai:demo", session_id="run-1")
            client.search_memories("query", limit=999)

        self.assertEqual(handler.requests[0]["path"], "/capture")
        self.assertEqual(handler.requests[0]["body"]["session_id"], "run-1")
        self.assertEqual(handler.requests[1]["body"]["limit"], 20)

    def test_raises_typed_http_error(self) -> None:
        with gateway({"error": "denied"}, status=401) as (url, _):
            client = TdaiGatewayClient(url)
            with self.assertRaises(TdaiGatewayError) as raised:
                client.health()

        self.assertEqual(raised.exception.status, 401)
        self.assertEqual(raised.exception.path, "/health")
        self.assertIn("denied", raised.exception.response_body or "")

    def test_rejects_credentials_in_gateway_url(self) -> None:
        with self.assertRaisesRegex(ValueError, "api_key"):
            TdaiGatewayClient("http://user:pass@127.0.0.1:8420")


if __name__ == "__main__":
    unittest.main()
