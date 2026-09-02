"""HTTP client for TDAI Gateway."""

from __future__ import annotations

import json
import time
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
from typing import Any, Dict, Optional

try:
    from .base import (
        TdaiAdapter,
        RecallResult,
        CaptureResult,
        SearchResult,
        HealthStatus,
    )
    from .errors import TdaiError, TdaiConnectionError, TdaiAuthError, TdaiRateLimitError
except ImportError:
    from base import (  # type: ignore
        TdaiAdapter,
        RecallResult,
        CaptureResult,
        SearchResult,
        HealthStatus,
    )
    from errors import TdaiError, TdaiConnectionError, TdaiAuthError, TdaiRateLimitError  # type: ignore


class TdaiHttpClient(TdaiAdapter):
    """Reference adapter implementation using HTTP Gateway.

    This is the standard adapter for platforms that communicate
    with the TDAI Gateway over HTTP.
    """

    def __init__(
        self,
        gateway_url: str = "http://127.0.0.1:8420",
        api_key: str = "",
        timeout: float = 30.0,
        max_retries: int = 3,
        retry_backoff: float = 1.0,
    ):
        self._gateway_url = gateway_url.rstrip("/")
        self._api_key = api_key
        self._timeout = timeout
        self._max_retries = max_retries
        self._retry_backoff = retry_backoff

    def _headers(self) -> Dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self._api_key:
            h["Authorization"] = f"Bearer {self._api_key}"
        return h

    def _request(
        self, method: str, path: str, body: Optional[dict] = None
    ) -> Dict[str, Any]:
        url = f"{self._gateway_url}{path}"
        data = json.dumps(body).encode() if body else None
        headers = self._headers()

        last_err: Optional[Exception] = None
        for attempt in range(self._max_retries):
            try:
                req = Request(url, data=data, headers=headers, method=method)
                with urlopen(req, timeout=self._timeout) as resp:
                    return json.loads(resp.read().decode())
            except HTTPError as e:
                if e.code == 401:
                    raise TdaiAuthError()
                if e.code == 429:
                    raise TdaiRateLimitError()
                last_err = e
                if e.code >= 500 and attempt < self._max_retries - 1:
                    time.sleep(self._retry_backoff * (2**attempt))
                    continue
                try:
                    err_body = json.loads(e.read().decode())
                    raise TdaiError(err_body.get("error", str(e)), e.code)
                except (json.JSONDecodeError, AttributeError):
                    raise TdaiError(str(e), e.code)
            except URLError as e:
                last_err = e
                if attempt < self._max_retries - 1:
                    time.sleep(self._retry_backoff * (2**attempt))
                    continue

        raise TdaiConnectionError(str(last_err))

    def health(self) -> HealthStatus:
        r = self._request("GET", "/health")
        return HealthStatus(
            status=r.get("status", "unknown"),
            version=r.get("version", ""),
            uptime=r.get("uptime", 0),
            stores=r.get("stores"),
        )

    def recall(self, query: str, session_key: str, **kwargs) -> RecallResult:
        body: Dict[str, Any] = {"query": query, "session_key": session_key}
        if "user_id" in kwargs:
            body["user_id"] = kwargs["user_id"]
        r = self._request("POST", "/recall", body)
        return RecallResult(
            context=r.get("context", ""),
            strategy=r.get("strategy", ""),
            memory_count=r.get("memory_count", 0),
        )

    def capture(
        self,
        user_content: str,
        assistant_content: str,
        session_key: str,
        **kwargs,
    ) -> CaptureResult:
        body: Dict[str, Any] = {
            "user_content": user_content,
            "assistant_content": assistant_content,
            "session_key": session_key,
        }
        for k in ("session_id", "user_id", "messages"):
            if k in kwargs:
                body[k] = kwargs[k]
        r = self._request("POST", "/capture", body)
        return CaptureResult(
            l0_recorded=r.get("l0_recorded", 0),
            scheduler_notified=r.get("scheduler_notified", False),
        )

    def search_memories(self, query: str, **kwargs) -> SearchResult:
        body: Dict[str, Any] = {"query": query}
        for k in ("limit", "type", "scene"):
            if k in kwargs:
                body[k] = kwargs[k]
        r = self._request("POST", "/search/memories", body)
        return SearchResult(
            results=r.get("results", ""),
            total=r.get("total", 0),
            strategy=r.get("strategy", ""),
        )

    def search_conversations(self, query: str, **kwargs) -> SearchResult:
        body: Dict[str, Any] = {"query": query}
        for k in ("limit", "session_key"):
            if k in kwargs:
                body[k] = kwargs[k]
        r = self._request("POST", "/search/conversations", body)
        return SearchResult(
            results=r.get("results", ""),
            total=r.get("total", 0),
        )

    def end_session(self, session_key: str) -> bool:
        r = self._request("POST", "/session/end", {"session_key": session_key})
        return r.get("flushed", False)

    def destroy(self) -> None:
        pass
