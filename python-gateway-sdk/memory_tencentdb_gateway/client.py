"""Dependency-free HTTP client for the TencentDB Agent Memory Gateway."""

from __future__ import annotations

import json
from typing import Any
import urllib.error
import urllib.parse
import urllib.request


class TdaiGatewayError(RuntimeError):
    """A typed Gateway transport, protocol, or HTTP error."""

    def __init__(
        self,
        message: str,
        *,
        path: str,
        status: int | None = None,
        response_body: str | None = None,
    ) -> None:
        super().__init__(message)
        self.path = path
        self.status = status
        self.response_body = response_body


class TdaiGatewayClient:
    """Small synchronous client that mirrors the public Gateway routes."""

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:8420",
        *,
        api_key: str | None = None,
        timeout: float = 10.0,
    ) -> None:
        self._base_url = _validate_base_url(base_url)
        self._api_key = (api_key or "").strip() or None
        if timeout <= 0:
            raise ValueError("timeout must be greater than zero")
        self._timeout = timeout

    def health(self, *, timeout: float = 3.0) -> dict[str, Any]:
        return self._request("GET", "/health", timeout=timeout)

    def recall(
        self,
        query: str,
        session_key: str,
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"query": query, "session_key": session_key}
        if user_id:
            body["user_id"] = user_id
        return self._request("POST", "/recall", body)

    def capture(
        self,
        user_content: str,
        assistant_content: str,
        session_key: str,
        *,
        session_id: str | None = None,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "user_content": user_content,
            "assistant_content": assistant_content,
            "session_key": session_key,
        }
        if session_id:
            body["session_id"] = session_id
        if user_id:
            body["user_id"] = user_id
        return self._request("POST", "/capture", body)

    def search_memories(self, query: str, *, limit: int = 5) -> dict[str, Any]:
        return self._request(
            "POST",
            "/search/memories",
            {"query": query, "limit": _clamp_limit(limit)},
        )

    def search_conversations(
        self,
        query: str,
        *,
        limit: int = 5,
        session_key: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"query": query, "limit": _clamp_limit(limit)}
        if session_key:
            body["session_key"] = session_key
        return self._request("POST", "/search/conversations", body)

    def end_session(
        self,
        session_key: str,
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"session_key": session_key}
        if user_id:
            body["user_id"] = user_id
        return self._request("POST", "/session/end", body)

    def _request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        payload = None if body is None else json.dumps(body).encode("utf-8")
        headers = {"Accept": "application/json"}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"

        request = urllib.request.Request(
            f"{self._base_url}{path}",
            data=payload,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(
                request,
                timeout=timeout or self._timeout,
            ) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as error:
            response_body = error.read().decode("utf-8", errors="replace")[:2_000]
            raise TdaiGatewayError(
                f"Gateway {path} returned HTTP {error.code}",
                path=path,
                status=error.code,
                response_body=response_body,
            ) from error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise TdaiGatewayError(
                f"Gateway {path} is unavailable: {error}",
                path=path,
            ) from error

        try:
            result = json.loads(raw)
        except json.JSONDecodeError as error:
            raise TdaiGatewayError(
                f"Gateway {path} returned invalid JSON",
                path=path,
                response_body=raw[:2_000],
            ) from error
        if not isinstance(result, dict):
            raise TdaiGatewayError(
                f"Gateway {path} returned a non-object response",
                path=path,
                response_body=raw[:2_000],
            )
        return result


def _validate_base_url(value: str) -> str:
    candidate = value.strip().rstrip("/")
    parsed = urllib.parse.urlsplit(candidate)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("gateway base URL must be an absolute http(s) URL")
    if parsed.username or parsed.password:
        raise ValueError("gateway credentials must use api_key, not URL userinfo")
    if parsed.query or parsed.fragment:
        raise ValueError("gateway base URL must not contain a query or fragment")
    return candidate


def _clamp_limit(value: int) -> int:
    return max(1, min(int(value), 20))
