from __future__ import annotations

import http.client
import json
import urllib.error
import urllib.request
from typing import Any

from .config import AdapterConfig


class GatewayHttpError(RuntimeError):
    def __init__(self, message: str, *, status: int = 0, path: str = "", body: Any = None):
        super().__init__(message)
        self.status = status
        self.path = path
        self.body = body


def request_json(
    config: AdapterConfig,
    path: str,
    *,
    method: str = "POST",
    body: dict[str, Any] | None = None,
    timeout_ms: int | None = None,
) -> dict[str, Any]:
    data = None
    headers: dict[str, str] = {}
    if body is not None:
        data = json.dumps(_omit_empty(body)).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if config.api_key:
        headers["Authorization"] = f"Bearer {config.api_key}"

    request = urllib.request.Request(
        f"{config.gateway_url}{path}",
        data=data,
        headers=headers,
        method=method,
    )

    timeout = (timeout_ms or config.timeout_ms) / 1000
    last_error: BaseException | None = None
    for attempt in range(2):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as error:
            raw_body = error.read().decode("utf-8", errors="replace")
            parsed = _parse_json(raw_body)
            message = parsed.get("error") if isinstance(parsed, dict) else None
            raise GatewayHttpError(
                message or f"Gateway returned HTTP {error.code}",
                status=error.code,
                path=path,
                body=parsed,
            ) from error
        except (http.client.RemoteDisconnected, ConnectionResetError) as error:
            last_error = error
            if attempt == 0:
                continue
            raise GatewayHttpError(str(error), path=path) from error
        except TimeoutError as error:
            raise GatewayHttpError(
                f"Gateway request timed out after {timeout}s",
                path=path,
            ) from error
        except urllib.error.URLError as error:
            raise GatewayHttpError(str(error.reason), path=path) from error

    raise GatewayHttpError(str(last_error), path=path)


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
