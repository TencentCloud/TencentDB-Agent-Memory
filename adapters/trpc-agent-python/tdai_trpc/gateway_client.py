"""Async HTTP client for the TencentDB Agent Memory memory-core gateway.

Implements the gateway routes consumed by this adapter:

- ``GET  /health``
- ``POST /capture``             (turn capture, L0)
- ``POST /search/memories``     (long-term memory search)
- ``POST /search/conversations``(session-scoped conversation search)
- ``POST /session/end``         (flush short-term session state)

Request/response shapes mirror the official trpc-agent-go ``memory/tencentdb``
adapter (v1.11.1) which targets the same gateway.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

import httpx

_DEFAULT_TIMEOUT = 5.0


class GatewayError(RuntimeError):
    """Raised when the TencentDB Agent Memory gateway returns an error."""


@dataclass
class GatewayMessage:
    """One transcript message sent to /capture."""

    role: str
    content: str
    timestamp: int  # Unix seconds
    id: str = ""

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "role": self.role,
            "content": self.content,
            "timestamp": self.timestamp,
        }
        if self.id:
            payload["id"] = self.id
        return payload


@dataclass
class CaptureRequest:
    """Payload for POST /capture."""

    user_content: str
    assistant_content: str
    session_key: str
    messages: list[GatewayMessage] = field(default_factory=list)
    session_id: str = ""
    user_id: str = ""

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "user_content": self.user_content,
            "assistant_content": self.assistant_content,
            "session_key": self.session_key,
            "messages": [m.to_dict() for m in self.messages],
        }
        if self.session_id:
            payload["session_id"] = self.session_id
        if self.user_id:
            payload["user_id"] = self.user_id
        return payload


@dataclass
class SearchResult:
    """Normalized search results returned by the search paths."""

    results: str = ""
    total: int = 0


@dataclass
class HealthStatus:
    status: str = ""
    version: str = ""


class MemoryGatewayClient:
    """Thin async client over the memory-core gateway HTTP API.

    Args:
        gateway_url: Base URL, e.g. ``http://127.0.0.1:8420``.
        api_key: Optional bearer key; required when the gateway is started
            with ``TDAI_GATEWAY_API_KEY``.
        timeout: Per-request timeout in seconds.
        client: Optional pre-configured ``httpx.AsyncClient`` (tests inject
            a client bound to a fake gateway here).
    """

    def __init__(
        self,
        gateway_url: str = "http://127.0.0.1:8420",
        api_key: str = "",
        timeout: float = _DEFAULT_TIMEOUT,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._base_url = gateway_url.rstrip("/")
        self._api_key = api_key
        self._timeout = timeout
        self._client = client or httpx.AsyncClient(timeout=timeout)
        self._owns_client = client is None

    @property
    def base_url(self) -> str:
        return self._base_url

    async def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        headers: dict[str, str] = {}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        try:
            response = await self._client.post(
                f"{self._base_url}{path}", json=payload, headers=headers
            )
        except httpx.HTTPError as exc:
            raise GatewayError(f"gateway request failed: {path}: {exc}") from exc
        if response.status_code >= 400:
            raise GatewayError(
                f"gateway returned {response.status_code} for {path}: {response.text[:512]}"
            )
        return response.json()

    async def health(self) -> HealthStatus:
        try:
            response = await self._client.get(f"{self._base_url}/health")
        except httpx.HTTPError as exc:
            raise GatewayError(f"gateway health check failed: {exc}") from exc
        if response.status_code >= 400:
            raise GatewayError(f"gateway health returned {response.status_code}")
        data = response.json()
        return HealthStatus(status=data.get("status", ""), version=data.get("version", ""))

    async def capture(self, request: CaptureRequest) -> dict[str, Any]:
        return await self._post("/capture", request.to_dict())

    async def search_memories(
        self, query: str, limit: int = 10, user_id: str = ""
    ) -> SearchResult:
        payload: dict[str, Any] = {"query": query, "limit": limit}
        if user_id:
            payload["user_id"] = user_id
        data = await self._post("/search/memories", payload)
        return SearchResult(results=data.get("results", ""), total=data.get("total", 0))

    async def search_conversations(
        self, query: str, session_key: str = "", limit: int = 10, user_id: str = ""
    ) -> SearchResult:
        payload: dict[str, Any] = {"query": query, "limit": limit}
        if session_key:
            payload["session_key"] = session_key
        if user_id:
            payload["user_id"] = user_id
        data = await self._post("/search/conversations", payload)
        return SearchResult(results=data.get("results", ""), total=data.get("total", 0))

    async def end_session(self, session_key: str, user_id: str = "") -> bool:
        payload: dict[str, Any] = {"session_key": session_key}
        if user_id:
            payload["user_id"] = user_id
        data = await self._post("/session/end", payload)
        return bool(data.get("flushed", False))

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def __aenter__(self) -> "MemoryGatewayClient":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()


def default_session_key(app_name: str, user_id: str, session_id: str) -> str:
    """Build the default gateway session_key.

    Mirrors the trpc-agent-go adapter: urlsafe-base64(app):urlsafe-base64(user):
    urlsafe-base64(session). Avoids collisions across app/user/session ids
    without assuming delimiter-free values.
    """

    import base64

    def enc(value: str) -> str:
        return base64.urlsafe_b64encode(value.encode("utf-8")).rstrip(b"=").decode("ascii")

    return ":".join(enc(v) for v in (app_name, user_id, session_id))


def now_ts() -> int:
    return int(time.time())
