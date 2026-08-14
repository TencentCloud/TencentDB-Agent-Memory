"""Small, dependency-free client for the existing TencentDB Memory Gateway."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


class GatewayError(RuntimeError):
    """A transport, protocol, or Gateway response failure."""


@dataclass(frozen=True)
class TencentDBMemoryGatewayClient:
    """Typed async facade over the Gateway routes used by Agent Framework."""

    base_url: str = "http://127.0.0.1:8420"
    api_key: str | None = None
    timeout: float = 10.0
    allow_remote: bool = False

    def __post_init__(self) -> None:
        parsed = urlsplit(self.base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("base_url must be an absolute http(s) URL")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("base_url must not contain credentials, a query, or a fragment")
        loopback = parsed.hostname.lower() in {"127.0.0.1", "::1", "localhost"}
        if not loopback and not self.allow_remote:
            raise ValueError("remote Gateway URLs require allow_remote=True")
        if self.timeout <= 0:
            raise ValueError("timeout must be greater than zero")
        object.__setattr__(self, "base_url", self.base_url.rstrip("/"))

    async def health(self) -> dict[str, Any]:
        return await self._request("GET", "/health")

    async def recall(
        self, *, query: str, session_key: str, user_id: str | None = None
    ) -> dict[str, Any]:
        return await self._request(
            "POST", "/recall",
            self._without_none({"query": query, "session_key": session_key, "user_id": user_id}),
        )

    async def capture(
        self, *, user_content: str, assistant_content: str, session_key: str,
        session_id: str | None = None, user_id: str | None = None,
        messages: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        return await self._request(
            "POST", "/capture",
            self._without_none({
                "user_content": user_content, "assistant_content": assistant_content,
                "session_key": session_key, "session_id": session_id,
                "user_id": user_id, "messages": messages,
            }),
        )

    async def search_memories(self, *, query: str, limit: int = 5) -> dict[str, Any]:
        return await self._request("POST", "/search/memories", {"query": query, "limit": limit})

    async def search_conversations(
        self, *, query: str, session_key: str | None = None, limit: int = 5
    ) -> dict[str, Any]:
        return await self._request(
            "POST", "/search/conversations",
            self._without_none({"query": query, "session_key": session_key, "limit": limit}),
        )

    async def end_session(
        self, *, session_key: str, user_id: str | None = None
    ) -> dict[str, Any]:
        return await self._request(
            "POST", "/session/end",
            self._without_none({"session_key": session_key, "user_id": user_id}),
        )

    async def _request(
        self, method: str, path: str, payload: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        return await asyncio.to_thread(self._request_sync, method, path, payload)

    def _request_sync(
        self, method: str, path: str, payload: dict[str, Any] | None
    ) -> dict[str, Any]:
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        headers = {"Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        request = Request(f"{self.base_url}{path}", data=body, headers=headers, method=method)
        try:
            with urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise GatewayError(f"Gateway returned HTTP {exc.code}: {detail}") from exc
        except (URLError, TimeoutError, OSError) as exc:
            raise GatewayError(f"Gateway request failed: {exc}") from exc
        try:
            decoded = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise GatewayError("Gateway returned invalid JSON") from exc
        if not isinstance(decoded, dict):
            raise GatewayError("Gateway response must be a JSON object")
        return decoded

    @staticmethod
    def _without_none(payload: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in payload.items() if value is not None}
