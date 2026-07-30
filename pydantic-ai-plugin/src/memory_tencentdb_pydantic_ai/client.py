from __future__ import annotations

import asyncio
import json
import time
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import urlsplit

from .errors import (
    GatewayConnectionError,
    GatewayHTTPError,
    GatewayResponseError,
)

JsonObject = dict[str, Any]
ExpectedType = type[Any] | tuple[type[Any], ...]


def _validate_base_url(base_url: str) -> str:
    clean_url = base_url.strip().rstrip("/")
    parsed = urlsplit(clean_url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("base_url must use http or https")
    if not parsed.hostname:
        raise ValueError("base_url must include a host")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("base_url must not include credentials")
    if parsed.query or parsed.fragment:
        raise ValueError("base_url must not include a query or fragment")
    try:
        parsed.port
    except ValueError as exc:
        raise ValueError("base_url contains an invalid port") from exc
    return clean_url


def _require_fields(
    operation: str,
    payload: JsonObject,
    fields: dict[str, ExpectedType],
) -> JsonObject:
    for field, expected_type in fields.items():
        if field not in payload:
            raise GatewayResponseError(operation, f"missing field {field!r}")
        if not isinstance(payload[field], expected_type):
            expected_name = (
                " or ".join(item.__name__ for item in expected_type)
                if isinstance(expected_type, tuple)
                else expected_type.__name__
            )
            raise GatewayResponseError(
                operation,
                f"field {field!r} must be {expected_name}",
            )
    return payload


class GatewayClient:
    def __init__(
        self,
        base_url: str = "http://127.0.0.1:8420",
        *,
        api_key: str | None = None,
        timeout: float = 10.0,
        retries: int = 1,
        retry_delay: float = 0.1,
    ) -> None:
        if timeout <= 0:
            raise ValueError("timeout must be greater than zero")
        if retries < 0:
            raise ValueError("retries must not be negative")
        if retry_delay < 0:
            raise ValueError("retry_delay must not be negative")

        self._base_url = _validate_base_url(base_url)
        self._api_key = (api_key or "").strip() or None
        self._timeout = timeout
        self._retries = retries
        self._retry_delay = retry_delay

    def __repr__(self) -> str:
        return (
            f"GatewayClient(base_url={self._base_url!r}, "
            f"authenticated={self._api_key is not None})"
        )

    def _headers(self, *, has_body: bool) -> dict[str, str]:
        headers: dict[str, str] = {"Accept": "application/json"}
        if has_body:
            headers["Content-Type"] = "application/json"
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        return headers

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: JsonObject | None,
        operation: str,
        safe_to_retry: bool,
    ) -> JsonObject:
        encoded_body = (
            json.dumps(body, ensure_ascii=False).encode("utf-8")
            if body is not None
            else None
        )
        attempts = self._retries + 1 if safe_to_retry else 1

        for attempt in range(attempts):
            request = urllib.request.Request(
                f"{self._base_url}{path}",
                data=encoded_body,
                headers=self._headers(has_body=body is not None),
                method=method,
            )
            try:
                with urllib.request.urlopen(
                    request,
                    timeout=self._timeout,
                ) as response:
                    raw_response = response.read().decode("utf-8")
                try:
                    payload = json.loads(raw_response)
                except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                    raise GatewayResponseError(
                        operation,
                        "body is not valid UTF-8 JSON",
                    ) from exc
                if not isinstance(payload, dict):
                    raise GatewayResponseError(
                        operation,
                        "body must be a JSON object",
                    )
                return payload
            except urllib.error.HTTPError as exc:
                try:
                    body_text = exc.read().decode(
                        "utf-8",
                        errors="replace",
                    )
                except Exception:
                    body_text = ""
                error: GatewayConnectionError | GatewayHTTPError = (
                    GatewayHTTPError(operation, exc.code, body_text)
                )
                retryable = safe_to_retry and exc.code >= 500
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                reason = getattr(exc, "reason", exc)
                error = GatewayConnectionError(operation, str(reason))
                retryable = safe_to_retry

            if not retryable or attempt == attempts - 1:
                raise error
            if self._retry_delay:
                time.sleep(self._retry_delay * (2**attempt))

        raise AssertionError("request loop ended unexpectedly")

    def health(self) -> JsonObject:
        payload = self._request(
            "GET",
            "/health",
            body=None,
            operation="health",
            safe_to_retry=True,
        )
        return _require_fields(
            "health",
            payload,
            {
                "status": str,
                "version": str,
                "uptime": (int, float),
                "stores": dict,
            },
        )

    def recall(
        self,
        query: str,
        session_key: str,
        user_id: str,
    ) -> JsonObject:
        payload = self._request(
            "POST",
            "/recall",
            body={
                "query": query,
                "session_key": session_key,
                "user_id": user_id,
            },
            operation="recall",
            safe_to_retry=True,
        )
        return _require_fields("recall", payload, {"context": str})

    def capture(
        self,
        user_content: str,
        assistant_content: str,
        session_key: str,
        session_id: str,
        user_id: str,
    ) -> JsonObject:
        payload = self._request(
            "POST",
            "/capture",
            body={
                "user_content": user_content,
                "assistant_content": assistant_content,
                "session_key": session_key,
                "session_id": session_id,
                "user_id": user_id,
            },
            operation="capture",
            safe_to_retry=False,
        )
        return _require_fields(
            "capture",
            payload,
            {"l0_recorded": int, "scheduler_notified": bool},
        )

    def search_memories(
        self,
        query: str,
        limit: int = 5,
        memory_type: str | None = None,
        scene: str | None = None,
    ) -> JsonObject:
        body: JsonObject = {"query": query, "limit": limit}
        if memory_type:
            body["type"] = memory_type
        if scene:
            body["scene"] = scene
        payload = self._request(
            "POST",
            "/search/memories",
            body=body,
            operation="memory search",
            safe_to_retry=True,
        )
        return _require_fields(
            "memory search",
            payload,
            {"results": str, "total": int, "strategy": str},
        )

    def search_conversations(
        self,
        query: str,
        limit: int = 5,
        session_key: str | None = None,
    ) -> JsonObject:
        body: JsonObject = {"query": query, "limit": limit}
        if session_key:
            body["session_key"] = session_key
        payload = self._request(
            "POST",
            "/search/conversations",
            body=body,
            operation="conversation search",
            safe_to_retry=True,
        )
        return _require_fields(
            "conversation search",
            payload,
            {"results": str, "total": int},
        )

    def end_session(
        self,
        session_key: str,
        user_id: str,
    ) -> JsonObject:
        payload = self._request(
            "POST",
            "/session/end",
            body={"session_key": session_key, "user_id": user_id},
            operation="session end",
            safe_to_retry=True,
        )
        return _require_fields("session end", payload, {"flushed": bool})

    async def ahealth(self) -> JsonObject:
        return await asyncio.to_thread(self.health)

    async def arecall(
        self,
        query: str,
        session_key: str,
        user_id: str,
    ) -> JsonObject:
        return await asyncio.to_thread(
            self.recall,
            query,
            session_key,
            user_id,
        )

    async def acapture(
        self,
        user_content: str,
        assistant_content: str,
        session_key: str,
        session_id: str,
        user_id: str,
    ) -> JsonObject:
        return await asyncio.to_thread(
            self.capture,
            user_content,
            assistant_content,
            session_key,
            session_id,
            user_id,
        )

    async def asearch_memories(
        self,
        query: str,
        limit: int = 5,
        memory_type: str | None = None,
        scene: str | None = None,
    ) -> JsonObject:
        return await asyncio.to_thread(
            self.search_memories,
            query,
            limit,
            memory_type,
            scene,
        )

    async def asearch_conversations(
        self,
        query: str,
        limit: int = 5,
        session_key: str | None = None,
    ) -> JsonObject:
        return await asyncio.to_thread(
            self.search_conversations,
            query,
            limit,
            session_key,
        )

    async def aend_session(
        self,
        session_key: str,
        user_id: str,
    ) -> JsonObject:
        return await asyncio.to_thread(
            self.end_session,
            session_key,
            user_id,
        )
