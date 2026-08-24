"""Capture Cursor HTTP flows as sanitized NDJSON.

No raw flow dump is written. Secrets are redacted, identity-like values are
replaced by stable hashes, and conversation content is reduced to metadata.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from mitmproxy import http


OUTPUT = Path(__file__).resolve().parent.parent / "ide-side" / "capture.ndjson"

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
CONTENT_KEYS = {
    "content",
    "text",
    "prompt",
    "query",
    "input",
    "output",
    "code",
    "file_content",
}


def stable_hash(value: str) -> str:
    digest = hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()
    return f"sha256:{digest[:16]}"


def content_summary(value: Any) -> dict[str, Any]:
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
        return content_summary(value)
    if any(hint in lowered for hint in IDENTITY_HINTS) and isinstance(value, (str, int)):
        return stable_hash(str(value))
    if isinstance(value, dict):
        return {str(k): sanitize_json(v, str(k)) for k, v in value.items()}
    if isinstance(value, list):
        return [sanitize_json(item, key) for item in value]
    return value


def sanitize_headers(headers: http.Headers) -> dict[str, str]:
    result: dict[str, str] = {}
    for name, value in headers.items(multi=True):
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


def sanitize_path(path: str) -> str:
    """Keep query parameter names while hashing every value."""
    parsed = urlsplit(path)
    query = urlencode(
        [(name, stable_hash(value)) for name, value in parse_qsl(parsed.query, keep_blank_values=True)]
    )
    return urlunsplit(("", "", parsed.path, query, parsed.fragment))


def parse_body(message: http.Message) -> Any:
    raw = message.raw_content or b""
    if not raw:
        return None
    content_type = message.headers.get("content-type", "")
    if "json" in content_type:
        try:
            return sanitize_json(json.loads(message.get_text(strict=False)))
        except (json.JSONDecodeError, UnicodeDecodeError):
            pass
    return {
        "_redacted": True,
        "content_type": content_type or "unknown",
        "length": len(raw),
        "hash": stable_hash(raw.hex()),
    }


def append_record(record: dict[str, Any]) -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")


def request(flow: http.HTTPFlow) -> None:
    """Write immediately so long-lived streaming RPC requests are captured."""
    request_message = flow.request
    append_record(
        {
            "event": "request",
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "flow_id": stable_hash(flow.id),
            "request": {
                "scheme": request_message.scheme,
                "host": request_message.pretty_host,
                "port": request_message.port,
                "method": request_message.method,
                "path": sanitize_path(request_message.path),
                "http_version": request_message.http_version,
                "headers": sanitize_headers(request_message.headers),
                "body": parse_body(request_message),
            },
        }
    )


def response(flow: http.HTTPFlow) -> None:
    request = flow.request
    response_message = flow.response
    append_record(
        {
            "event": "response",
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "flow_id": stable_hash(flow.id),
            "request": {
                "scheme": request.scheme,
                "host": request.pretty_host,
                "port": request.port,
                "method": request.method,
                "path": sanitize_path(request.path),
                "http_version": request.http_version,
                "headers": sanitize_headers(request.headers),
                "body": parse_body(request),
            },
            "response": {
                "status_code": response_message.status_code,
                "headers": sanitize_headers(response_message.headers),
                "body": parse_body(response_message),
            },
        }
    )


def error(flow: http.HTTPFlow) -> None:
    append_record(
        {
            "event": "error",
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "flow_id": stable_hash(flow.id),
            "request": {
                "scheme": flow.request.scheme,
                "host": flow.request.pretty_host,
                "port": flow.request.port,
                "method": flow.request.method,
                "path": sanitize_path(flow.request.path),
                "headers": sanitize_headers(flow.request.headers),
                "body": parse_body(flow.request),
            },
            "error": str(flow.error) if flow.error else "unknown",
        }
    )
