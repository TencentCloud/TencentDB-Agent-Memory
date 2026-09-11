"""TdaiGatewayClient - HTTP client for TencentDB Agent Memory Gateway.

This module is the protocol boundary for the Dify plugin. It intentionally
uses only Python's standard library so tests can run without the Dify runtime
or additional HTTP dependencies.

It is not presented as a shared cross-platform SDK. Its job is narrower: be a
small, Python-native transport shim for the Dify plugin runtime while reusing
the existing Gateway API contract.

Design:
- Keep Gateway request/response field names identical to `src/gateway/types.ts`.
- Raise structured errors in the client; Dify tool classes decide how to
  degrade without blocking an agent workflow.

Usage:
    client = TdaiGatewayClient("http://127.0.0.1:8420", api_key="...")
    context = client.recall("query", "conversation-id")
"""

from __future__ import annotations

import json
import ssl
import urllib.error
import urllib.request
from ipaddress import ip_address
from typing import Any
from urllib.parse import urlparse


DEFAULT_GATEWAY_URL = "http://127.0.0.1:8420"
DEFAULT_TIMEOUT_SECONDS = 10
MAX_ERROR_BODY_BYTES = 65_536


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        raise urllib.error.HTTPError(req.full_url, code, msg, headers, fp)


class TdaiGatewayError(RuntimeError):
    """Gateway error with HTTP status and optional gateway error code.

    `response` stores the raw, untrusted Gateway response for internal
    debugging and must not be surfaced to agent users without sanitization.
    """

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        code: str | None = None,
        response: Any | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.response = response


class TdaiGatewayClient:
    """Small HTTP wrapper around the TDAI Gateway API."""

    def __init__(
        self,
        base_url: str = DEFAULT_GATEWAY_URL,
        *,
        api_key: str | None = None,
        timeout: int | float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self.base_url = (base_url or DEFAULT_GATEWAY_URL).strip().rstrip("/")
        parsed = urlparse(self.base_url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise TdaiGatewayError(f"Unsupported Gateway URL: {self.base_url}")
        self.api_key = (api_key or "").strip()
        self.timeout = _normalize_timeout(timeout)
        self._ssl_context = ssl.create_default_context()
        if self.api_key and parsed.scheme == "http" and not _is_loopback(parsed.hostname):
            raise TdaiGatewayError("Gateway API key requires HTTPS for non-local Gateway URLs")

    @classmethod
    def from_credentials(cls, credentials: dict[str, Any] | None = None) -> "TdaiGatewayClient":
        """Create a client from Dify provider credentials."""
        credentials = credentials or {}
        base_url = str(credentials.get("gateway_url") or DEFAULT_GATEWAY_URL).strip()
        return cls(
            base_url,
            api_key=str(credentials.get("gateway_api_key") or ""),
            timeout=_normalize_timeout(credentials.get("gateway_timeout_seconds")),
        )

    def health(self) -> dict[str, Any]:
        """Call `GET /health`."""
        return self._request("GET", "/health")

    def recall(self, query: str, session_key: str, *, user_id: str = "") -> dict[str, Any]:
        """Call `POST /recall`."""
        _require_non_empty_string(session_key, "session_key")
        body = {"query": query, "session_key": session_key}
        if user_id:
            body["user_id"] = user_id
        return self._request("POST", "/recall", body)

    def capture(
        self,
        user_content: str,
        assistant_content: str,
        session_key: str,
        *,
        session_id: str = "",
        user_id: str = "",
    ) -> dict[str, Any]:
        """Call `POST /capture`."""
        _require_non_empty_string(user_content, "user_content")
        _require_non_empty_string(assistant_content, "assistant_content")
        _require_non_empty_string(session_key, "session_key")
        body = {
            "user_content": user_content,
            "assistant_content": assistant_content,
            "session_key": session_key,
        }
        if session_id:
            body["session_id"] = session_id
        if user_id:
            body["user_id"] = user_id
        return self._request("POST", "/capture", body)

    def search_memories(
        self,
        query: str,
        *,
        limit: int = 5,
        type_filter: str = "",
        scene: str = "",
    ) -> dict[str, Any]:
        """Call `POST /search/memories`."""
        body: dict[str, Any] = {"query": query, "limit": _normalize_gateway_limit(limit)}
        if type_filter:
            # Field name is fixed by the Gateway API contract.
            body["type"] = type_filter
        if scene:
            body["scene"] = scene
        return self._request("POST", "/search/memories", body)

    def search_conversations(
        self,
        query: str,
        *,
        limit: int = 5,
        session_key: str = "",
    ) -> dict[str, Any]:
        """Call `POST /search/conversations`."""
        body: dict[str, Any] = {"query": query, "limit": _normalize_gateway_limit(limit)}
        if session_key:
            body["session_key"] = session_key
        return self._request("POST", "/search/conversations", body)

    def end_session(self, session_key: str, *, user_id: str = "") -> dict[str, Any]:
        """Call `POST /session/end`."""
        _require_non_empty_string(session_key, "session_key")
        body = {"session_key": session_key}
        if user_id:
            body["user_id"] = user_id
        return self._request("POST", "/session/end", body)

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        if not path.startswith("/"):
            raise TdaiGatewayError(f"path must start with '/', got: {path!r}")
        data = None
        headers: dict[str, str] = {}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            headers=headers,
            method=method,
        )
        try:
            opener = urllib.request.build_opener(
                _NoRedirectHandler(),
                urllib.request.HTTPSHandler(context=self._ssl_context),
            )
            with opener.open(request, timeout=self.timeout) as response:
                raw = response.read().decode("utf-8")
                content_type = response.headers.get("Content-Type", "")
                status_code = response.status
                if content_type and "json" not in content_type.lower():
                    raise TdaiGatewayError(
                        f"Unexpected Content-Type: {content_type or '(none)'}",
                        status_code=status_code,
                        response=raw,
                    )
                if not raw:
                    return {}
                try:
                    parsed = json.loads(raw)
                except json.JSONDecodeError as exc:
                    raise TdaiGatewayError(
                        f"Invalid JSON response: {exc}",
                        status_code=status_code,
                        response=raw,
                    ) from exc
                if not isinstance(parsed, dict):
                    raise TdaiGatewayError(
                        f"Expected JSON object response from Gateway (HTTP {status_code})",
                        status_code=status_code,
                        response=parsed,
                    )
                return parsed
        except urllib.error.HTTPError as exc:
            detail = self._read_error_body(exc)
            message = self._error_message(detail) or exc.reason or f"HTTP {exc.code}"
            raise TdaiGatewayError(
                str(message),
                status_code=exc.code,
                code=detail.get("code") if isinstance(detail, dict) else None,
                response=detail,
            ) from exc
        except TdaiGatewayError:
            raise
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            raise TdaiGatewayError(f"Gateway request failed: {exc}") from exc

    @staticmethod
    def _read_error_body(exc: urllib.error.HTTPError) -> Any:
        try:
            raw = exc.read(MAX_ERROR_BODY_BYTES).decode("utf-8", errors="replace")
        except Exception:
            return None
        if not raw:
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return raw

    @staticmethod
    def _error_message(detail: Any) -> str:
        if isinstance(detail, dict):
            for key in ("error", "message", "detail", "description"):
                if detail.get(key):
                    return _safe_error_snippet(str(detail[key]))
            return ""
        return _safe_error_snippet(str(detail or ""))


def _is_loopback(host: str | None) -> bool:
    if not host:
        return False
    if host.lower() == "localhost":
        return True
    try:
        return ip_address(host).is_loopback
    except ValueError:
        return False


def _normalize_timeout(value: int | float | str | None) -> float:
    try:
        timeout = float(value) if value not in (None, "") else DEFAULT_TIMEOUT_SECONDS
    except (TypeError, ValueError):
        return float(DEFAULT_TIMEOUT_SECONDS)
    if timeout <= 0:
        return float(DEFAULT_TIMEOUT_SECONDS)
    return timeout


def _safe_error_snippet(message: str) -> str:
    return message.splitlines()[0][:200]


def _require_non_empty_string(value: Any, name: str) -> None:
    if not isinstance(value, str):
        raise TdaiGatewayError(f"{name} must be a string, got {type(value).__name__}")
    stripped = value.strip()
    if not stripped:
        raise TdaiGatewayError(f"{name} must not be empty (value={value!r})")


def _normalize_gateway_limit(value: Any) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise TdaiGatewayError("limit must be an integer") from exc
    return max(1, min(50, parsed))
