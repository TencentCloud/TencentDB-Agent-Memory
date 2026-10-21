"""Low-level HTTP transport for the TencentDB Agent Memory v2 API.

Provides Bearer-token authentication, response-envelope unwrapping
(``code == 0`` → ``data``; otherwise raise ``TDAMError``), and trace-id
propagation via the ``x-trace-id`` response header.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from typing import Any, Dict, Optional

import httpx

from .errors import TDAMError

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Stub abstraction
# ---------------------------------------------------------------------------

class Stub(ABC):
    """Base transport interface."""

    @abstractmethod
    def post(self, path: str, body: dict, timeout: Optional[float] = None) -> dict:
        ...

    @abstractmethod
    def close(self) -> None:
        ...


class HttpStub(Stub):
    """Synchronous HTTP transport backed by :mod:`httpx`.

    Parameters
    ----------
    endpoint : str
        Base URL of the memory service, e.g.
        ``https://memory.tencentyun.com``.
    api_key : str
        Bearer token sent via ``Authorization`` header.
    service_id : str
        Memory instance ID (sent via ``x-tdai-service-id`` header).
    timeout : float
        Default request timeout in seconds.
    user_key : str | None
        Optional user API key sent via ``x-tdai-user-key`` header
        (system_admin endpoints such as user/create need it).
    """

    def __init__(
        self,
        endpoint: str,
        api_key: str,
        service_id: str,
        timeout: float = 30,
        verify: bool = False,
        user_key: Optional[str] = None,
        client: Optional[httpx.Client] = None,
    ) -> None:
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
        url = f"{self.endpoint}{path}"
        logger.debug("Request %s %s", path, body)
        resp = self.client.post(
            url=url,
            json=body,
            headers=self.headers,
            timeout=timeout or self.client.timeout,
        )
        logger.debug("Response %s %s", path, resp.text)
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") != 0:
            req_id = resp.headers.get("x-qcloud-transaction-id", data.get("request_id", ""))
            payload = data.get("data")
            details = payload if isinstance(payload, dict) else None
            raise TDAMError(
                code=data.get("code", -1),
                message=data.get("message", "unknown error"),
                request_id=req_id,
                details=details,
            )
        # ``get``'s default never fires for an explicit ``null``, so an empty
        # data payload must be normalized or the trace-id write below crashes
        # with TypeError. Normalize only ``None``: other falsy payloads
        # (``[]``/``""``/``0``/``false``) are malformed and must not silently
        # pass as an empty success. Non-dict data fails as a clean TDAMError.
        result = data.get("data")
        if result is None:
            result = {}
        if not isinstance(result, dict):
            raise TDAMError(
                code=-1,
                message="API response data must be a JSON object",
                request_id=resp.headers.get("x-qcloud-transaction-id", data.get("request_id", "")),
            )
        trace_id = resp.headers.get("x-trace-id")
        if trace_id:
            result["trace_id"] = trace_id
        return result

    def close(self) -> None:
        if isinstance(self.client, httpx.Client):
            self.client.close()


# ---------------------------------------------------------------------------
# Async variant
# ---------------------------------------------------------------------------

class AsyncHttpStub:
    """Asynchronous HTTP transport backed by :mod:`httpx`."""

    def __init__(
        self,
        endpoint: str,
        api_key: str,
        service_id: str,
        timeout: float = 30,
        verify: bool = False,
        user_key: Optional[str] = None,
        client: Optional[httpx.AsyncClient] = None,
    ) -> None:
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
        url = f"{self.endpoint}{path}"
        logger.debug("Request %s %s", path, body)
        resp = await self.client.post(
            url=url,
            json=body,
            headers=self.headers,
            timeout=timeout or self.client.timeout,
        )
        logger.debug("Response %s %s", path, resp.text)
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") != 0:
            req_id = resp.headers.get("x-qcloud-transaction-id", data.get("request_id", ""))
            payload = data.get("data")
            details = payload if isinstance(payload, dict) else None
            raise TDAMError(
                code=data.get("code", -1),
                message=data.get("message", "unknown error"),
                request_id=req_id,
                details=details,
            )
        # ``get``'s default never fires for an explicit ``null``, so an empty
        # data payload must be normalized or the trace-id write below crashes
        # with TypeError. Normalize only ``None``: other falsy payloads
        # (``[]``/``""``/``0``/``false``) are malformed and must not silently
        # pass as an empty success. Non-dict data fails as a clean TDAMError.
        result = data.get("data")
        if result is None:
            result = {}
        if not isinstance(result, dict):
            raise TDAMError(
                code=-1,
                message="API response data must be a JSON object",
                request_id=resp.headers.get("x-qcloud-transaction-id", data.get("request_id", "")),
            )
        trace_id = resp.headers.get("x-trace-id")
        if trace_id:
            result["trace_id"] = trace_id
        return result

    async def close(self) -> None:
        if isinstance(self.client, httpx.AsyncClient):
            await self.client.aclose()
