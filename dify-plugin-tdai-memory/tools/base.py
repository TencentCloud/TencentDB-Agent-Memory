"""Shared helpers for TencentDB Agent Memory Dify tools.

The Dify Tool classes should never leak Gateway exceptions into normal agent
flows. They convert failures into structured JSON payloads so a Dify workflow
can continue without memory instead of aborting the whole conversation.

Design:
- Keep validation and truncation local to the Dify adapter layer.
- Reuse `TdaiGatewayClient` for every HTTP call so auth/header behavior stays
  consistent across tools.

Usage:
    text = truncate_text(result["results"], 2000)
    yield self.create_json_message({"ok": True, "results": text})
"""

from __future__ import annotations

from typing import Any

from tools.client import TdaiGatewayClient, TdaiGatewayError


DEFAULT_SEARCH_LIMIT = 5
MAX_SEARCH_LIMIT = 50
DEFAULT_MAX_CHARS = 2000
MAX_CHARS_LIMIT = 20_000
MAX_ERROR_CHARS = 500
TEXT_TRUNCATED_MARKER = "\n\n[truncated]"
ERROR_TRUNCATED_MARKER = "\n[truncated]"


def truncate_text(text: str, max_chars: int | None = None) -> str:
    """Trim long Gateway text fields.

    The `[truncated]` marker is appended after the content limit so callers can
    distinguish a real suffix from adapter truncation.
    """
    try:
        limit = int(max_chars) if max_chars is not None else DEFAULT_MAX_CHARS
    except (TypeError, ValueError):
        limit = DEFAULT_MAX_CHARS
    if limit <= 0 or len(text) <= limit:
        return text
    return f"{text[:limit]}{TEXT_TRUNCATED_MARKER}"


def normalize_limit(
    value: Any,
    *,
    default: int = DEFAULT_SEARCH_LIMIT,
    minimum: int = 1,
    maximum: int = MAX_SEARCH_LIMIT,
) -> int:
    """Clamp user supplied search limits to protect the Gateway and prompt."""
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(maximum, parsed))


def build_error_payload(operation: str, error: Exception) -> dict[str, Any]:
    """Return a non-throwing tool payload for Gateway failures.

    Gateway details are reduced to status/code fields so Dify users do not see
    raw backend messages or credentials embedded in exception strings.
    """
    if isinstance(error, TdaiGatewayError):
        if error.status_code is not None:
            message = f"{operation} failed: Gateway returned HTTP {error.status_code}"
        else:
            message = f"{operation} failed: Gateway request failed"
    else:
        message = f"{operation} failed: {error.__class__.__name__}"
    if len(message) > MAX_ERROR_CHARS:
        message = f"{message[:MAX_ERROR_CHARS]}{ERROR_TRUNCATED_MARKER}"
    payload: dict[str, Any] = {
        "ok": False,
        "operation": operation,
        "error": message,
        "error_type": error.__class__.__name__,
    }
    if isinstance(error, TdaiGatewayError):
        if error.status_code is not None:
            payload["status_code"] = error.status_code
        if error.code:
            payload["code"] = error.code
    return payload


class TdaiToolMixin:
    """Common Dify Tool helpers backed by provider credentials."""

    def _client(self) -> TdaiGatewayClient:
        runtime = getattr(self, "runtime", None)
        if runtime is None:
            raise TdaiGatewayError("Tool runtime is not initialized; provider credentials unavailable")
        credentials = getattr(runtime, "credentials", {}) or {}
        if not credentials:
            raise TdaiGatewayError("Provider credentials are empty; configure Gateway settings")
        return TdaiGatewayClient.from_credentials(credentials)

    @staticmethod
    def _text(params: dict[str, Any], name: str, default: str = "") -> str:
        value = params.get(name, default)
        return str(value).strip() if value is not None else default

    @staticmethod
    def _max_chars(params: dict[str, Any]) -> int:
        return normalize_limit(
            params.get("max_chars"),
            default=DEFAULT_MAX_CHARS,
            minimum=0,
            maximum=MAX_CHARS_LIMIT,
        )
