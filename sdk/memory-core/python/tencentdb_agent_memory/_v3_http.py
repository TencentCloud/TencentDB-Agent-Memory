"""Strict HTTP transport used exclusively by v3 SDK clients."""

from __future__ import annotations

import logging
from typing import Dict, Optional

import httpx

from ._http import Stub
from .errors import ParamError, TDAMError

logger = logging.getLogger(__name__)


def _validate_transport_options(
    endpoint: str,
    api_key: str,
    service_id: str,
    timeout: float,
) -> None:
    if not endpoint or not endpoint.strip():
        raise ParamError("endpoint must be provided")
    try:
        parsed = httpx.URL(endpoint)
    except Exception as exc:
        raise ParamError("endpoint must be a valid HTTP(S) URL") from exc
    if parsed.scheme not in ("http", "https") or not parsed.host:
        raise ParamError("endpoint must be a valid HTTP(S) URL")
    if not api_key or not api_key.strip():
        raise ParamError("api_key must be provided")
    if not service_id or not service_id.strip():
        raise ParamError("service_id must be provided")
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout <= 0:
        raise ParamError("timeout must be a positive number")


def _decode_response(resp: httpx.Response) -> dict:
    header_request_id = (
        resp.headers.get("x-qcloud-transaction-id")
        or resp.headers.get("x-trace-id")
        or ""
    )
    try:
        envelope = resp.json()
    except ValueError as exc:
        message = resp.text or f"HTTP {resp.status_code} returned a non-JSON response"
        raise TDAMError(resp.status_code if resp.is_error else -1, message, header_request_id) from exc

    if not isinstance(envelope, dict):
        raise TDAMError(-1, "API response must be a JSON object", header_request_id)

    code = envelope.get("code")
    if resp.is_error or code != 0:
        effective_code = code if isinstance(code, int) and code != 0 else resp.status_code
        payload = envelope.get("data")
        details = payload if isinstance(payload, dict) else None
        raise TDAMError(
            code=effective_code,
            message=str(envelope.get("message") or f"HTTP {resp.status_code}"),
            request_id=str(envelope.get("request_id") or header_request_id),
            details=details,
        )

    result = envelope.get("data") or {}
    if not isinstance(result, dict):
        raise TDAMError(-1, "API response data must be a JSON object", header_request_id)
    trace_id = resp.headers.get("x-trace-id")
    if trace_id:
        result["trace_id"] = trace_id
    return result


class HttpStub(Stub):
    """Synchronous v3 transport with strict validation and TLS verification."""

    def __init__(
        self,
        endpoint: str,
        api_key: str,
        service_id: str,
        timeout: float = 30,
        verify: bool = True,
        user_key: Optional[str] = None,
        client: Optional[httpx.Client] = None,
    ) -> None:
        _validate_transport_options(endpoint, api_key, service_id, timeout)
        self.endpoint = endpoint.rstrip("/")
        self.client = client or httpx.Client(timeout=timeout, verify=verify)
        self.headers: Dict[str, str] = {
            "Authorization": f"Bearer {api_key}",
            "x-tdai-service-id": service_id,
            "Content-Type": "application/json",
        }
        if user_key:
            self.headers["x-tdai-user-key"] = user_key

    def post(self, path: str, body: dict, timeout: Optional[float] = None) -> dict:
        resp = self.client.post(
            url=f"{self.endpoint}{path}",
            json=body,
            headers=self.headers,
            timeout=timeout or self.client.timeout,
        )
        logger.debug("Response %s %s", path, resp.text)
        return _decode_response(resp)

    def get(self, path: str, query: Optional[dict] = None, timeout: Optional[float] = None) -> dict:
        resp = self.client.get(
            url=f"{self.endpoint}{path}",
            params=query or {},
            headers=self.headers,
            timeout=timeout or self.client.timeout,
        )
        logger.debug("Response %s %s", path, resp.text)
        return _decode_response(resp)

    def close(self) -> None:
        if isinstance(self.client, httpx.Client):
            self.client.close()


class AsyncHttpStub:
    """Asynchronous v3 transport with strict validation and TLS verification."""

    def __init__(
        self,
        endpoint: str,
        api_key: str,
        service_id: str,
        timeout: float = 30,
        verify: bool = True,
        user_key: Optional[str] = None,
        client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        _validate_transport_options(endpoint, api_key, service_id, timeout)
        self.endpoint = endpoint.rstrip("/")
        self.client = client or httpx.AsyncClient(timeout=timeout, verify=verify)
        self.headers: Dict[str, str] = {
            "Authorization": f"Bearer {api_key}",
            "x-tdai-service-id": service_id,
            "Content-Type": "application/json",
        }
        if user_key:
            self.headers["x-tdai-user-key"] = user_key

    async def post(self, path: str, body: dict, timeout: Optional[float] = None) -> dict:
        resp = await self.client.post(
            url=f"{self.endpoint}{path}",
            json=body,
            headers=self.headers,
            timeout=timeout or self.client.timeout,
        )
        logger.debug("Response %s %s", path, resp.text)
        return _decode_response(resp)

    async def get(self, path: str, query: Optional[dict] = None, timeout: Optional[float] = None) -> dict:
        resp = await self.client.get(
            url=f"{self.endpoint}{path}",
            params=query or {},
            headers=self.headers,
            timeout=timeout or self.client.timeout,
        )
        logger.debug("Response %s %s", path, resp.text)
        return _decode_response(resp)

    async def close(self) -> None:
        if isinstance(self.client, httpx.AsyncClient):
            await self.client.aclose()
