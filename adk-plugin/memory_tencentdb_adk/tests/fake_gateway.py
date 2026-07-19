"""In-process fake of the TDAI Gateway for adapter tests.

Speaks just enough of the Gateway REST contract (``src/gateway/server.ts``)
to exercise the Python client and the ADK service without Node/pnpm:

- ``GET /health`` never requires auth.
- Every other route returns 401 unless the configured Bearer token matches
  (when a token is configured).
- ``POST /capture`` / ``/recall`` / ``/search/*`` / ``/session/end`` echo
  canned responses and record every request body for assertions.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Tuple


class FakeGateway:
    """Minimal Gateway double bound to an ephemeral loopback port."""

    def __init__(self, api_key: Optional[str] = None) -> None:
        self.api_key = api_key
        self.requests: List[Tuple[str, Dict[str, Any]]] = []
        self.responses: Dict[str, Any] = {
            "/recall": {"context": "", "strategy": "none", "memory_count": 0},
            "/capture": {"l0_recorded": 2, "scheduler_notified": True},
            "/search/memories": {"results": "", "total": 0, "strategy": "vector"},
            "/search/conversations": {"results": "", "total": 0},
            "/session/end": {"flushed": True},
        }
        self.status_overrides: Dict[str, int] = {}
        self._lock = threading.Lock()

        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:  # silence test output
                pass

            def _send(self, status: int, body: Dict[str, Any]) -> None:
                payload = json.dumps(body).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def _authorized(self) -> bool:
                if not fake.api_key:
                    return True
                header = self.headers.get("Authorization", "")
                return header == f"Bearer {fake.api_key}"

            def do_GET(self) -> None:
                if self.path == "/health":
                    self._send(200, {"status": "ok", "version": "test", "uptime": 1})
                    return
                self._send(404, {"error": f"Not found: GET {self.path}"})

            def do_POST(self) -> None:
                if not self._authorized():
                    self._send(401, {"error": "Unauthorized: invalid token"})
                    return
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length).decode("utf-8") if length else "{}"
                try:
                    body = json.loads(raw)
                except json.JSONDecodeError:
                    self._send(400, {"error": "Invalid JSON body"})
                    return
                with fake._lock:
                    fake.requests.append((self.path, body))
                    status = fake.status_overrides.get(self.path)
                    response = fake.responses.get(self.path)
                if status is not None:
                    self._send(status, {"error": f"forced {status}"})
                    return
                if response is None:
                    self._send(404, {"error": f"Not found: POST {self.path}"})
                    return
                self._send(200, response)

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    # -- lifecycle -----------------------------------------------------------

    def start(self) -> "FakeGateway":
        self._thread.start()
        return self

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)

    @property
    def base_url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    # -- assertion helpers -----------------------------------------------------

    def bodies(self, path: str) -> List[Dict[str, Any]]:
        with self._lock:
            return [body for p, body in self.requests if p == path]
