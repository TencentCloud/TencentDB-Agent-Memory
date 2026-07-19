from __future__ import annotations

import json
import http.client
import urllib.error
import urllib.request
from typing import Any


class McpGatewayHttpError(RuntimeError):
    def __init__(self, message: str, *, status: int = 0, path: str = "", body: Any = None):
        super().__init__(message)
        self.status = status
        self.path = path
        self.body = body


class McpGatewayTransport:
    def __init__(self, gateway_url: str, timeout_ms: int = 30_000, api_key: str = ""):
        self.gateway_url = gateway_url.rstrip("/")
        self.timeout = timeout_ms / 1000
        self.api_key = api_key.strip()

    def health(self) -> dict[str, Any]:
        return self._request("/health", method="GET")

    def search_memories(
        self,
        *,
        query: str,
        limit: int = 5,
        type_filter: str = "",
        scene: str = "",
    ) -> dict[str, Any]:
        return self._request("/search/memories", body=_omit_empty({
            "query": query,
            "limit": limit,
            "type": type_filter,
            "scene": scene,
        }))

    def search_conversations(
        self,
        *,
        query: str,
        limit: int = 5,
        session_key: str = "",
    ) -> dict[str, Any]:
        return self._request("/search/conversations", body=_omit_empty({
            "query": query,
            "limit": limit,
            "session_key": session_key,
        }))

    def _request(
        self,
        path: str,
        *,
        method: str = "POST",
        body: dict[str, Any] | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        data = None
        headers: dict[str, str] = {}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        request = urllib.request.Request(
            f"{self.gateway_url}{path}",
            data=data,
            headers=headers,
            method=method,
        )

        last_error: BaseException | None = None
        for attempt in range(2):
            try:
                with urllib.request.urlopen(request, timeout=timeout or self.timeout) as response:
                    raw = response.read().decode("utf-8")
                    return json.loads(raw) if raw else {}
            except urllib.error.HTTPError as error:
                raw_body = error.read().decode("utf-8", errors="replace")
                parsed = _parse_json(raw_body)
                message = parsed.get("error") if isinstance(parsed, dict) else None
                raise McpGatewayHttpError(
                    message or f"Gateway returned HTTP {error.code}",
                    status=error.code,
                    path=path,
                    body=parsed,
                ) from error
            except (http.client.RemoteDisconnected, ConnectionResetError) as error:
                last_error = error
                if attempt == 0:
                    continue
                raise McpGatewayHttpError(str(error), path=path) from error
            except TimeoutError as error:
                raise McpGatewayHttpError(
                    f"Gateway request timed out after {timeout or self.timeout}s",
                    path=path,
                ) from error
            except urllib.error.URLError as error:
                raise McpGatewayHttpError(str(error.reason), path=path) from error

        raise McpGatewayHttpError(str(last_error), path=path)


def _omit_empty(value: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, item in value.items():
        if item is None:
            continue
        if isinstance(item, str) and not item.strip():
            continue
        result[key] = item
    return result


def _parse_json(value: str) -> Any:
    try:
        return json.loads(value) if value else {}
    except json.JSONDecodeError:
        return value[:1000]
