"""Dependency-free HTTP client for the TencentDB Agent Memory Gateway."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

DEFAULT_GATEWAY_URL = "http://127.0.0.1:8420"
DEFAULT_TIMEOUT_SECONDS = 10.0


class TdaiGatewayError(RuntimeError):
    """Raised when a Gateway request fails."""


def _env(name: str, fallback: str = "") -> str:
    return os.environ.get(name, fallback).strip()


def default_gateway_url() -> str:
    return (
        _env("TDAI_GATEWAY_URL")
        or _env("MEMORY_TENCENTDB_GATEWAY_URL")
        or DEFAULT_GATEWAY_URL
    ).rstrip("/")


def default_gateway_api_key() -> str:
    return _env("TDAI_GATEWAY_API_KEY") or _env("MEMORY_TENCENTDB_GATEWAY_API_KEY")


def default_timeout_seconds() -> float:
    raw = _env("TDAI_GATEWAY_TIMEOUT_SECONDS") or _env("TDAI_ADAPTER_TIMEOUT_SECONDS")
    if not raw:
        return DEFAULT_TIMEOUT_SECONDS
    try:
        parsed = float(raw)
    except ValueError:
        return DEFAULT_TIMEOUT_SECONDS
    return parsed if parsed > 0 else DEFAULT_TIMEOUT_SECONDS


@dataclass(slots=True)
class TdaiGatewayClient:
    """HTTP client for Gateway routes used by platform adapters."""

    base_url: str = ""
    api_key: str = ""
    timeout_seconds: float = 0

    def __post_init__(self) -> None:
        if not self.base_url:
            self.base_url = default_gateway_url()
        self.base_url = self.base_url.rstrip("/")
        if not self.api_key:
            self.api_key = default_gateway_api_key()
        if not self.timeout_seconds:
            self.timeout_seconds = default_timeout_seconds()

    def post(self, route: str, payload: dict[str, Any]) -> dict[str, Any]:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        request = urllib.request.Request(
            f"{self.base_url}{route}",
            data=body,
            headers=headers,
            method="POST",
        )

        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                text = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            error_body = exc.read().decode("utf-8", errors="replace")
            raise TdaiGatewayError(f"{route} returned HTTP {exc.code}: {error_body[:300]}") from exc
        except urllib.error.URLError as exc:
            raise TdaiGatewayError(f"{route} request failed: {exc.reason}") from exc
        except TimeoutError as exc:
            raise TdaiGatewayError(f"{route} request timed out") from exc
        except OSError as exc:
            raise TdaiGatewayError(f"{route} request failed: {exc}") from exc

        if not text:
            return {}
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as exc:
            raise TdaiGatewayError(f"{route} returned invalid JSON: {text[:300]}") from exc
        return parsed if isinstance(parsed, dict) else {"data": parsed}

    def recall(self, *, query: str, session_key: str, user_id: str | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "query": query,
            "session_key": session_key,
        }
        if user_id:
            payload["user_id"] = user_id
        return self.post("/recall", payload)

    def capture(
        self,
        *,
        user_content: str,
        assistant_content: str,
        session_key: str,
        session_id: str | None = None,
        user_id: str | None = None,
        messages: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "user_content": user_content,
            "assistant_content": assistant_content,
            "session_key": session_key,
        }
        if session_id:
            payload["session_id"] = session_id
        if user_id:
            payload["user_id"] = user_id
        payload["messages"] = messages or [
            {"role": "user", "content": user_content},
            {"role": "assistant", "content": assistant_content},
        ]
        return self.post("/capture", payload)

    def search_memories(self, *, query: str, limit: int | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {"query": query}
        if limit is not None:
            payload["limit"] = limit
        return self.post("/search/memories", payload)

    def search_conversations(
        self,
        *,
        query: str,
        limit: int | None = None,
        session_key: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"query": query}
        if limit is not None:
            payload["limit"] = limit
        if session_key:
            payload["session_key"] = session_key
        return self.post("/search/conversations", payload)

    def end_session(self, *, session_key: str, user_id: str | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {"session_key": session_key}
        if user_id:
            payload["user_id"] = user_id
        return self.post("/session/end", payload)
