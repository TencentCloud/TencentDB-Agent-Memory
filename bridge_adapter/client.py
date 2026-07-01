"""
TdaiHttpClient — httpx-based HTTP client for the TDAI Gateway.

Provides sync wrappers for all v2 REST API endpoints consumed by
the BridgeAdapter. Reads configuration from environment variables with
defaults for local standalone Gateway.

This is NOT a Gateway — it is an HTTP client that makes requests TO
the TDAI Gateway (an external process from the TDAI project).
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 30
DEFAULT_ENDPOINT = "http://127.0.0.1:8420"
DEFAULT_SERVICE_ID = "mem-rkgqhd5z"


class TdaiHttpClient:
    """HTTP client for TDAI Gateway v2 API.

    Wraps all Gateway REST endpoints. Sync-only (async wrappers are
    added at the BridgeAdapter level for offload_compact).
    """

    def __init__(
        self,
        endpoint: Optional[str] = None,
        api_key: Optional[str] = None,
        service_id: Optional[str] = None,
        timeout: int = DEFAULT_TIMEOUT,
    ):
        self._base_url = (endpoint or os.environ.get("TDAI_ENDPOINT") or DEFAULT_ENDPOINT).rstrip("/")
        self._api_key = api_key or os.environ.get("TDAI_API_KEY", "")
        self._service_id = service_id or os.environ.get("TDAI_SERVICE_ID", DEFAULT_SERVICE_ID)
        self._timeout = timeout
        self._headers = {
            "Authorization": f"Bearer {self._api_key}",
            "x-tdai-service-id": self._service_id,
            "Content-Type": "application/json",
        }

    def _post_sync(self, path: str, payload: Dict[str, Any]) -> httpx.Response:
        with httpx.Client(timeout=self._timeout) as cli:
            resp = cli.post(f"{self._base_url}{path}", json=payload, headers=self._headers)
            resp.raise_for_status()
            return resp

    async def _post_async(self, path: str, payload: Dict[str, Any]) -> httpx.Response:
        async with httpx.AsyncClient(timeout=self._timeout) as cli:
            resp = await cli.post(f"{self._base_url}{path}", json=payload, headers=self._headers)
            resp.raise_for_status()
            return resp

    def health(self) -> Dict[str, Any]:
        with httpx.Client(timeout=5) as cli:
            resp = cli.get(f"{self._base_url}/health")
            resp.raise_for_status()
            return resp.json()

    def add_conversation(self, session_id: str, messages: List[Dict[str, str]]) -> Dict[str, Any]:
        return self._post_sync("/v2/conversation/add", {"session_id": session_id, "messages": messages}).json()

    def query_conversation(self, session_id: str, limit: int = 10) -> Dict[str, Any]:
        return self._post_sync("/v2/conversation/query", {"session_id": session_id, "limit": limit}).json()

    def search_conversation(self, query: str, limit: int = 5) -> Dict[str, Any]:
        return self._post_sync("/v2/conversation/search", {"query": query, "limit": limit}).json()

    def search_atomic(self, query: str, limit: int = 5) -> Dict[str, Any]:
        return self._post_sync("/v2/atomic/search", {"query": query, "limit": limit}).json()

    def list_scenarios(self, path_prefix: str = "") -> Dict[str, Any]:
        return self._post_sync("/v2/scenario/ls", {"path_prefix": path_prefix}).json()

    def read_scenario(self, path: str) -> Dict[str, Any]:
        return self._post_sync("/v2/scenario/read", {"path": path}).json()

    def read_core(self) -> Dict[str, Any]:
        return self._post_sync("/v2/core/read", {}).json()

    def write_profile(self, profile_data: Dict[str, Any]) -> Dict[str, Any]:
        return self._post_sync("/v2/core/update", {"content": json.dumps(profile_data)}).json()
