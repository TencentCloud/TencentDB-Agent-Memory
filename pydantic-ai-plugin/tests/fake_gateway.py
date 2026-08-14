from __future__ import annotations

import json
import threading
import time
from collections import deque
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


@dataclass(frozen=True, slots=True)
class RecordedRequest:
    method: str
    path: str
    headers: dict[str, str]
    json: Any


@dataclass(frozen=True, slots=True)
class PlannedResponse:
    status: int
    body: Any
    delay: float
    content_type: str


class FakeGateway:
    def __init__(self) -> None:
        self.requests: list[RecordedRequest] = []
        self._responses: deque[PlannedResponse] = deque()
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def url(self) -> str:
        if self._server is None:
            raise RuntimeError("FakeGateway is not running")
        host, port = self._server.server_address
        return f"http://{host}:{port}"

    def enqueue(
        self,
        status: int,
        body: Any,
        *,
        delay: float = 0,
        content_type: str = "application/json",
    ) -> None:
        self._responses.append(
            PlannedResponse(status, body, delay, content_type)
        )

    def __enter__(self) -> "FakeGateway":
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                self._handle()

            def do_POST(self) -> None:
                self._handle()

            def _handle(self) -> None:
                length = int(self.headers.get("Content-Length", "0"))
                raw_request = self.rfile.read(length) if length else b""
                request_json = (
                    json.loads(raw_request.decode("utf-8"))
                    if raw_request
                    else None
                )
                owner.requests.append(
                    RecordedRequest(
                        method=self.command,
                        path=self.path,
                        headers={key: value for key, value in self.headers.items()},
                        json=request_json,
                    )
                )
                if not owner._responses:
                    response = PlannedResponse(
                        500,
                        {"error": "no response planned"},
                        0,
                        "application/json",
                    )
                else:
                    response = owner._responses.popleft()
                if response.delay:
                    time.sleep(response.delay)
                raw_response = (
                    response.body
                    if isinstance(response.body, bytes)
                    else json.dumps(
                        response.body, ensure_ascii=False
                    ).encode("utf-8")
                )
                self.send_response(response.status)
                self.send_header("Content-Type", response.content_type)
                self.send_header("Content-Length", str(len(raw_response)))
                self.end_headers()
                try:
                    self.wfile.write(raw_response)
                except (
                    BrokenPipeError,
                    ConnectionAbortedError,
                    ConnectionResetError,
                ):
                    pass

            def log_message(self, _format: str, *args: object) -> None:
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(
            target=lambda: self._server.serve_forever(poll_interval=0.01),
            name="fake-memory-gateway",
            daemon=True,
        )
        self._thread.start()
        return self

    def __exit__(self, *_args: object) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=2)
        self._server = None
        self._thread = None
