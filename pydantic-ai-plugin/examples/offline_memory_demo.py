from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from pydantic_ai import Agent, ModelResponse, TextPart, models
from pydantic_ai.models.function import FunctionModel

from memory_tencentdb_pydantic_ai import (
    GatewayClient,
    TencentDBMemoryAgent,
)


class OfflineGateway:
    def __init__(self, events: list[str]) -> None:
        self._events = events
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def url(self) -> str:
        if self._server is None:
            raise RuntimeError("OfflineGateway is not running")
        host, port = self._server.server_address
        return f"http://{host}:{port}"

    def __enter__(self) -> "OfflineGateway":
        events = self._events

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", "0"))
                if length:
                    self.rfile.read(length)

                if self.path == "/recall":
                    events.append("recall")
                    body: dict[str, Any] = {
                        "context": (
                            "The demo user prefers sugar-free coffee."
                        ),
                        "memory_count": 1,
                    }
                elif self.path == "/capture":
                    events.append("capture")
                    body = {
                        "l0_recorded": 1,
                        "scheduler_notified": True,
                    }
                elif self.path == "/session/end":
                    events.append("session_end")
                    body = {"flushed": True}
                else:
                    body = {"error": "unexpected route"}

                encoded = json.dumps(body).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def log_message(self, _format: str, *args: object) -> None:
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(
            target=lambda: self._server.serve_forever(poll_interval=0.01),
            name="offline-memory-gateway",
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


def main() -> None:
    models.ALLOW_MODEL_REQUESTS = False
    events: list[str] = []

    def offline_model(
        _messages: list[Any],
        _info: Any,
    ) -> ModelResponse:
        events.append("agent")
        return ModelResponse(
            parts=[TextPart("I remembered your preference.")]
        )

    with OfflineGateway(events) as gateway:
        memory_agent = TencentDBMemoryAgent(
            Agent(FunctionModel(offline_model)),
            GatewayClient(gateway.url),
        )
        result = memory_agent.run_sync(
            "I prefer sugar-free coffee.",
            user_id="demo-user",
            session_id="offline-demo",
        )
        flushed = memory_agent.end_session_sync(
            user_id="demo-user",
            session_id="offline-demo",
        )

    expected = ["recall", "agent", "capture", "session_end"]
    if events != expected or not flushed:
        raise RuntimeError(
            f"offline lifecycle mismatch: events={events!r}, "
            f"flushed={flushed!r}"
        )

    print(result.output)
    print(" -> ".join(events))


if __name__ == "__main__":
    main()
