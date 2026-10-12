"""Clients for ``/v3/memory-prompt/*`` management APIs."""
from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional

from .._http import Stub
from .._v3_http import AsyncHttpStub, HttpStub
from ..errors import ParamError

_ROOT = "/v3/memory-prompt"


def _strip_none(value: Dict[str, Any]) -> Dict[str, Any]:
    return {key: item for key, item in value.items() if item is not None}


def _required(name: str, value: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ParamError(f"{name} must be a non-empty string")
    return value


def _ids(values: Iterable[str], name: str) -> List[str]:
    result = list(dict.fromkeys(values))
    if not result or any(not isinstance(item, str) or not item.strip() for item in result):
        raise ParamError(f"{name} must be a non-empty list of non-empty strings")
    return result


def _target(team_id: Optional[str], agent_ids: Optional[List[str]]) -> None:
    if agent_ids is not None:
        _ids(agent_ids, "agent_ids")
        if not team_id:
            raise ParamError("team_id is required with agent_ids")


class MemoryPromptClient:
    """Synchronous Prompt CRUD, target binding, resolution and setting-log client."""

    def __init__(self, endpoint: str = "", api_key: str = "", service_id: Optional[str] = None,
                 *, team_id: Optional[str] = None, agent_id: Optional[str] = None,
                 timeout: float = 30, verify: bool = True, stub: Optional[Stub] = None) -> None:
        if stub is not None:
            self._stub = stub
        else:
            if not service_id:
                raise ParamError("service_id must be provided")
            self._stub = HttpStub(endpoint, api_key, service_id, timeout=timeout, verify=verify)
        self._team_id = team_id
        self._agent_id = agent_id

    def _get(self, path: str, query: Dict[str, Any]) -> Dict[str, Any]:
        method = getattr(self._stub, "get", None)
        return method(path, query) if method else self._stub.post(path, query)

    def create(self, *, name: str, layer: str, prompt: str) -> Dict[str, Any]:
        return self._stub.post(f"{_ROOT}/create", {
            "name": _required("name", name), "layer": layer, "prompt": _required("prompt", prompt),
        })

    def get(self, memory_prompt_id: str) -> Dict[str, Any]:
        return self._get(f"{_ROOT}/get", {"memory_prompt_id": _required("memory_prompt_id", memory_prompt_id)})

    def list(self, *, layer: Optional[str] = None, limit: Optional[int] = None,
             offset: Optional[int] = None, time_order: Optional[str] = None) -> Dict[str, Any]:
        return self._get(f"{_ROOT}/get", _strip_none({
            "layer": layer, "limit": limit, "offset": offset, "time_order": time_order,
        }))

    def get_effective(self, *, layer: str, team_id: Optional[str] = None,
                      agent_id: Optional[str] = None) -> Dict[str, Any]:
        team, agent = team_id or self._team_id, agent_id or self._agent_id
        if not team:
            raise ParamError("team_id is required for effective prompt lookup")
        return self._get(f"{_ROOT}/get", _strip_none({"team_id": team, "agent_id": agent, "layer": layer}))

    def update(self, memory_prompt_id: str, *, name: Optional[str] = None,
               prompt: Optional[str] = None) -> Dict[str, Any]:
        if name is None and prompt is None:
            raise ParamError("name or prompt is required")
        return self._stub.post(f"{_ROOT}/update", _strip_none({
            "memory_prompt_id": _required("memory_prompt_id", memory_prompt_id), "name": name, "prompt": prompt,
        }))

    def delete(self, memory_prompt_ids: Iterable[str]) -> Dict[str, Any]:
        return self._stub.post(f"{_ROOT}/delete", {"memory_prompt_ids": _ids(memory_prompt_ids, "memory_prompt_ids")})

    def apply(self, memory_prompt_id: str, *, layer: str, team_id: Optional[str] = None,
              agent_ids: Optional[List[str]] = None) -> Dict[str, Any]:
        team = team_id or self._team_id
        _target(team, agent_ids)
        return self._stub.post(f"{_ROOT}/set", _strip_none({
            "action": "apply", "memory_prompt_id": _required("memory_prompt_id", memory_prompt_id),
            "team_id": team, "agent_ids": agent_ids, "layer": layer,
        }))

    def clear(self, *, layer: str, team_id: Optional[str] = None,
              agent_ids: Optional[List[str]] = None) -> Dict[str, Any]:
        team = team_id or self._team_id
        _target(team, agent_ids)
        return self._stub.post(f"{_ROOT}/set", _strip_none({
            "action": "clear", "team_id": team, "agent_ids": agent_ids, "layer": layer,
        }))

    def list_settings(self, *, memory_prompt_id: Optional[str] = None,
                      target_type: Optional[str] = None, team_id: Optional[str] = None,
                      agent_id: Optional[str] = None, layer: Optional[str] = None,
                      limit: Optional[int] = None, offset: Optional[int] = None,
                      time_order: Optional[str] = None) -> Dict[str, Any]:
        team, agent = team_id or self._team_id, agent_id or self._agent_id
        if agent and not team:
            raise ParamError("team_id is required with agent_id")
        return self._get(f"{_ROOT}/setting/list", _strip_none({
            "memory_prompt_id": memory_prompt_id, "target_type": target_type,
            "team_id": team, "agent_id": agent, "layer": layer,
            "limit": limit, "offset": offset, "time_order": time_order,
        }))

    def list_setting_logs(self, *, memory_prompt_id: Optional[str] = None,
                          start_time: Optional[str] = None, end_time: Optional[str] = None,
                          team_id: Optional[str] = None, agent_id: Optional[str] = None,
                          action: Optional[str] = None, limit: Optional[int] = None,
                          offset: Optional[int] = None, time_order: Optional[str] = None) -> Dict[str, Any]:
        team, agent = team_id or self._team_id, agent_id or self._agent_id
        if agent and not team:
            raise ParamError("team_id is required with agent_id")
        if not memory_prompt_id and not team and not agent:
            raise ParamError("memory_prompt_id or a target condition is required")
        return self._get(f"{_ROOT}/log", _strip_none({
            "memory_prompt_id": memory_prompt_id, "start_time": start_time, "end_time": end_time,
            "team_id": team, "agent_id": agent, "action": action, "limit": limit,
            "offset": offset, "time_order": time_order,
        }))

    def close(self) -> None:
        self._stub.close()


class AsyncMemoryPromptClient:
    """Asynchronous variant of :class:`MemoryPromptClient`."""

    def __init__(self, endpoint: str = "", api_key: str = "", service_id: Optional[str] = None,
                 *, team_id: Optional[str] = None, agent_id: Optional[str] = None,
                 timeout: float = 30, verify: bool = True, stub: Optional[Stub] = None) -> None:
        if stub is not None:
            self._stub = stub
        else:
            if not service_id:
                raise ParamError("service_id must be provided")
            self._stub = AsyncHttpStub(endpoint, api_key, service_id, timeout=timeout, verify=verify)
        self._team_id, self._agent_id = team_id, agent_id

    async def _get(self, path: str, query: Dict[str, Any]) -> Dict[str, Any]:
        method = getattr(self._stub, "get", None)
        return await method(path, query) if method else await self._stub.post(path, query)  # type: ignore[misc]

    async def create(self, *, name: str, layer: str, prompt: str) -> Dict[str, Any]:
        return await self._stub.post(f"{_ROOT}/create", {"name": _required("name", name), "layer": layer, "prompt": _required("prompt", prompt)})  # type: ignore[misc]

    async def get(self, memory_prompt_id: str) -> Dict[str, Any]:
        return await self._get(f"{_ROOT}/get", {"memory_prompt_id": _required("memory_prompt_id", memory_prompt_id)})

    async def list(self, **kwargs: Any) -> Dict[str, Any]:
        return await self._get(f"{_ROOT}/get", _strip_none(kwargs))

    async def get_effective(self, *, layer: str, team_id: Optional[str] = None, agent_id: Optional[str] = None) -> Dict[str, Any]:
        team, agent = team_id or self._team_id, agent_id or self._agent_id
        if not team:
            raise ParamError("team_id is required for effective prompt lookup")
        return await self._get(f"{_ROOT}/get", _strip_none({"team_id": team, "agent_id": agent, "layer": layer}))

    async def update(self, memory_prompt_id: str, *, name: Optional[str] = None, prompt: Optional[str] = None) -> Dict[str, Any]:
        if name is None and prompt is None:
            raise ParamError("name or prompt is required")
        return await self._stub.post(f"{_ROOT}/update", _strip_none({"memory_prompt_id": _required("memory_prompt_id", memory_prompt_id), "name": name, "prompt": prompt}))  # type: ignore[misc]

    async def delete(self, memory_prompt_ids: Iterable[str]) -> Dict[str, Any]:
        return await self._stub.post(f"{_ROOT}/delete", {"memory_prompt_ids": _ids(memory_prompt_ids, "memory_prompt_ids")})  # type: ignore[misc]

    async def apply(self, memory_prompt_id: str, *, layer: str, team_id: Optional[str] = None, agent_ids: Optional[List[str]] = None) -> Dict[str, Any]:
        team = team_id or self._team_id
        _target(team, agent_ids)
        return await self._stub.post(f"{_ROOT}/set", _strip_none({"action": "apply", "memory_prompt_id": _required("memory_prompt_id", memory_prompt_id), "team_id": team, "agent_ids": agent_ids, "layer": layer}))  # type: ignore[misc]

    async def clear(self, *, layer: str, team_id: Optional[str] = None, agent_ids: Optional[List[str]] = None) -> Dict[str, Any]:
        team = team_id or self._team_id
        _target(team, agent_ids)
        return await self._stub.post(f"{_ROOT}/set", _strip_none({"action": "clear", "team_id": team, "agent_ids": agent_ids, "layer": layer}))  # type: ignore[misc]

    async def list_settings(self, **kwargs: Any) -> Dict[str, Any]:
        team = kwargs.pop("team_id", None) or self._team_id
        agent = kwargs.pop("agent_id", None) or self._agent_id
        if agent and not team:
            raise ParamError("team_id is required with agent_id")
        return await self._get(f"{_ROOT}/setting/list", _strip_none({**kwargs, "team_id": team, "agent_id": agent}))

    async def list_setting_logs(self, **kwargs: Any) -> Dict[str, Any]:
        team = kwargs.pop("team_id", None) or self._team_id
        agent = kwargs.pop("agent_id", None) or self._agent_id
        if agent and not team:
            raise ParamError("team_id is required with agent_id")
        if not kwargs.get("memory_prompt_id") and not team and not agent:
            raise ParamError("memory_prompt_id or a target condition is required")
        return await self._get(f"{_ROOT}/log", _strip_none({**kwargs, "team_id": team, "agent_id": agent}))

    async def close(self) -> None:
        await self._stub.close()  # type: ignore[misc]
