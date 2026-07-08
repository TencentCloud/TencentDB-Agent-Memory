"""memory-tencentdb HTTP client for Dify plugin.

Routes Dify tool calls to the standalone Gateway HTTP sidecar.
Reuses the same Gateway endpoints as the Hermes provider.

Gateway endpoints:
    POST /search/memories        → L1 memory search
    POST /search/conversations   → L0 conversation search
    POST /recall                 → auto-recall (prefetch)
    POST /capture                → turn capture (sync_turn)
    POST /session/end            → session flush
    GET  /health                 → health check

All methods are synchronous — designed to be called from Dify's
synchronous tool execution flow. Timeouts are kept short (≤20s)
so tool calls surface errors quickly rather than blocking the agent.
"""

from __future__ import annotations

import json
import logging
import urllib.request
import urllib.error
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 10
SEARCH_TIMEOUT = 20
CAPTURE_TIMEOUT = 15


class MemoryTencentdbClient:
    """HTTP client for the memory-tencentdb Gateway sidecar."""

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:8420",
        timeout: int = DEFAULT_TIMEOUT,
        api_key: Optional[str] = None,
    ):
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._api_key = api_key

    def _headers(self, *, content_type: bool) -> Dict[str, str]:
        headers: Dict[str, str] = {}
        if content_type:
            headers["Content-Type"] = "application/json"
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        return headers

    def _post(self, path: str, body: Dict[str, Any], timeout: Optional[int] = None) -> Dict[str, Any]:
        url = f"{self._base_url}{path}"
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            url, data=data,
            headers=self._headers(content_type=True),
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout or self._timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body_text = ""
            try:
                body_text = e.read().decode("utf-8", errors="replace")
            except Exception:
                pass
            logger.warning(f"memory-tencentdb Gateway {path} HTTP {e.code}: {body_text[:300]}")
            raise
        except Exception as e:
            logger.debug(f"memory-tencentdb Gateway {path} failed: {e}")
            raise

    def search_memories(self, query: str, limit: int = 5, type_filter: str = "", scene: str = "") -> Dict[str, Any]:
        body: Dict[str, Any] = {"query": query, "limit": limit}
        if type_filter:
            body["type"] = type_filter
        if scene:
            body["scene"] = scene
        return self._post("/search/memories", body, timeout=SEARCH_TIMEOUT)

    def search_conversations(self, query: str, limit: int = 5, session_key: str = "") -> Dict[str, Any]:
        body: Dict[str, Any] = {"query": query, "limit": limit}
        if session_key:
            body["session_key"] = session_key
        return self._post("/search/conversations", body, timeout=SEARCH_TIMEOUT)

    def recall(self, query: str, session_key: str) -> Dict[str, Any]:
        return self._post("/recall", {
            "query": query,
            "session_key": session_key,
        }, timeout=SEARCH_TIMEOUT)

    def capture(
        self,
        user_content: str,
        assistant_content: str,
        session_key: str,
        session_id: str = "",
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {
            "user_content": user_content,
            "assistant_content": assistant_content,
            "session_key": session_key,
        }
        if session_id:
            body["session_id"] = session_id
        return self._post("/capture", body, timeout=CAPTURE_TIMEOUT)

    def end_session(self, session_key: str) -> Dict[str, Any]:
        return self._post("/session/end", {"session_key": session_key})

    def health(self, timeout: int = 3) -> Dict[str, Any]:
        url = f"{self._base_url}/health"
        req = urllib.request.Request(url, headers=self._headers(content_type=False), method="GET")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            logger.debug(f"memory-tencentdb Gateway health check failed: {e}")
            raise
