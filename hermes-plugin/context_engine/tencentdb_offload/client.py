"""HTTP client for the TencentDB offload ContextEngine plugin."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Dict, Optional


class TencentdbOffloadClient:
    def __init__(self, base_url: str, *, api_key: str = "", timeout: float = 10.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key.strip()
        self.timeout = timeout

    @classmethod
    def from_env(cls) -> "TencentdbOffloadClient":
        base_url = os.environ.get("TENCENTDB_OFFLOAD_GATEWAY_URL", "http://127.0.0.1:8420")
        api_key = (
            os.environ.get("TENCENTDB_OFFLOAD_API_KEY")
            or os.environ.get("MEMORY_TENCENTDB_GATEWAY_API_KEY")
            or os.environ.get("TDAI_GATEWAY_API_KEY")
            or ""
        )
        timeout_raw = os.environ.get("TENCENTDB_OFFLOAD_TIMEOUT_SECS", "10")
        try:
            timeout = float(timeout_raw)
        except ValueError:
            timeout = 10.0
        return cls(base_url, api_key=api_key, timeout=timeout)

    def compact(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._post("/v2/offload/compact", payload)

    def ingest(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._post("/v2/offload/ingest", payload)

    def _post(self, path: str, payload: Dict[str, Any], timeout: Optional[float] = None) -> Dict[str, Any]:
        data = json.dumps(payload).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout or self.timeout) as response:
                body = response.read().decode("utf-8")
                return json.loads(body) if body else {}
        except urllib.error.HTTPError as exc:
            try:
                detail = exc.read().decode("utf-8", errors="replace")
            except Exception:
                detail = ""
            raise RuntimeError(f"offload endpoint {path} returned HTTP {exc.code}: {detail[:300]}") from exc
