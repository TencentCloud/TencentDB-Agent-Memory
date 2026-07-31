"""Asynchronous client for the TDAI HTTP Gateway."""

from __future__ import annotations

import asyncio
import json
from typing import Any, Protocol, runtime_checkable
from urllib import error, parse, request


class TdaiGatewayError(RuntimeError):
    """A safe, structured error raised for Gateway request failures."""

    def __init__(
        self,
        path: str,
        message: str,
        *,
        status: int | None = None,
        response_body: str | None = None,
    ) -> None:
        self.path = path
        self.status = status
        self.response_body = response_body

        status_text = f" (HTTP {status})" if status is not None else ""
        super().__init__(f"Gateway request to {path} failed{status_text}: {message}")


@runtime_checkable
class GatewayClientProtocol(Protocol):
    """Protocol implemented by Gateway clients used by the adapter."""

    async def health(self) -> dict[str, Any]:
        """Return Gateway health information."""

    async def recall(
        self,
        query: str,
        session_key: str,
        user_id: str = "",
    ) -> dict[str, Any]:
        """Recall relevant memory for a query."""

    async def capture(
        self,
        user_content: str,
        assistant_content: str,
        session_key: str,
        session_id: str = "",
        user_id: str = "",
    ) -> dict[str, Any]:
        """Capture a completed interaction."""

    async def search_memories(
        self,
        query: str,
        limit: int = 5,
        type_filter: str = "",
        scene: str = "",
    ) -> dict[str, Any]:
        """Search stored memories."""

    async def search_conversations(
        self,
        query: str,
        limit: int = 5,
        session_key: str = "",
    ) -> dict[str, Any]:
        """Search captured conversations."""

    async def end_session(
        self,
        session_key: str,
        user_id: str = "",
    ) -> dict[str, Any]:
        """Finalize a Gateway session."""


class TdaiGatewayClient:
    """Small dependency-free async client for the Gateway HTTP API."""

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:8420",
        *,
        timeout: float = 10.0,
        api_key: str | None = None,
    ) -> None:
        if timeout <= 0:
            raise ValueError("timeout must be greater than zero")

        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._api_key = (api_key or "").strip() or None

    async def health(self) -> dict[str, Any]:
        return await self._request("GET", "/health")

    async def recall(
        self,
        query: str,
        session_key: str,
        user_id: str = "",
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"query": query, "session_key": session_key}
        if user_id:
            body["user_id"] = user_id
        return await self._request("POST", "/recall", body=body)

    async def capture(
        self,
        user_content: str,
        assistant_content: str,
        session_key: str,
        session_id: str = "",
        user_id: str = "",
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
        return await self._request("POST", "/capture", body=body)

    async def search_memories(
        self,
        query: str,
        limit: int = 5,
        type_filter: str = "",
        scene: str = "",
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"query": query, "limit": limit}
        if type_filter:
            body["type"] = type_filter
        if scene:
            body["scene"] = scene
        return await self._request("POST", "/search/memories", body=body)

    async def search_conversations(
        self,
        query: str,
        limit: int = 5,
        session_key: str = "",
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"query": query, "limit": limit}
        if session_key:
            body["session_key"] = session_key
        return await self._request("POST", "/search/conversations", body=body)

    async def end_session(
        self,
        session_key: str,
        user_id: str = "",
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"session_key": session_key}
        if user_id:
            body["user_id"] = user_id
        return await self._request("POST", "/session/end", body=body)

    async def _request(
        self,
        method: str,
        path: str,
        *,
        query: dict[str, str] | None = None,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return await asyncio.to_thread(
            self._request_sync,
            method,
            path,
            query,
            body,
        )

    def _request_sync(
        self,
        method: str,
        path: str,
        query: dict[str, str] | None,
        body: dict[str, Any] | None,
    ) -> dict[str, Any]:
        url = f"{self._base_url}{path}"
        if query:
            url = f"{url}?{parse.urlencode(query)}"

        headers = {"Accept": "application/json"}
        payload = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            payload = json.dumps(body).encode("utf-8")
        if self._api_key is not None:
            headers["Authorization"] = f"Bearer {self._api_key}"

        gateway_request = request.Request(
            url,
            data=payload,
            headers=headers,
            method=method,
        )

        try:
            with request.urlopen(gateway_request, timeout=self._timeout) as response:
                raw_body = response.read()
        except error.HTTPError as exc:
            response_body = exc.read(500).decode("utf-8", errors="replace")
            raise TdaiGatewayError(
                path,
                "the server returned an error response",
                status=exc.code,
                response_body=response_body,
            ) from exc
        except (error.URLError, TimeoutError, OSError) as exc:
            raise TdaiGatewayError(path, "the request could not be completed") from exc

        try:
            result = json.loads(raw_body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise TdaiGatewayError(path, "the server returned invalid JSON") from exc

        if not isinstance(result, dict):
            raise TdaiGatewayError(path, "the server returned a non-object JSON response")
        return result
