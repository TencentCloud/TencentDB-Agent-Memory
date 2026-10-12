"""TencentDB Agent Memory v3 Python SDK — 管理面客户端（MetadataClient）。

与 ``v3.client.MemoryClient``（数据面，严格 isolation L0–L3）的区别
------------------------------------------------------------------

- 数据面客户端构造时必须提供 ``team_id`` / ``agent_id`` / ``user_id`` 四元组。
- 管理面客户端**不需要** isolation 四元组；鉴权用 Bearer + ``x-tdai-service-id``，
  ``team_id`` 等业务字段放在请求 body 里。可选 ``user_key`` 走 ``x-tdai-user-key``
  头（``user/create``、``user/delete`` 等 system_admin 接口需要）。

封装范围
--------

- ``/v3/meta/*`` 公开接口 54 条（与 Panel Control ``META_ACTIONS`` 对齐，含 ``user-key/*``）
- ``/v3/knowledge/*`` Knowledge 实体 CRUD 5 条（非 meta 前缀，保留兼容）

>>> from tencentdb_agent_memory.v3 import MetadataClient
>>> meta = MetadataClient(
...     endpoint="http://127.0.0.1:8420",
...     api_key="verify-token",
...     service_id="knowledge-debug",
...     user_key="sk-mem-...",
... )
>>> meta.create_user({"username": "alice"})
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Union

from .._http import Stub
from .._v3_http import AsyncHttpStub, HttpStub
from ..errors import ParamError

_V3 = "/v3/meta"
_V3_KNOWLEDGE = "/v3/knowledge"


def _strip_none(d: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}


def _body(p: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(p, dict):
        raise ParamError("request payload must be a dict")
    return _strip_none(p)


def _require_any(payload: Dict[str, Any], fields: tuple[str, ...], operation: str) -> None:
    if not any(isinstance(payload.get(field), str) and payload[field].strip() for field in fields):
        raise ParamError(f"{operation} requires one of {', '.join(fields)}")


class _MetadataMethodsMixin:
    """Shared path/body mapping for sync and async metadata clients."""

    _stub: Stub

    # ── User ──

    def _create_user(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/user/create", _body(p))

    def _get_user(self, query: Union[str, Dict[str, Any]]) -> Dict[str, Any]:
        payload = {"user_id": query} if isinstance(query, str) else query
        return self._stub.post(f"{_V3}/user/get", _body(payload))

    def _delete_users(self, user_ids: List[str]) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/user/delete", {"user_ids": user_ids})

    def _list_users(
        self,
        team_id_or_request: Union[str, Dict[str, Any], None] = None,
        *,
        pagination: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        if isinstance(team_id_or_request, str):
            return self._stub.post(f"{_V3}/user/list", _body({"team_id": team_id_or_request, **(pagination or {})}))
        return self._stub.post(f"{_V3}/user/list", _body(team_id_or_request or {}))

    # ── UserKey ──

    def _create_user_key(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/user-key/create", _body(p))

    def _list_user_keys(
        self,
        user_id_or_request: Union[str, Dict[str, Any], None] = None,
        *,
        pagination: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        if isinstance(user_id_or_request, str):
            return self._stub.post(f"{_V3}/user-key/list", _body({"user_id": user_id_or_request, **(pagination or {})}))
        return self._stub.post(f"{_V3}/user-key/list", _body(user_id_or_request or {}))

    def _get_user_key(self, key_id: str) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/user-key/get", {"key_id": key_id})

    def _revoke_user_key(self, key_id: str) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/user-key/revoke", {"key_id": key_id})

    def _update_user_key(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/user-key/update", _body(p))

    # ── Team ──

    def _create_team(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/team/create", _body(p))

    def _get_team(self, team_id: str) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/team/get", {"team_id": team_id})

    def _update_team(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/team/update", _body(p))

    def _delete_teams(self, team_ids: List[str]) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/team/delete", {"team_ids": team_ids})

    def _list_teams(
        self,
        user_id_or_request: Union[str, Dict[str, Any], None] = None,
        *,
        pagination: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        payload = (
            {"user_id": user_id_or_request, **(pagination or {})}
            if isinstance(user_id_or_request, str)
            else (user_id_or_request or {})
        )
        payload = _body(payload)
        _require_any(payload, ("user_id", "user_key"), "list_teams")
        return self._stub.post(f"{_V3}/team/list", payload)

    # ── TeamMember ──

    def _add_team_member(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/team-member/add", _body(p))

    def _remove_team_member(self, team_id: str, user_id: str) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/team-member/remove", {"team_id": team_id, "user_id": user_id})

    def _list_team_members(
        self,
        team_id: str,
        *,
        pagination: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/team-member/list", _body({"team_id": team_id, **(pagination or {})}))

    def _get_team_member(self, team_id: str, user_id: str) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/team-member/get", {"team_id": team_id, "user_id": user_id})

    # ── Agent ──

    def _create_agent(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/agent/create", _body(p))

    def _get_agent(self, agent_id: str) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/agent/get", {"agent_id": agent_id})

    def _update_agent(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/agent/update", _body(p))

    def _delete_agents(self, agent_ids: List[str]) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/agent/delete", {"agent_ids": agent_ids})

    def _list_agents(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/agent/list", _body(p))

    def _archive_agent(self, agent_id: str) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/agent/archive", {"agent_id": agent_id})

    # ── Task ──

    def _create_task(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/task/create", _body(p))

    def _get_task(self, task_id: str) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/task/get", {"task_id": task_id})

    def _update_task(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/task/update", _body(p))

    def _delete_tasks(self, task_ids: List[str]) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/task/delete", {"task_ids": task_ids})

    def _list_tasks(
        self,
        team_id_or_request: Union[str, Dict[str, Any], None] = None,
        *,
        status: Optional[str] = None,
        pagination: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        payload = (
            {"team_id": team_id_or_request, "status": status, **(pagination or {})}
            if isinstance(team_id_or_request, str)
            else (team_id_or_request or {})
        )
        payload = _body(payload)
        _require_any(payload, ("team_id", "creator_user_id", "creator_user_key"), "list_tasks")
        return self._stub.post(f"{_V3}/task/list", payload)

    def _archive_task(self, task_id: str) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/task/archive", {"task_id": task_id})

    # ── TaskAgent ──

    def _link_task_agent(
        self,
        task_id: str,
        agent_id: str,
        role_in_task: Optional[str] = None,
    ) -> Dict[str, Any]:
        return self._stub.post(
            f"{_V3}/task-agent/link",
            _body({"task_id": task_id, "agent_id": agent_id, "role_in_task": role_in_task}),
        )

    def _unlink_task_agent(self, task_id: str, agent_id: str) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/task-agent/unlink", {"task_id": task_id, "agent_id": agent_id})

    def _list_task_agents(
        self,
        task_id: str,
        *,
        pagination: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/task-agent/list", _body({"task_id": task_id, **(pagination or {})}))

    # ── ParticipationLog ──

    def _append_participation_log(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/participation-log/append", _body(p))

    def _list_participation_logs(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/participation-log/list", _body(p))

    # ── Asset ──

    def _create_asset(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/asset/create", _body(p))

    def _get_asset(self, asset_id: str) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/asset/get", {"asset_id": asset_id})

    def _update_asset(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/asset/update", _body(p))

    def _delete_assets(self, asset_ids: List[str]) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/asset/delete", {"asset_ids": asset_ids})

    def _list_assets(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/asset/list", _body(p))

    def _list_accessible_assets(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/asset/list-accessible", _body(p))

    def _touch_asset_usage(self, asset_id: str) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/asset/touch-usage", {"asset_id": asset_id})

    # ── AgentFixedAsset ──

    def _set_agent_fixed_assets(self, agent_id: str, bindings: List[Dict[str, Any]]) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/agent-fixed-asset/set", {"agent_id": agent_id, "bindings": bindings})

    def _list_agent_fixed_assets(
        self,
        agent_id: str,
        *,
        pagination: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/agent-fixed-asset/list", _body({"agent_id": agent_id, **(pagination or {})}))

    def _list_agent_fixed_assets_with_detail(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/agent-fixed-asset/list-with-detail", _body(p))

    def _summarize_agent_fixed_assets_by_agents(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/agent-fixed-asset/summary-by-agents", _body(p))

    # ── ACL ──

    def _grant_acl(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/acl/grant", _body(p))

    def _revoke_acl(self, acl_id: str) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/acl/revoke", {"id": acl_id})

    def _list_acl(
        self,
        asset_id: str,
        *,
        pagination: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/acl/list", _body({"asset_id": asset_id, **(pagination or {})}))

    def _check_acl(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/acl/check", _body(p))

    # ── Auth ──

    def _verify_auth(self, user_key: str) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/auth/verify", {"user_key": user_key})

    # ── ConfigParam ──

    def _get_instance_quota(self) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/instance-quota/get", {})

    def _get_user_config(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/config/user/get", _body(p))

    def _set_user_config(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/config/user/set", _body(p))

    # ── Knowledge ──

    def _create_knowledge(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._stub.post(f"{_V3_KNOWLEDGE}/create", _body(p))

    def _get_knowledge(self, knowledge_id: str, team_id: Optional[str] = None) -> Dict[str, Any]:
        return self._stub.post(
            f"{_V3_KNOWLEDGE}/get",
            _body({"knowledge_id": knowledge_id, "team_id": team_id}),
        )

    def _update_knowledge(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._stub.post(f"{_V3_KNOWLEDGE}/update", _body(p))

    def _delete_knowledge(self, knowledge_ids: List[str], team_id: Optional[str] = None) -> Dict[str, Any]:
        return self._stub.post(
            f"{_V3_KNOWLEDGE}/delete",
            _body({"knowledge_ids": knowledge_ids, "team_id": team_id}),
        )

    def _list_knowledge(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._stub.post(f"{_V3_KNOWLEDGE}/list", _body(p))


class MetadataClient(_MetadataMethodsMixin):
    """v3 同步管理面客户端 — ``/v3/meta/*`` + ``/v3/knowledge/*``。"""

    def __init__(
        self,
        endpoint: str = "",
        api_key: str = "",
        service_id: Optional[str] = None,
        *,
        user_key: Optional[str] = None,
        timeout: float = 30,
        verify: bool = True,
        stub: Optional[Stub] = None,
    ) -> None:
        if stub is not None:
            self._stub = stub
        else:
            if not service_id:
                raise ParamError("service_id must be provided")
            if not api_key:
                raise ParamError("api_key must be provided")
            self._stub = HttpStub(
                endpoint, api_key, service_id,
                timeout=timeout, verify=verify, user_key=user_key,
            )

    # ── User ──

    def create_user(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._create_user(p)

    def get_user(self, query: Union[str, Dict[str, Any]]) -> Dict[str, Any]:
        return self._get_user(query)

    def delete_users(self, user_ids: List[str]) -> Dict[str, Any]:
        return self._delete_users(user_ids)

    def list_users(
        self,
        team_id_or_request: Union[str, Dict[str, Any], None] = None,
        *,
        pagination: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return self._list_users(team_id_or_request, pagination=pagination)

    # ── UserKey ──

    def create_user_key(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._create_user_key(p)

    def list_user_keys(
        self,
        user_id_or_request: Union[str, Dict[str, Any], None] = None,
        *,
        pagination: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return self._list_user_keys(user_id_or_request, pagination=pagination)

    def get_user_key(self, key_id: str) -> Dict[str, Any]:
        return self._get_user_key(key_id)

    def revoke_user_key(self, key_id: str) -> Dict[str, Any]:
        return self._revoke_user_key(key_id)

    def update_user_key(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._update_user_key(p)

    # ── Team ──

    def create_team(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._create_team(p)

    def get_team(self, team_id: str) -> Dict[str, Any]:
        return self._get_team(team_id)

    def update_team(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._update_team(p)

    def delete_teams(self, team_ids: List[str]) -> Dict[str, Any]:
        return self._delete_teams(team_ids)

    def list_teams(
        self,
        user_id_or_request: Union[str, Dict[str, Any], None] = None,
        *,
        pagination: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return self._list_teams(user_id_or_request, pagination=pagination)

    # ── TeamMember ──

    def add_team_member(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._add_team_member(p)

    def remove_team_member(self, team_id: str, user_id: str) -> Dict[str, Any]:
        return self._remove_team_member(team_id, user_id)

    def list_team_members(
        self,
        team_id: str,
        *,
        pagination: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return self._list_team_members(team_id, pagination=pagination)

    def get_team_member(self, team_id: str, user_id: str) -> Dict[str, Any]:
        return self._get_team_member(team_id, user_id)

    # ── Agent ──

    def create_agent(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._create_agent(p)

    def get_agent(self, agent_id: str) -> Dict[str, Any]:
        return self._get_agent(agent_id)

    def update_agent(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._update_agent(p)

    def delete_agents(self, agent_ids: List[str]) -> Dict[str, Any]:
        return self._delete_agents(agent_ids)

    def list_agents(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._list_agents(p)

    def archive_agent(self, agent_id: str) -> Dict[str, Any]:
        return self._archive_agent(agent_id)

    # ── Task ──

    def create_task(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._create_task(p)

    def get_task(self, task_id: str) -> Dict[str, Any]:
        return self._get_task(task_id)

    def update_task(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._update_task(p)

    def delete_tasks(self, task_ids: List[str]) -> Dict[str, Any]:
        return self._delete_tasks(task_ids)

    def list_tasks(
        self,
        team_id_or_request: Union[str, Dict[str, Any], None] = None,
        *,
        status: Optional[str] = None,
        pagination: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return self._list_tasks(team_id_or_request, status=status, pagination=pagination)

    def archive_task(self, task_id: str) -> Dict[str, Any]:
        return self._archive_task(task_id)

    # ── TaskAgent ──

    def link_task_agent(
        self,
        task_id: str,
        agent_id: str,
        role_in_task: Optional[str] = None,
    ) -> Dict[str, Any]:
        return self._link_task_agent(task_id, agent_id, role_in_task)

    def unlink_task_agent(self, task_id: str, agent_id: str) -> Dict[str, Any]:
        return self._unlink_task_agent(task_id, agent_id)

    def list_task_agents(
        self,
        task_id: str,
        *,
        pagination: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return self._list_task_agents(task_id, pagination=pagination)

    # ── ParticipationLog ──

    def append_participation_log(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._append_participation_log(p)

    def list_participation_logs(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._list_participation_logs(p)

    # ── Asset ──

    def create_asset(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._create_asset(p)

    def get_asset(self, asset_id: str) -> Dict[str, Any]:
        return self._get_asset(asset_id)

    def update_asset(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._update_asset(p)

    def delete_assets(self, asset_ids: List[str]) -> Dict[str, Any]:
        return self._delete_assets(asset_ids)

    def list_assets(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._list_assets(p)

    def list_accessible_assets(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._list_accessible_assets(p)

    def touch_asset_usage(self, asset_id: str) -> Dict[str, Any]:
        return self._touch_asset_usage(asset_id)

    # ── AgentFixedAsset ──

    def set_agent_fixed_assets(self, agent_id: str, bindings: List[Dict[str, Any]]) -> Dict[str, Any]:
        return self._set_agent_fixed_assets(agent_id, bindings)

    def list_agent_fixed_assets(
        self,
        agent_id: str,
        *,
        pagination: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return self._list_agent_fixed_assets(agent_id, pagination=pagination)

    def list_agent_fixed_assets_with_detail(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._list_agent_fixed_assets_with_detail(p)

    def summarize_agent_fixed_assets_by_agents(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._summarize_agent_fixed_assets_by_agents(p)

    # ── ACL ──

    def grant_acl(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._grant_acl(p)

    def revoke_acl(self, acl_id: str) -> Dict[str, Any]:
        return self._revoke_acl(acl_id)

    def list_acl(
        self,
        asset_id: str,
        *,
        pagination: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return self._list_acl(asset_id, pagination=pagination)

    def check_acl(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._check_acl(p)

    # ── Auth ──

    def verify_auth(self, user_key: str) -> Dict[str, Any]:
        return self._verify_auth(user_key)

    # ── ConfigParam ──

    def get_instance_quota(self) -> Dict[str, Any]:
        return self._get_instance_quota()

    def get_user_config(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._get_user_config(p)

    def set_user_config(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._set_user_config(p)

    # ── Knowledge ──

    def create_knowledge(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._create_knowledge(p)

    def get_knowledge(self, knowledge_id: str, team_id: Optional[str] = None) -> Dict[str, Any]:
        return self._get_knowledge(knowledge_id, team_id)

    def update_knowledge(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._update_knowledge(p)

    def delete_knowledge(self, knowledge_ids: List[str], team_id: Optional[str] = None) -> Dict[str, Any]:
        return self._delete_knowledge(knowledge_ids, team_id)

    def list_knowledge(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._list_knowledge(p)

    def close(self) -> None:
        self._stub.close()

    def __enter__(self) -> "MetadataClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


class AsyncMetadataClient(_MetadataMethodsMixin):
    """v3 异步管理面客户端 — 与 :class:`MetadataClient` 同构，方法为 ``async``。"""

    def __init__(
        self,
        endpoint: str = "",
        api_key: str = "",
        service_id: Optional[str] = None,
        *,
        user_key: Optional[str] = None,
        timeout: float = 30,
        verify: bool = True,
        stub: Optional[Any] = None,
    ) -> None:
        if stub is not None:
            self._stub = stub
        else:
            if not service_id:
                raise ParamError("service_id must be provided")
            if not api_key:
                raise ParamError("api_key must be provided")
            self._stub = AsyncHttpStub(
                endpoint, api_key, service_id,
                timeout=timeout, verify=verify, user_key=user_key,
            )

    async def create_user(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return await self._create_user(p)

    async def get_user(self, query: Union[str, Dict[str, Any]]) -> Dict[str, Any]:
        return await self._get_user(query)

    async def delete_users(self, user_ids: List[str]) -> Dict[str, Any]:
        return await self._delete_users(user_ids)

    async def list_users(
        self,
        team_id_or_request: Union[str, Dict[str, Any], None] = None,
        *,
        pagination: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return await self._list_users(team_id_or_request, pagination=pagination)

    async def create_user_key(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return await self._create_user_key(p)

    async def list_user_keys(
        self,
        user_id_or_request: Union[str, Dict[str, Any], None] = None,
        *,
        pagination: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return await self._list_user_keys(user_id_or_request, pagination=pagination)

    async def get_user_key(self, key_id: str) -> Dict[str, Any]:
        return await self._get_user_key(key_id)

    async def revoke_user_key(self, key_id: str) -> Dict[str, Any]:
        return await self._revoke_user_key(key_id)

    async def update_user_key(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return await self._update_user_key(p)

    async def create_team(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return await self._create_team(p)

    async def get_team(self, team_id: str) -> Dict[str, Any]:
        return await self._get_team(team_id)

    async def update_team(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return await self._update_team(p)

    async def delete_teams(self, team_ids: List[str]) -> Dict[str, Any]:
        return await self._delete_teams(team_ids)

    async def list_teams(
        self,
        user_id_or_request: Union[str, Dict[str, Any], None] = None,
        *,
        pagination: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return await self._list_teams(user_id_or_request, pagination=pagination)

    async def add_team_member(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return await self._add_team_member(p)

    async def remove_team_member(self, team_id: str, user_id: str) -> Dict[str, Any]:
        return await self._remove_team_member(team_id, user_id)

    async def list_team_members(
        self,
        team_id: str,
        *,
        pagination: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return await self._list_team_members(team_id, pagination=pagination)

    async def get_team_member(self, team_id: str, user_id: str) -> Dict[str, Any]:
        return await self._get_team_member(team_id, user_id)

    async def create_agent(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return await self._create_agent(p)

    async def get_agent(self, agent_id: str) -> Dict[str, Any]:
        return await self._get_agent(agent_id)

    async def update_agent(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return await self._update_agent(p)

    async def delete_agents(self, agent_ids: List[str]) -> Dict[str, Any]:
        return await self._delete_agents(agent_ids)

    async def list_agents(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return await self._list_agents(p)

    async def archive_agent(self, agent_id: str) -> Dict[str, Any]:
        return await self._archive_agent(agent_id)

    async def create_task(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return await self._create_task(p)

    async def get_task(self, task_id: str) -> Dict[str, Any]:
        return await self._get_task(task_id)

    async def update_task(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return await self._update_task(p)

    async def delete_tasks(self, task_ids: List[str]) -> Dict[str, Any]:
        return await self._delete_tasks(task_ids)

    async def list_tasks(
        self,
        team_id_or_request: Union[str, Dict[str, Any], None] = None,
        *,
        status: Optional[str] = None,
        pagination: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return await self._list_tasks(team_id_or_request, status=status, pagination=pagination)

    async def archive_task(self, task_id: str) -> Dict[str, Any]:
        return await self._archive_task(task_id)

    async def link_task_agent(
        self,
        task_id: str,
        agent_id: str,
        role_in_task: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._link_task_agent(task_id, agent_id, role_in_task)

    async def unlink_task_agent(self, task_id: str, agent_id: str) -> Dict[str, Any]:
        return await self._unlink_task_agent(task_id, agent_id)

    async def list_task_agents(
        self,
        task_id: str,
        *,
        pagination: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return await self._list_task_agents(task_id, pagination=pagination)

    async def append_participation_log(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return await self._append_participation_log(p)

    async def list_participation_logs(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return await self._list_participation_logs(p)

    async def create_asset(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return await self._create_asset(p)

    async def get_asset(self, asset_id: str) -> Dict[str, Any]:
        return await self._get_asset(asset_id)

    async def update_asset(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return await self._update_asset(p)

    async def delete_assets(self, asset_ids: List[str]) -> Dict[str, Any]:
        return await self._delete_assets(asset_ids)

    async def list_assets(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return await self._list_assets(p)

    async def list_accessible_assets(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return await self._list_accessible_assets(p)

    async def touch_asset_usage(self, asset_id: str) -> Dict[str, Any]:
        return await self._touch_asset_usage(asset_id)

    async def set_agent_fixed_assets(self, agent_id: str, bindings: List[Dict[str, Any]]) -> Dict[str, Any]:
        return await self._set_agent_fixed_assets(agent_id, bindings)

    async def list_agent_fixed_assets(
        self,
        agent_id: str,
        *,
        pagination: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return await self._list_agent_fixed_assets(agent_id, pagination=pagination)

    async def list_agent_fixed_assets_with_detail(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return await self._list_agent_fixed_assets_with_detail(p)

    async def summarize_agent_fixed_assets_by_agents(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return await self._summarize_agent_fixed_assets_by_agents(p)

    async def grant_acl(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return await self._grant_acl(p)

    async def revoke_acl(self, acl_id: str) -> Dict[str, Any]:
        return await self._revoke_acl(acl_id)

    async def list_acl(
        self,
        asset_id: str,
        *,
        pagination: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return await self._list_acl(asset_id, pagination=pagination)

    async def check_acl(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return await self._check_acl(p)

    async def verify_auth(self, user_key: str) -> Dict[str, Any]:
        return await self._verify_auth(user_key)

    async def get_instance_quota(self) -> Dict[str, Any]:
        return await self._get_instance_quota()

    async def get_user_config(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return await self._get_user_config(p)

    async def set_user_config(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return await self._set_user_config(p)

    async def create_knowledge(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return await self._create_knowledge(p)

    async def get_knowledge(self, knowledge_id: str, team_id: Optional[str] = None) -> Dict[str, Any]:
        return await self._get_knowledge(knowledge_id, team_id)

    async def update_knowledge(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return await self._update_knowledge(p)

    async def delete_knowledge(self, knowledge_ids: List[str], team_id: Optional[str] = None) -> Dict[str, Any]:
        return await self._delete_knowledge(knowledge_ids, team_id)

    async def list_knowledge(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return await self._list_knowledge(p)

    async def close(self) -> None:
        await self._stub.close()

    async def __aenter__(self) -> "AsyncMetadataClient":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()
