"""Minimal sanitized OpenAI-compatible probe for Cursor protocol reconnaissance.

The service intentionally does not call an upstream model. It records request
shape after redaction and returns deterministic mock responses for connectivity
and wire-format testing.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import time
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_LOG = ROOT / "proxy-inbound" / "probe.ndjson"

SECRET_HEADERS = {
    "authorization",
    "cookie",
    "proxy-authorization",
    "set-cookie",
    "x-api-key",
    "api-key",
}
SAFE_HEADERS = {
    "accept",
    "accept-encoding",
    "content-encoding",
    "content-type",
    "origin",
    "referer",
    "user-agent",
}
IDENTITY_HINTS = (
    "session",
    "conversation",
    "generation",
    "request-id",
    "request_id",
    "trace",
    "user-id",
    "user_id",
    "machine",
    "device",
)
IDENTITY_KEYS = {"user", "account", "account_id", "owner"}
CONTENT_KEYS = {
    "content",
    "text",
    "prompt",
    "query",
    "code",
    "file_content",
}


def stable_hash(value: str) -> str:
    digest = hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()
    return f"sha256:{digest[:16]}"


def summarize_content(value: Any) -> dict[str, Any]:
    serialized = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return {
        "_redacted": True,
        "type": type(value).__name__,
        "length": len(serialized),
        "hash": stable_hash(serialized),
    }


def sanitize_json(value: Any, key: str = "") -> Any:
    lowered = key.lower()
    if lowered in CONTENT_KEYS:
        return summarize_content(value)
    if (
        lowered in IDENTITY_KEYS or any(hint in lowered for hint in IDENTITY_HINTS)
    ) and isinstance(value, (str, int)):
        return stable_hash(str(value))
    if isinstance(value, dict):
        return {str(k): sanitize_json(v, str(k)) for k, v in value.items()}
    if isinstance(value, list):
        return [sanitize_json(item, key) for item in value]
    return value


def sanitize_path(path: str) -> str:
    parsed = urlsplit(path)
    query = urlencode(
        [(name, stable_hash(value)) for name, value in parse_qsl(parsed.query, keep_blank_values=True)]
    )
    return urlunsplit(("", "", parsed.path, query, parsed.fragment))


class ProbeHandler(BaseHTTPRequestHandler):
    server_version = "CursorReconProbe/1.0"

    def log_message(self, format: str, *args: Any) -> None:
        return

    @property
    def log_path(self) -> Path:
        return self.server.log_path  # type: ignore[attr-defined]

    def sanitized_headers(self) -> dict[str, str]:
        result: dict[str, str] = {}
        for name, value in self.headers.items():
            lowered = name.lower()
            if lowered in SECRET_HEADERS:
                sanitized = "[REDACTED]"
            elif lowered in SAFE_HEADERS:
                sanitized = value
            elif any(hint in lowered for hint in IDENTITY_HINTS) or lowered.startswith("x-"):
                sanitized = stable_hash(value)
            else:
                sanitized = "[PRESENT]"
            result[name] = sanitized
        return result

    def read_body(self) -> tuple[bytes, Any]:
        length = int(self.headers.get("content-length", "0") or "0")
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return raw, None
        try:
            parsed = json.loads(raw.decode("utf-8"))
            return raw, parsed
        except (UnicodeDecodeError, json.JSONDecodeError):
            return raw, {
                "_redacted": True,
                "type": "binary-or-non-json",
                "length": len(raw),
                "hash": stable_hash(raw.hex()),
            }

    def record(self, parsed_body: Any) -> None:
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        record = {
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "client_ip": stable_hash(self.client_address[0]),
            "method": self.command,
            "path": sanitize_path(self.path),
            "http_version": self.request_version,
            "headers": self.sanitized_headers(),
            "body": sanitize_json(parsed_body),
        }
        with self.log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        self.record(None)
        path = urlsplit(self.path).path.rstrip("/")
        if path in {"", "/health"}:
            self.send_json(HTTPStatus.OK, {"ok": True, "service": "cursor-recon-probe"})
            return
        if path in {"/models", "/v1/models"}:
            self.send_json(
                HTTPStatus.OK,
                {
                    "object": "list",
                    "data": [
                        {
                            "id": "cursor-recon-probe",
                            "object": "model",
                            "created": 0,
                            "owned_by": "local-recon",
                        }
                    ],
                },
            )
            return
        self.send_json(HTTPStatus.NOT_FOUND, {"error": {"message": "probe route not found"}})

    def do_POST(self) -> None:
        _raw, parsed = self.read_body()
        self.record(parsed)
        path = urlsplit(self.path).path.rstrip("/")
        if path.endswith("/chat/completions"):
            self.handle_chat_completions(parsed if isinstance(parsed, dict) else {})
            return
        if path.endswith("/responses"):
            self.handle_responses(parsed if isinstance(parsed, dict) else {})
            return
        self.send_json(
            HTTPStatus.OK,
            {"ok": True, "probe": True, "received_path": sanitize_path(self.path)},
        )

    def handle_chat_completions(self, body: dict[str, Any]) -> None:
        completion_id = f"chatcmpl-probe-{uuid.uuid4().hex[:12]}"
        model = str(body.get("model") or "cursor-recon-probe")
        if body.get("stream"):
            self.send_response(HTTPStatus.OK)
            self.send_header("content-type", "text/event-stream")
            self.send_header("cache-control", "no-cache")
            # This probe emits a finite SSE response. Closing the HTTP/1.1
            # connection after [DONE] prevents strict clients from waiting for
            # another frame when no Content-Length is present.
            self.send_header("connection", "close")
            self.end_headers()
            messages = body.get("messages", [])
            has_options_marker = "CURSOR_RECON_ASK_OPTIONS" in json.dumps(
                messages, ensure_ascii=False
            )
            has_options_result = any(
                isinstance(message, dict)
                and message.get("role") == "tool"
                and message.get("name") == "AskQuestion"
                and message.get("tool_call_id") == "cursor_probe_option_limit"
                for message in messages
            )
            is_options_probe = has_options_marker and not has_options_result
            if is_options_probe:
                arguments = {
                    "title": "Cursor UI option limit test",
                    "questions": [
                        {
                            "id": "option_limit",
                            "prompt": "How many numbered options are visible?",
                            "options": [
                                {"id": f"option_{index}", "label": f"Option {index}"}
                                for index in range(1, 11)
                            ],
                            "allow_multiple": False,
                        }
                    ],
                }
                chunks = [
                    {
                        "id": completion_id,
                        "object": "chat.completion.chunk",
                        "created": int(time.time()),
                        "model": model,
                        "choices": [
                            {
                                "index": 0,
                                "delta": {
                                    "role": "assistant",
                                    "tool_calls": [
                                        {
                                            "index": 0,
                                            "id": "cursor_probe_option_limit",
                                            "type": "function",
                                            "function": {
                                                "name": "AskQuestion",
                                                "arguments": json.dumps(arguments),
                                            },
                                        }
                                    ],
                                },
                            }
                        ],
                    },
                    {
                        "id": completion_id,
                        "object": "chat.completion.chunk",
                        "created": int(time.time()),
                        "model": model,
                        "choices": [
                            {"index": 0, "delta": {}, "finish_reason": "tool_calls"}
                        ],
                    },
                ]
            else:
                chunks = [
                {
                    "id": completion_id,
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": model,
                    "choices": [{"index": 0, "delta": {"role": "assistant", "content": "PROBE_OK"}}],
                },
                {
                    "id": completion_id,
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": model,
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                },
                ]
            for chunk in chunks:
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode("utf-8"))
                self.wfile.flush()
            if (body.get("stream_options") or {}).get("include_usage"):
                usage_chunk = {
                    "id": completion_id,
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": model,
                    "choices": [],
                    "usage": {
                        "prompt_tokens": 1,
                        "completion_tokens": 1,
                        "total_tokens": 2,
                    },
                }
                self.wfile.write(
                    f"data: {json.dumps(usage_chunk)}\n\n".encode("utf-8")
                )
                self.wfile.flush()
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            self.close_connection = True
            return
        self.send_json(
            HTTPStatus.OK,
            {
                "id": completion_id,
                "object": "chat.completion",
                "created": int(time.time()),
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "PROBE_OK"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            },
        )

    def handle_responses(self, body: dict[str, Any]) -> None:
        response_id = f"resp_probe_{uuid.uuid4().hex[:12]}"
        self.send_json(
            HTTPStatus.OK,
            {
                "id": response_id,
                "object": "response",
                "created_at": int(time.time()),
                "status": "completed",
                "model": str(body.get("model") or "cursor-recon-probe"),
                "output": [
                    {
                        "id": f"msg_probe_{uuid.uuid4().hex[:12]}",
                        "type": "message",
                        "role": "assistant",
                        "status": "completed",
                        "content": [{"type": "output_text", "text": "PROBE_OK", "annotations": []}],
                    }
                ],
                "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
            },
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8096)
    parser.add_argument("--log", type=Path, default=DEFAULT_LOG)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), ProbeHandler)
    server.log_path = args.log.resolve()  # type: ignore[attr-defined]
    print(f"Cursor recon probe listening on http://{args.host}:{args.port}", flush=True)
    print(f"Sanitized log: {server.log_path}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
