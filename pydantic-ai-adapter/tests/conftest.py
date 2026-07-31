from __future__ import annotations

import json
import threading
import time
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from queue import Queue
from typing import Any

import pytest


@dataclass
class RecordedRequest:
    method: str
    path: str
    headers: Mapping[str, str]
    body: dict[str, Any] | None


@dataclass
class GatewayStub:
    base_url: str
    requests: Queue[RecordedRequest]
    responses: Queue[tuple[int, object, str] | tuple[int, object, str, float]]


@pytest.fixture
def gateway_stub() -> Iterator[GatewayStub]:
    requests: Queue[RecordedRequest] = Queue()
    responses: Queue[
        tuple[int, object, str] | tuple[int, object, str, float]
    ] = Queue()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self._handle()

        def do_POST(self) -> None:
            self._handle()

        def _handle(self) -> None:
            length = int(self.headers.get("Content-Length", "0"))
            raw_request = self.rfile.read(length)
            body = json.loads(raw_request) if raw_request else None
            requests.put(
                RecordedRequest(
                    method=self.command,
                    path=self.path,
                    headers=dict(self.headers.items()),
                    body=body,
                )
            )

            response = responses.get_nowait()
            status, payload, content_type = response[:3]
            if len(response) == 4:
                time.sleep(response[3])
            if isinstance(payload, bytes):
                raw_response = payload
            elif isinstance(payload, str):
                raw_response = payload.encode("utf-8")
            else:
                raw_response = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(raw_response)))
            self.end_headers()
            try:
                self.wfile.write(raw_response)
            except BrokenPipeError:
                pass

        def log_message(self, format: str, *args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    try:
        yield GatewayStub(
            base_url=f"http://{host}:{port}",
            requests=requests,
            responses=responses,
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
