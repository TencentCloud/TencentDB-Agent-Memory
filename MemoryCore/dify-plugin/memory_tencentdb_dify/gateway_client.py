"""MemoryGatewayClient -- HTTP client for the TDAI Gateway.

Wraps all Gateway v3 API endpoints with timeout and error handling. This is
the Python counterpart to the TypeScript ``MemoryGatewayClient`` in
``src/adapters/sdk/gateway-client.ts``.

Features:
- v3 tenancy isolation (team_id / agent_id / user_id)
- Automatic v3 envelope unwrapping ({code, message, data})
- Configurable timeout per request
- No external dependencies (uses stdlib ``urllib.request``)
- Parallel recall (L1 + L3 + L2) via ``concurrent.futures``
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Dict, List, Optional, Tuple

from .types import (
    ConversationMessage,
    MemoryItem,
    PersonaContent,
    SceneEntry,
    TenancyConfig,
)

logger = logging.getLogger(__name__)

__all__ = ["MemoryGatewayClient"]

DEFAULT_TIMEOUT_MS = 10_000
DEFAULT_TENANCY: Dict[str, str] = {
    "team_id": "default",
    "agent_id": "default",
    "user_id": "default",
}


class GatewayError(Exception):
    """Raised when the Gateway returns a non-zero v3 envelope code or HTTP error."""


class MemoryGatewayClient:
    """HTTP client for the TDAI memory Gateway.

    This class mirrors the TypeScript ``MemoryGatewayClient`` and the Hermes
    ``MemoryTencentdbSdkClient``. It uses only the Python standard library so
    it can be vendored into any plugin without extra dependencies.

    Args:
        endpoint: Gateway base URL (e.g. ``http://127.0.0.1:8420``).
        api_key: Optional Bearer API key. When empty, ``"local"`` is sent so
            that a Gateway with auth disabled does not reject the request.
        service_id: Instance / service ID for multi-tenant routing.
        timeout_ms: Request timeout in milliseconds (default: 10000).
        reject_unauthorized: Whether to reject unauthorized TLS certs.
            Note: ``urllib`` does not expose a per-request TLS flag; this is
            respected by disabling cert verification globally when ``False``.
    """

    def __init__(
        self,
        endpoint: str,
        api_key: Optional[str] = None,
        service_id: str = "default",
        timeout_ms: int = DEFAULT_TIMEOUT_MS,
        reject_unauthorized: bool = True,
    ) -> None:
        self._endpoint = endpoint.rstrip("/")
        self._api_key = (api_key or "").strip() or None
        self._service_id = service_id or "default"
        self._timeout_ms = timeout_ms
        self._timeout_s = timeout_ms / 1000.0
        self._reject_unauthorized = reject_unauthorized

    # -- Properties ----------------------------------------------------------

    @property
    def endpoint(self) -> str:
        """The current Gateway endpoint URL."""
        return self._endpoint

    @property
    def timeout_ms(self) -> int:
        """The configured request timeout in milliseconds."""
        return self._timeout_ms

    # -- Private helpers ----------------------------------------------------

    def _build_headers(self, *, content_type: bool = False) -> Dict[str, str]:
        """Build HTTP headers for a Gateway request.

        Always sends a Bearer token: if ``api_key`` is configured use it,
        otherwise send ``"local"`` so the Gateway's auth parser does not
        reject the request (a Gateway with auth=disabled ignores the value).
        """
        headers: Dict[str, str] = {}
        if content_type:
            headers["Content-Type"] = "application/json"
        headers["Authorization"] = f"Bearer {self._api_key or 'local'}"
        headers["x-tdai-service-id"] = self._service_id
        return headers

    def _post(
        self,
        path: str,
        body: Dict[str, Any],
        timeout_ms: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Make a POST request to the Gateway and return the raw v3 envelope.

        Args:
            path: API path (e.g. ``/v3/atomic/search``).
            body: JSON-serializable request body.
            timeout_ms: Per-request timeout override in milliseconds.

        Returns:
            The full v3 envelope dict ``{code, message, data}``.

        Raises:
            GatewayError: If the HTTP status is not OK or the v3 code is non-zero.
        """
        url = f"{self._endpoint}{path}"
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            headers=self._build_headers(content_type=True),
            method="POST",
        )
        timeout_s = (timeout_ms / 1000.0) if timeout_ms is not None else self._timeout_s
        try:
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:  # noqa: S310
                raw = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body_text = ""
            try:
                body_text = e.read().decode("utf-8", errors="replace")
            except Exception:
                pass
            logger.warning(
                "Gateway %s returned %d: %s", path, e.code, body_text[:500],
            )
            raise GatewayError(
                f"Gateway {path} returned {e.code}: {body_text[:200]}"
            ) from e
        except urllib.error.URLError as e:
            logger.debug("Gateway %s failed: %s", path, e)
            raise GatewayError(f"Gateway {path} unreachable: {e}") from e
        except Exception as e:
            logger.debug("Gateway %s failed: %s", path, e)
            raise GatewayError(f"Gateway {path} request failed: {e}") from e

        return self._unwrap_v3(raw, path)

    def _get(
        self,
        path: str,
        timeout_ms: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Make a GET request to the Gateway.

        Args:
            path: API path (e.g. ``/health``).
            timeout_ms: Per-request timeout override in milliseconds.

        Returns:
            The parsed JSON response dict.

        Raises:
            GatewayError: If the HTTP status is not OK.
        """
        url = f"{self._endpoint}{path}"
        req = urllib.request.Request(
            url,
            headers=self._build_headers(content_type=False),
            method="GET",
        )
        timeout_s = (timeout_ms / 1000.0) if timeout_ms is not None else self._timeout_s
        try:
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:  # noqa: S310
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body_text = ""
            try:
                body_text = e.read().decode("utf-8", errors="replace")
            except Exception:
                pass
            logger.warning(
                "Gateway GET %s returned %d: %s", path, e.code, body_text[:500],
            )
            raise GatewayError(
                f"Gateway GET {path} returned {e.code}: {body_text[:200]}"
            ) from e
        except urllib.error.URLError as e:
            logger.debug("Gateway GET %s failed: %s", path, e)
            raise GatewayError(f"Gateway GET {path} unreachable: {e}") from e
        except Exception as e:
            logger.debug("Gateway GET %s failed: %s", path, e)
            raise GatewayError(f"Gateway GET {path} request failed: {e}") from e

    @staticmethod
    def _unwrap_v3(raw: Dict[str, Any], path: str) -> Dict[str, Any]:
        """Validate the v3 envelope ``{code, message, data}``.

        Returns the full envelope on success (code == 0). Raises
        :class:`GatewayError` when the code is non-zero so callers can
        distinguish protocol-level errors from empty results.
        """
        code = raw.get("code", -1)
        if code != 0:
            msg = raw.get("message", "unknown")
            logger.warning(
                "Gateway %s returned code=%d: %s", path, code, msg,
            )
            raise GatewayError(
                f"Gateway {path} error: code={code} message={msg}"
            )
        return raw

    @staticmethod
    def _merge_tenancy(tenancy: Optional[TenancyConfig]) -> Dict[str, str]:
        """Merge a partial :class:`TenancyConfig` with defaults."""
        return {
            "team_id": (tenancy or {}).get("team_id", DEFAULT_TENANCY["team_id"]),
            "agent_id": (tenancy or {}).get("agent_id", DEFAULT_TENANCY["agent_id"]),
            "user_id": (tenancy or {}).get("user_id", DEFAULT_TENANCY["user_id"]),
        }

    # -- Public API methods -------------------------------------------------

    def health(self, timeout_ms: int = 3_000) -> Dict[str, Any]:
        """Check if the Gateway is healthy.

        Returns a dict with a ``status`` key. On any failure, returns
        ``{"status": "unreachable"}`` rather than raising.
        """
        try:
            result = self._get("/health", timeout_ms=timeout_ms)
            if isinstance(result, dict) and "status" in result:
                return result
            # Some deployments wrap /health in the v3 envelope.
            if isinstance(result, dict) and "data" in result:
                data = result.get("data") or {}
                if isinstance(data, dict) and "status" in data:
                    return data
            return {"status": "ok"}
        except Exception:
            return {"status": "unreachable"}

    def recall(
        self,
        query: str,
        tenancy: Optional[TenancyConfig] = None,
        options: Optional[Dict[str, Any]] = None,
    ) -> Tuple[List[MemoryItem], Optional[PersonaContent], List[SceneEntry]]:
        """Recall memories (parallel L1 + L3 + L2 fetch).

        Performs three independent Gateway calls concurrently:

        * **L1** -- ``/v3/atomic/search`` for structured memories.
        * **L3** -- ``/v3/core/read`` for persona / user core.
        * **L2** -- ``/v3/scenario/ls`` for scene navigation.

        Each sub-request degrades gracefully: a failure in one layer does not
        affect the others. This mirrors the TypeScript ``Promise.allSettled``
        pattern.

        Args:
            query: The user's query text.
            tenancy: Tenancy identifiers for v3 isolation.
            options: Optional dict with ``max_results`` (int),
                ``include_persona`` (bool), ``include_scene_nav`` (bool).

        Returns:
            A tuple of ``(memories, persona, scenes)``.
        """
        t = self._merge_tenancy(tenancy)
        opts = options or {}
        max_results = int(opts.get("max_results", 5))
        include_persona = bool(opts.get("include_persona", True))
        include_scene_nav = bool(opts.get("include_scene_nav", True))

        memories: List[MemoryItem] = []
        persona: Optional[PersonaContent] = None
        scenes: List[SceneEntry] = []

        def _fetch_l1() -> None:
            nonlocal memories
            env = self._post("/v3/atomic/search", {
                "team_id": t["team_id"],
                "agent_id": t["agent_id"],
                "user_id": t["user_id"],
                "query": query,
                "limit": max_results,
            })
            data = env.get("data") or {}
            items = data.get("items") or []
            memories = [
                MemoryItem(
                    type=str(item.get("type", "unknown")),
                    content=str(item.get("content", "")),
                    score=item.get("score") if isinstance(item.get("score"), (int, float)) else None,
                    metadata=item,
                )
                for item in items
            ]

        def _fetch_l3() -> None:
            nonlocal persona
            env = self._post("/v3/core/read", {
                "team_id": t["team_id"],
                "agent_id": t["agent_id"],
                "user_id": t["user_id"],
            })
            data = env.get("data") or {}
            content = data.get("content") or ""
            if content:
                persona = PersonaContent(
                    content=str(content),
                    updated_at=data.get("updated_at"),
                )

        def _fetch_l2() -> None:
            nonlocal scenes
            env = self._post("/v3/scenario/ls", {
                "team_id": t["team_id"],
                "agent_id": t["agent_id"],
                "user_id": t["user_id"],
            })
            data = env.get("data") or {}
            entries = data.get("entries") or []
            scenes = [
                SceneEntry(
                    path=str(entry.get("path", "")),
                    summary=str(entry.get("summary")) if entry.get("summary") else None,
                    heat=entry.get("heat") if isinstance(entry.get("heat"), (int, float)) else None,
                )
                for entry in entries
            ]

        # Build the list of (label, callable) pairs for concurrent execution.
        # Each sub-request degrades gracefully via _safe_call, so a failure
        # in one layer is logged but does not abort the others.
        sub_requests: List[Tuple[str, Any]] = (
            [("l1", _fetch_l1)]
            + ([("l3", _fetch_l3)] if include_persona else [])
            + ([("l2", _fetch_l2)] if include_scene_nav else [])
        )

        with ThreadPoolExecutor(max_workers=len(sub_requests)) as pool:
            futures = {
                pool.submit(self._safe_call, fn): label
                for label, fn in sub_requests
            }
            for future in as_completed(futures):
                label = futures[future]
                try:
                    future.result()
                except Exception as e:
                    logger.debug("recall sub-request %s failed: %s", label, e)

        return memories, persona, scenes

    @staticmethod
    def _safe_call(fn: Any) -> None:
        """Execute a callable, swallowing exceptions for graceful degradation."""
        try:
            fn()
        except Exception:
            pass

    def capture(
        self,
        messages: List[ConversationMessage],
        session_id: str,
        tenancy: Optional[TenancyConfig] = None,
    ) -> Tuple[int, bool]:
        """Capture conversation messages (L0 recording).

        Args:
            messages: List of :class:`ConversationMessage` to record.
            session_id: Business-side session ID.
            tenancy: Tenancy identifiers for v3 isolation.

        Returns:
            A tuple of ``(captured_count, success)``. On failure, returns
            ``(0, False)`` without raising.
        """
        t = self._merge_tenancy(tenancy)
        try:
            env = self._post("/v3/conversation/add", {
                "team_id": t["team_id"],
                "agent_id": t["agent_id"],
                "user_id": t["user_id"],
                "session_id": session_id,
                "messages": [m.to_dict() if isinstance(m, ConversationMessage) else m for m in messages],
            })
            data = env.get("data") or {}
            captured = data.get("captured_count")
            return (
                int(captured) if isinstance(captured, (int, float)) else len(messages),
                True,
            )
        except Exception:
            return 0, False

    def search_memories(
        self,
        query: str,
        tenancy: Optional[TenancyConfig] = None,
        options: Optional[Dict[str, Any]] = None,
    ) -> Tuple[List[MemoryItem], int]:
        """Search L1 structured memories (``/v3/atomic/search``).

        Args:
            query: Search query text.
            tenancy: Tenancy identifiers for v3 isolation.
            options: Optional dict with ``limit`` (int) and ``type`` (str).

        Returns:
            A tuple of ``(items, total)``.
        """
        t = self._merge_tenancy(tenancy)
        opts = options or {}
        body: Dict[str, Any] = {
            "team_id": t["team_id"],
            "agent_id": t["agent_id"],
            "user_id": t["user_id"],
            "query": query,
            "limit": int(opts.get("limit", 5)),
        }
        if opts.get("type"):
            body["type"] = opts["type"]

        env = self._post("/v3/atomic/search", body)
        data = env.get("data") or {}
        items = data.get("items") or []
        result = [
            MemoryItem(
                type=str(item.get("type", "unknown")),
                content=str(item.get("content", "")),
                score=item.get("score") if isinstance(item.get("score"), (int, float)) else None,
                metadata=item,
            )
            for item in items
        ]
        total = data.get("total")
        return result, int(total) if isinstance(total, (int, float)) else len(result)

    def search_conversations(
        self,
        query: str,
        tenancy: Optional[TenancyConfig] = None,
        options: Optional[Dict[str, Any]] = None,
    ) -> Tuple[List[MemoryItem], int]:
        """Search L0 raw conversations (``/v3/conversation/search``).

        Args:
            query: Search query text.
            tenancy: Tenancy identifiers for v3 isolation.
            options: Optional dict with ``limit`` (int) and ``session_id`` (str).

        Returns:
            A tuple of ``(items, total)``.
        """
        t = self._merge_tenancy(tenancy)
        opts = options or {}
        body: Dict[str, Any] = {
            "team_id": t["team_id"],
            "agent_id": t["agent_id"],
            "user_id": t["user_id"],
            "query": query,
            "limit": int(opts.get("limit", 5)),
        }
        if opts.get("session_id"):
            body["session_id"] = opts["session_id"]

        env = self._post("/v3/conversation/search", body)
        data = env.get("data") or {}
        items = data.get("items") or []
        result = [
            MemoryItem(
                type=str(item.get("role", "conversation")),
                content=str(item.get("content", "")),
                timestamp=str(item["timestamp"]) if item.get("timestamp") else None,
                metadata=item,
            )
            for item in items
        ]
        total = data.get("total")
        return result, int(total) if isinstance(total, (int, float)) else len(result)

    def read_scene(
        self,
        path: str,
        tenancy: Optional[TenancyConfig] = None,
    ) -> str:
        """Read a scene block by path (``/v3/scenario/read``).

        Args:
            path: Scene file path (e.g. ``travel-plan.md``).
            tenancy: Tenancy identifiers for v3 isolation.

        Returns:
            The scene content text, or an empty string on failure.
        """
        t = self._merge_tenancy(tenancy)
        env = self._post("/v3/scenario/read", {
            "team_id": t["team_id"],
            "agent_id": t["agent_id"],
            "user_id": t["user_id"],
            "path": path,
        })
        data = env.get("data") or {}
        return str(data.get("content", ""))

    def update_endpoint(self, endpoint: str) -> None:
        """Update the endpoint URL (for reconnection scenarios)."""
        self._endpoint = endpoint.rstrip("/")

    def get_endpoint(self) -> str:
        """Get the current endpoint URL."""
        return self._endpoint
