"""TdaiGatewayClient — stdlib HTTP client for the memory-tencentdb Gateway.

Thin, dependency-free wrapper over the Gateway REST API
(``src/gateway/server.ts``). Mirrors the Hermes provider's
``MemoryTencentdbSdkClient`` so the two Python adapters stay easy to diff,
but raises a typed ``TdaiGatewayError`` instead of bare ``urllib`` errors
so callers (the ADK service) can degrade gracefully.

Thread-safe: no mutable state beyond configuration.
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "http://127.0.0.1:8420"
DEFAULT_TIMEOUT_SECS = 10.0


class TdaiGatewayError(RuntimeError):
    """Raised when the Gateway is unreachable or returns an error response.

    Attributes:
        status: HTTP status code when the Gateway answered with an error,
            ``None`` for transport-level failures (connection refused, DNS,
            timeout).
        detail: Response body (truncated) or underlying error message.
    """

    def __init__(self, message: str, *, status: Optional[int] = None, detail: str = "") -> None:
        super().__init__(message)
        self.status = status
        self.detail = detail


class TdaiGatewayClient:
    """HTTP client for the memory-tencentdb Gateway sidecar."""

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        *,
        api_key: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT_SECS,
    ) -> None:
        """Construct the client.

        Args:
            base_url: Gateway base URL (default ``http://127.0.0.1:8420``).
            api_key: Optional Bearer token. When non-empty, every request
                attaches ``Authorization: Bearer <api_key>``. When ``None``
                or blank, no auth header is sent — matching the Gateway's
                open legacy default. The Gateway enforces auth only when it
                is itself configured with ``TDAI_GATEWAY_API_KEY``.
            timeout: Default per-request timeout in seconds.
        """
        self._base_url = base_url.rstrip("/")
        # Strip whitespace defensively — env vars often pick up trailing
        # newlines from `echo` or YAML quoting; the Gateway compares the
        # Bearer token byte-for-byte.
        self._api_key = (api_key or "").strip() or None
        self._timeout = timeout

    @property
    def base_url(self) -> str:
        return self._base_url

    # -- transport ----------------------------------------------------------

    def _headers(self, *, content_type: bool) -> Dict[str, str]:
        headers: Dict[str, str] = {}
        if content_type:
            headers["Content-Type"] = "application/json"
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        return headers

    def _request(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
        timeout: Optional[float] = None,
    ) -> Dict[str, Any]:
        url = f"{self._base_url}{path}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(
            url,
            data=data,
            headers=self._headers(content_type=body is not None),
            method=method,
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout or self._timeout) as resp:
                raw = resp.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read().decode("utf-8", errors="replace")[:500]
            except Exception:  # pragma: no cover - best-effort diagnostics
                pass
            logger.warning("tdai gateway %s %s -> HTTP %d: %s", method, path, exc.code, detail)
            raise TdaiGatewayError(
                f"Gateway {method} {path} failed with HTTP {exc.code}",
                status=exc.code,
                detail=detail,
            ) from exc
        except Exception as exc:
            logger.debug("tdai gateway %s %s failed: %s", method, path, exc)
            raise TdaiGatewayError(
                f"Gateway {method} {path} unreachable: {exc}",
                detail=str(exc),
            ) from exc

        try:
            return json.loads(raw) if raw else {}
        except json.JSONDecodeError as exc:
            raise TdaiGatewayError(
                f"Gateway {method} {path} returned invalid JSON",
                detail=raw[:200],
            ) from exc

    # -- API methods ---------------------------------------------------------

    def health(self, timeout: float = 3.0) -> Dict[str, Any]:
        """``GET /health`` — cheap liveness probe (never requires auth)."""
        return self._request("GET", "/health", timeout=timeout)

    def is_healthy(self) -> bool:
        """True when the Gateway answers ``/health`` at all (ok or degraded)."""
        try:
            return bool(self.health().get("status"))
        except TdaiGatewayError:
            return False

    def recall(self, query: str, session_key: str, user_id: str = "") -> Dict[str, Any]:
        """``POST /recall`` — assembled prompt context for *query*.

        Returns ``{"context": str, "strategy": str | None, "memory_count": int}``.
        """
        body: Dict[str, Any] = {"query": query, "session_key": session_key}
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
        messages: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """``POST /capture`` — persist one completed turn (L0 write).

        Returns ``{"l0_recorded": int, "scheduler_notified": bool}``.
        """
        body: Dict[str, Any] = {
            "user_content": user_content,
            "assistant_content": assistant_content,
            "session_key": session_key,
        }
        if session_id:
            body["session_id"] = session_id
        if user_id:
            body["user_id"] = user_id
        if messages is not None:
            body["messages"] = messages
        return self._request("POST", "/capture", body)

    def search_memories(
        self,
        query: str,
        *,
        limit: Optional[int] = None,
        type: Optional[str] = None,
        scene: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /search/memories`` — L1/L2/L3 structured memory search.

        Returns ``{"results": str, "total": int, "strategy": str}``.
        """
        body: Dict[str, Any] = {"query": query}
        if limit is not None:
            body["limit"] = limit
        if type is not None:
            body["type"] = type
        if scene is not None:
            body["scene"] = scene
        return self._request("POST", "/search/memories", body)

    def search_conversations(
        self,
        query: str,
        *,
        limit: Optional[int] = None,
        session_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /search/conversations`` — raw L0 conversation search.

        Returns ``{"results": str, "total": int}``.
        """
        body: Dict[str, Any] = {"query": query}
        if limit is not None:
            body["limit"] = limit
        if session_key:
            body["session_key"] = session_key
        return self._request("POST", "/search/conversations", body)

    def session_end(self, session_key: str, user_id: str = "") -> Dict[str, Any]:
        """``POST /session/end`` — flush pending pipeline work for a session."""
        body: Dict[str, Any] = {"session_key": session_key}
        if user_id:
            body["user_id"] = user_id
        return self._request("POST", "/session/end", body)
