"""Clients for ``/v3/memory-generation-log/*`` APIs."""
from __future__ import annotations

from typing import Any, Dict, Optional

from .._http import Stub
from .._v3_http import AsyncHttpStub, HttpStub
from ..errors import ParamError

_ROOT = "/v3/memory-generation-log"


def _strip_none(value: Dict[str, Any]) -> Dict[str, Any]:
    return {key: item for key, item in value.items() if item is not None}


def _required(name: str, value: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ParamError(f"{name} must be a non-empty string")
    return value


class MemoryGenerationLogClient:
    def __init__(self, endpoint: str = "", api_key: str = "", service_id: Optional[str] = None,
                 *, timeout: float = 30, verify: bool = True, stub: Optional[Stub] = None) -> None:
        if stub is not None:
            self._stub = stub
        else:
            if not service_id:
                raise ParamError("service_id must be provided")
            self._stub = HttpStub(endpoint, api_key, service_id, timeout=timeout, verify=verify)

    def _get(self, path: str, query: Dict[str, Any]) -> Dict[str, Any]:
        method = getattr(self._stub, "get", None)
        return method(path, query) if method else self._stub.post(path, query)

    def list(self, *, layer: Optional[str] = None, status: Optional[str] = None,
             start_time: Optional[str] = None, end_time: Optional[str] = None,
             limit: Optional[int] = None, cursor: Optional[str] = None) -> Dict[str, Any]:
        return self._get(f"{_ROOT}/list", _strip_none({
            "layer": layer, "status": status, "start_time": start_time,
            "end_time": end_time, "limit": limit, "cursor": cursor,
        }))

    def get(self, log_id: str) -> Dict[str, Any]:
        return self._get(f"{_ROOT}/get", {"log_id": _required("log_id", log_id)})

    def get_by_memory_id(self, memory_id: str, layer: str) -> Dict[str, Any]:
        return self._get(f"{_ROOT}/get", {"memory_id": _required("memory_id", memory_id), "layer": layer})

    def close(self) -> None:
        self._stub.close()


class AsyncMemoryGenerationLogClient:
    def __init__(self, endpoint: str = "", api_key: str = "", service_id: Optional[str] = None,
                 *, timeout: float = 30, verify: bool = True, stub: Optional[Stub] = None) -> None:
        if stub is not None:
            self._stub = stub
        else:
            if not service_id:
                raise ParamError("service_id must be provided")
            self._stub = AsyncHttpStub(endpoint, api_key, service_id, timeout=timeout, verify=verify)

    async def _get(self, path: str, query: Dict[str, Any]) -> Dict[str, Any]:
        method = getattr(self._stub, "get", None)
        return await method(path, query) if method else await self._stub.post(path, query)  # type: ignore[misc]

    async def list(self, *, layer: Optional[str] = None, status: Optional[str] = None,
                   start_time: Optional[str] = None, end_time: Optional[str] = None,
                   limit: Optional[int] = None, cursor: Optional[str] = None) -> Dict[str, Any]:
        return await self._get(f"{_ROOT}/list", _strip_none({
            "layer": layer, "status": status, "start_time": start_time,
            "end_time": end_time, "limit": limit, "cursor": cursor,
        }))

    async def get(self, log_id: str) -> Dict[str, Any]:
        return await self._get(f"{_ROOT}/get", {"log_id": _required("log_id", log_id)})

    async def get_by_memory_id(self, memory_id: str, layer: str) -> Dict[str, Any]:
        return await self._get(f"{_ROOT}/get", {"memory_id": _required("memory_id", memory_id), "layer": layer})

    async def close(self) -> None:
        await self._stub.close()  # type: ignore[misc]
