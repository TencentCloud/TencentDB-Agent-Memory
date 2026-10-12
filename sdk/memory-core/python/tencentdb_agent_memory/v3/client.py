"""TencentDB Agent Memory v3 Python SDK — 严格 isolation 数据面客户端。

与 v2 的差异
-----------

- 构造时 ``team_id`` / ``agent_id`` / ``user_id`` **必填**，缺一即 ``ParamError``。
- ``session_id`` 规则：
    - ``add_conversation`` **写入必填**（构造或调用二选一），缺则 ``ValueError`` —
      避免服务端把无 session 的写入静默合并到默认 bucket，与其他调用方串数据。
    - 读接口（query / search / count / delete）可选：传入则按 session 收敛；
      缺则按 (team, agent, user) 跨 session 聚合（agent 维度全量视图语义，
      用于治理面板的 layer-counts、跨会话 L0/L1 列表等）。
    - L2/L3 本来就是 team+agent 级 profile 聚合，不消费 session_id。
- HTTP 路径走 ``/v3/...``；服务端按相同规则校验（缺 team/agent/user 任一即 422）。
- ``offload`` / ``read_file`` 等非 L0–L3 接口未在 v3 暴露 — 继续使用 v2 客户端。

>>> from tencentdb_agent_memory.v3 import MemoryClient
>>> # 典型用法：team+agent+user 在构造时定下来，session 跟着具体会话变
>>> client = MemoryClient(
...     endpoint="https://memory.tencentyun.com",
...     api_key="sk-...",
...     service_id="mem-...",
...     team_id="t1", agent_id="a1", user_id="u1",
...     session_id="s1",   # 可选；不传时 L0/L1 查询走跨 session 聚合
... )
>>> client.add_conversation(messages=[{"role": "user", "content": "hi"}])
>>> client.read_scenario("notes/2026Q2.md")   # L2 不读 session_id
>>> # 跨 session 拉某 agent 的全部 L0 对话总数
>>> client.with_isolation(session_id=None).query_conversation(limit=1)
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from .._http import Stub
from .._v3_http import AsyncHttpStub, HttpStub
from ..errors import ParamError

logger = logging.getLogger(__name__)


_V3 = "/v3"
_UNSET = object()


def _strip_none(d: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}


def _normalize_delete_ids(
    field: str,
    raw: Optional[List[str]],
    max_items: int,
) -> Optional[List[str]]:
    """归一化批量删除的 id 列表：校验非空字符串、去重（保序）、检查上限。

    破坏性操作的入参在客户端就拦一道，比等服务端回 400 更早暴露问题，
    也避免把明显不合法的批量请求发出去。

    :returns: 归一化后的列表；``raw`` 为 None 时返回 None（表示"未提供"）。
    """
    if raw is None:
        return None
    if not isinstance(raw, (list, tuple)):
        raise ParamError(f"{field} must be a list of non-empty strings")
    if any(not isinstance(item, str) or not item.strip() for item in raw):
        raise ParamError(f"{field} must contain only non-empty strings")

    seen: Dict[str, None] = {}
    for item in raw:
        seen.setdefault(item.strip(), None)
    deduped = list(seen.keys())

    if len(deduped) > max_items:
        raise ParamError(f"{field} accepts at most {max_items} items, got {len(deduped)}")
    return deduped


def _validate_construction(team_id: str, agent_id: str, user_id: str) -> None:
    """v3 构造时 team+agent+user 必填，任一缺失立刻 ParamError，避免 422 才暴露。

    session_id 不在构造时强校验（L2/L3 接口不需要）；L0/L1 方法调用时再单独校验。
    """
    missing = [
        name for name, val in (
            ("team_id", team_id),
            ("agent_id", agent_id),
            ("user_id", user_id),
        ) if not val
    ]
    if missing:
        raise ParamError(
            f"v3 MemoryClient requires non-empty {', '.join(missing)} at construction time"
        )


class _IsolationCtx:
    """Carrier for the v3 isolation context. Internal only; exposed via with_isolation()."""

    __slots__ = ("team_id", "agent_id", "user_id", "session_id", "task_id")

    def __init__(
        self,
        team_id: str,
        agent_id: str,
        user_id: str,
        session_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> None:
        self.team_id = team_id
        self.agent_id = agent_id
        self.user_id = user_id
        self.session_id = session_id
        self.task_id = task_id

    def base_body(self) -> Dict[str, Any]:
        """team + agent + user (+ 可选 task)；不含 session_id。L2/L3 调用时用。"""
        body: Dict[str, Any] = {
            "team_id": self.team_id,
            "agent_id": self.agent_id,
            "user_id": self.user_id,
        }
        if self.task_id:
            body["task_id"] = self.task_id
        return body

    def resolve_session(self, override: Optional[str]) -> Optional[str]:
        """L0/L1 调用：override > 构造时 session_id。

        v3 服务端 session_id 可选：传入则按 session 收敛，缺则按 (team,agent,user)
        跨 session 聚合查询/计数（"agent 维度全量视图"语义，用于治理面板等场景）。
        本方法返回最终生效的 session_id，缺即 None — 调用方应在 None 时
        不把 session_id 字段塞入请求 body。
        """
        return override or self.session_id

    def resolve_session_for_write(self, override: Optional[str]) -> str:
        """写入路径专用：``add_conversation`` 必须拿到非空 session_id。

        缺则抛 ``ValueError`` —— 避免服务端把无 session 的写入静默合并到默认
        bucket，与其他调用方的数据混在一起。读取路径（query/search/count/
        delete）仍走 ``resolve_session``，允许缺省以做跨 session 聚合。
        """
        sid = override or self.session_id
        if not sid:
            raise ValueError(
                "v3 MemoryClient.add_conversation requires session_id: "
                "pass it in the constructor or per call. "
                "Reads (query/search/count) may omit it to aggregate across sessions."
            )
        return sid


# ---------------------------------------------------------------------------
# Synchronous client
# ---------------------------------------------------------------------------

class MemoryClient:
    """v3 同步客户端 — 严格 isolation L0–L3 数据面（含 count endpoint）。

    构造必填：``team_id`` / ``agent_id`` / ``user_id``。
    构造可选：``session_id``（不传时所有 L0–L3 接口都跨 session 聚合），``task_id``，
    ``user_key``（资产级接口如 ``clear_chat_memory`` 需要）。
    """

    def __init__(
        self,
        endpoint: str = "",
        api_key: str = "",
        service_id: Optional[str] = None,
        *,
        team_id: str = "",
        agent_id: str = "",
        user_id: str = "",
        session_id: Optional[str] = None,
        task_id: Optional[str] = None,
        user_key: Optional[str] = None,
        timeout: float = 30,
        verify: bool = True,
        stub: Optional[Stub] = None,
    ) -> None:
        _validate_construction(team_id, agent_id, user_id)
        if stub is not None:
            self._stub = stub
        else:
            if not service_id:
                raise ParamError("service_id must be provided")
            # user_key 可选：内核不做用户级鉴权，但前置网关/面板可能需要
            # 调用方身份，这里保持与 MetadataClient 一致的透传能力。
            self._stub = HttpStub(
                endpoint, api_key, service_id,
                timeout=timeout, verify=verify, user_key=user_key,
            )
        self._iso = _IsolationCtx(team_id, agent_id, user_id, session_id, task_id)

    # -- isolation overrides ------------------------------------------------

    def with_isolation(
        self,
        *,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        session_id: Any = _UNSET,
        task_id: Any = _UNSET,
    ) -> "MemoryClient":
        """Return a clone sharing the transport with selected isolation fields overridden.

        Pass ``session_id=None`` or ``task_id=None`` to explicitly clear a bound
        value. Omitting either argument keeps the current value.
        """
        new_team = team_id or self._iso.team_id
        new_agent = agent_id or self._iso.agent_id
        new_user = user_id or self._iso.user_id
        new_session = self._iso.session_id if session_id is _UNSET else session_id
        new_task = self._iso.task_id if task_id is _UNSET else task_id
        _validate_construction(new_team, new_agent, new_user)
        clone = object.__new__(MemoryClient)
        clone._stub = self._stub
        clone._iso = _IsolationCtx(new_team, new_agent, new_user, new_session, new_task)
        return clone

    # -- L0 Conversation ---------------------------------------------------
    # 写入必须带 session_id（否则服务端会静默塞进默认 bucket，串数据）；
    # 读接口 session_id 可选，缺则跨 session 聚合。

    def add_conversation(
        self,
        messages: List[Dict[str, Any]],
        *,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/conversation/add`` — 写入必填 session_id（构造或调用二选一）。"""
        return self._stub.post(
            f"{_V3}/conversation/add",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session_for_write(session_id),
                "messages": messages,
            }),
        )

    def query_conversation(
        self,
        *,
        session_id: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/conversation/query``"""
        return self._stub.post(
            f"{_V3}/conversation/query",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "limit": limit,
                "offset": offset,
                "time_start": time_start,
                "time_end": time_end,
            }),
        )

    def search_conversation(
        self,
        query: str,
        *,
        limit: Optional[int] = None,
        session_id: Optional[str] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/conversation/search``"""
        return self._stub.post(
            f"{_V3}/conversation/search",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "query": query,
                "limit": limit,
                "time_start": time_start,
                "time_end": time_end,
            }),
        )

    def delete_conversation(
        self,
        *,
        message_ids: Optional[List[str]] = None,
        session_ids: Optional[List[str]] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/conversation/delete`` — 批量删除 L0。

        ``message_ids``（≤5000）与 ``session_ids``（≤100）至少给一个，可同时给。

        注意作用域：这里**不会**回退到构造时的 ``session_id``。删除是破坏性
        操作，若像读接口那样自动带上默认 session，只想按 message_ids 删几条
        的调用方会意外把整个会话删掉。要删会话必须显式传 ``session_ids``。

        ``session_id``（单数）已废弃，保留仅为兼容旧调用方，会合并进
        ``session_ids``。
        """
        normalized_messages = _normalize_delete_ids("message_ids", message_ids, 5000)
        normalized_sessions = _normalize_delete_ids("session_ids", session_ids, 100)

        if session_id is not None:
            if not isinstance(session_id, str) or not session_id.strip():
                raise ParamError("session_id must be a non-empty string")
            merged = list(normalized_sessions or [])
            if session_id.strip() not in merged:
                merged.append(session_id.strip())
            normalized_sessions = merged

        if not normalized_messages and not normalized_sessions:
            raise ParamError(
                "delete_conversation requires message_ids or session_ids "
                "(the constructor session_id is intentionally NOT used for deletes)"
            )

        return self._stub.post(
            f"{_V3}/conversation/delete",
            _strip_none({
                **self._iso.base_body(),
                "message_ids": normalized_messages,
                "session_ids": normalized_sessions,
            }),
        )

    def count_conversation(
        self,
        *,
        session_id: Optional[str] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/conversation/count`` — 与 query 同过滤器，仅返回 ``{total}``。"""
        return self._stub.post(
            f"{_V3}/conversation/count",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "time_start": time_start,
                "time_end": time_end,
            }),
        )

    # -- L1 Atomic (session_id 可选，缺则跨 session 聚合) -----------------

    def update_atomic(
        self,
        id: str,
        content: str,
        *,
        background: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/atomic/update``"""
        return self._stub.post(
            f"{_V3}/atomic/update",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "id": id,
                "content": content,
                "background": background,
            }),
        )

    def query_atomic(
        self,
        *,
        type: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/atomic/query``"""
        return self._stub.post(
            f"{_V3}/atomic/query",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "type": type,
                "limit": limit,
                "offset": offset,
                "time_start": time_start,
                "time_end": time_end,
            }),
        )

    def search_atomic(
        self,
        query: str,
        *,
        limit: Optional[int] = None,
        type: Optional[str] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/atomic/search``"""
        return self._stub.post(
            f"{_V3}/atomic/search",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "query": query,
                "limit": limit,
                "type": type,
                "time_start": time_start,
                "time_end": time_end,
            }),
        )

    def delete_atomic(
        self,
        ids: List[str],
        *,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/atomic/delete`` — ids必填，单次至多 5000 条。"""
        normalized = _normalize_delete_ids("ids", ids, 5000)
        if not normalized:
            raise ParamError("delete_atomic requires a non-empty ids list")
        return self._stub.post(
            f"{_V3}/atomic/delete",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "ids": normalized,
            }),
        )

    def count_atomic(
        self,
        *,
        type: Optional[str] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/atomic/count`` — 与 query 同过滤器，仅返回 ``{total}``."""
        return self._stub.post(
            f"{_V3}/atomic/count",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "type": type,
                "time_start": time_start,
                "time_end": time_end,
            }),
        )

    # -- L2 Scenario (team+agent 级，不需要 session_id) -------------------

    def list_scenarios(self, *, path_prefix: Optional[str] = None) -> Dict[str, Any]:
        """``POST /v3/scenario/ls``"""
        return self._stub.post(
            f"{_V3}/scenario/ls",
            _strip_none({**self._iso.base_body(), "path_prefix": path_prefix}),
        )

    def read_scenario(self, path: str) -> Dict[str, Any]:
        """``POST /v3/scenario/read``"""
        return self._stub.post(
            f"{_V3}/scenario/read",
            {**self._iso.base_body(), "path": path},
        )

    def write_scenario(
        self,
        path: str,
        content: str,
        *,
        summary: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/scenario/write``"""
        return self._stub.post(
            f"{_V3}/scenario/write",
            _strip_none({
                **self._iso.base_body(),
                "path": path,
                "content": content,
                "summary": summary,
            }),
        )

    def rm_scenario(self, path: str) -> Dict[str, Any]:
        """``POST /v3/scenario/rm``"""
        return self._stub.post(
            f"{_V3}/scenario/rm",
            {**self._iso.base_body(), "path": path},
        )

    def count_scenario(self, *, path_prefix: Optional[str] = None) -> Dict[str, Any]:
        """``POST /v3/scenario/count`` — 与 ls 同过滤器，仅返回 ``{total}``."""
        return self._stub.post(
            f"{_V3}/scenario/count",
            _strip_none({**self._iso.base_body(), "path_prefix": path_prefix}),
        )

    # -- L3 Core (team+agent 级，不需要 session_id) -----------------------

    def read_core(self) -> Dict[str, Any]:
        """``POST /v3/core/read``"""
        return self._stub.post(f"{_V3}/core/read", self._iso.base_body())

    def write_core(self, content: str) -> Dict[str, Any]:
        """``POST /v3/core/write``"""
        return self._stub.post(
            f"{_V3}/core/write",
            {**self._iso.base_body(), "content": content},
        )

    def count_core(self) -> Dict[str, Any]:
        """``POST /v3/core/count`` — 统计核心记忆文件数量。"""
        return self._stub.post(f"{_V3}/core/count", self._iso.base_body())

    # -- Chat Memory (asset-level) -----------------------------------------

    def clear_chat_memory(self, memory_ids: List[str]) -> Dict[str, Any]:
        """``POST /v3/chat-memory/clear`` — 清空 chat memory 全部内容、保留资产。

        清空范围：L0 / L1 / L2 / L3 + 向量 + 文件。
        保留内容：``memory_id``、Team/Agent 归属、Agent 绑定、ACL、Owner、
        名称、可见性 —— 清空后 Agent 继续用原 ``memory_id`` 写入，无需重建。

        与 L0/L1 删除接口不同，本接口是**资产级**操作：

        * 作用域由 ``memory_ids`` 自身决定，不使用隔离三元组
        * 任一 ``memory_id`` 不存在或不是 chat_memory 时**整批拒绝**，一条都不清
        * 幂等：已清空过的再次调用仍返回成功，计数为 0

        权限：与其它删除接口一致，内核不做用户级鉴权。若需要"仅 Owner 可清空"
        的约束，请走面板后端 ``/api/v1/chat-memory/clear``（那里会校验 Owner）。

        失败项会带 ``retryable`` 标志；为 True 表示服务端已自动重试仍未成功，
        稍后重试即可补齐残留内容。

        :param memory_ids: 待清空的资产 id，1–100 个（自动去重）
        """
        normalized = _normalize_delete_ids("memory_ids", memory_ids, 100)
        if not normalized:
            raise ParamError("clear_chat_memory requires a non-empty memory_ids list")
        # 注意：不带隔离三元组 —— 作用域由 memory_ids 决定。
        return self._stub.post(f"{_V3}/chat-memory/clear", {"memory_ids": normalized})

    # -- Lifecycle ---------------------------------------------------------

    def close(self) -> None:
        self._stub.close()

    def __enter__(self) -> "MemoryClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


# ---------------------------------------------------------------------------
# Asynchronous client
# ---------------------------------------------------------------------------

class AsyncMemoryClient:
    """v3 异步客户端 — 严格 isolation L0–L3 数据面（含 count endpoint，async 版本）。

    与同步版本一致：构造必填 team+agent+user；session_id 全 L0–L3 都可选
    （缺时按 (team,agent,user) 跨 session 聚合）。
    """

    def __init__(
        self,
        endpoint: str = "",
        api_key: str = "",
        service_id: Optional[str] = None,
        *,
        team_id: str = "",
        agent_id: str = "",
        user_id: str = "",
        session_id: Optional[str] = None,
        task_id: Optional[str] = None,
        user_key: Optional[str] = None,
        timeout: float = 30,
        verify: bool = True,
        stub: Optional[Stub] = None,
    ) -> None:
        _validate_construction(team_id, agent_id, user_id)
        if stub is not None:
            self._stub = stub
        else:
            if not service_id:
                raise ParamError("service_id must be provided")
            # user_key 可选：内核不校验，前置网关/面板可能需要调用方身份。
            self._stub = AsyncHttpStub(
                endpoint, api_key, service_id,
                timeout=timeout, verify=verify, user_key=user_key,
            )
        self._iso = _IsolationCtx(team_id, agent_id, user_id, session_id, task_id)

    def with_isolation(
        self,
        *,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        session_id: Any = _UNSET,
        task_id: Any = _UNSET,
    ) -> "AsyncMemoryClient":
        """Clone this client; pass ``None`` to clear a bound session/task."""
        new_team = team_id or self._iso.team_id
        new_agent = agent_id or self._iso.agent_id
        new_user = user_id or self._iso.user_id
        new_session = self._iso.session_id if session_id is _UNSET else session_id
        new_task = self._iso.task_id if task_id is _UNSET else task_id
        _validate_construction(new_team, new_agent, new_user)
        clone = object.__new__(AsyncMemoryClient)
        clone._stub = self._stub
        clone._iso = _IsolationCtx(new_team, new_agent, new_user, new_session, new_task)
        return clone

    # -- L0 Conversation ---------------------------------------------------
    # 写入必须带 session_id（否则服务端会静默塞进默认 bucket，串数据）；
    # 读接口 session_id 可选，缺则跨 session 聚合。

    async def add_conversation(
        self,
        messages: List[Dict[str, Any]],
        *,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/conversation/add`` — 写入必填 session_id（构造或调用二选一）。"""
        return await self._stub.post(
            f"{_V3}/conversation/add",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session_for_write(session_id),
                "messages": messages,
            }),
        )

    async def query_conversation(
        self,
        *,
        session_id: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/conversation/query",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "limit": limit, "offset": offset,
                "time_start": time_start, "time_end": time_end,
            }),
        )

    async def search_conversation(
        self,
        query: str,
        *,
        limit: Optional[int] = None,
        session_id: Optional[str] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/conversation/search",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "query": query, "limit": limit,
                "time_start": time_start, "time_end": time_end,
            }),
        )

    async def delete_conversation(
        self,
        *,
        message_ids: Optional[List[str]] = None,
        session_ids: Optional[List[str]] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/conversation/delete``（异步）。语义同同步版本。"""
        normalized_messages = _normalize_delete_ids("message_ids", message_ids, 5000)
        normalized_sessions = _normalize_delete_ids("session_ids", session_ids, 100)

        if session_id is not None:
            if not isinstance(session_id, str) or not session_id.strip():
                raise ParamError("session_id must be a non-empty string")
            merged = list(normalized_sessions or [])
            if session_id.strip() not in merged:
                merged.append(session_id.strip())
            normalized_sessions = merged

        if not normalized_messages and not normalized_sessions:
            raise ParamError(
                "delete_conversation requires message_ids or session_ids "
                "(the constructor session_id is intentionally NOT used for deletes)"
            )

        return await self._stub.post(
            f"{_V3}/conversation/delete",
            _strip_none({
                **self._iso.base_body(),
                "message_ids": normalized_messages,
                "session_ids": normalized_sessions,
            }),
        )

    async def count_conversation(
        self,
        *,
        session_id: Optional[str] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/conversation/count",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "time_start": time_start,
                "time_end": time_end,
            }),
        )

    # -- L1 Atomic (session_id 可选，缺则跨 session 聚合) -----------------

    async def update_atomic(
        self,
        id: str,
        content: str,
        *,
        background: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/atomic/update",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "id": id, "content": content, "background": background,
            }),
        )

    async def query_atomic(
        self,
        *,
        type: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/atomic/query",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "type": type, "limit": limit, "offset": offset,
                "time_start": time_start, "time_end": time_end,
            }),
        )

    async def search_atomic(
        self,
        query: str,
        *,
        limit: Optional[int] = None,
        type: Optional[str] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/atomic/search",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "query": query, "limit": limit, "type": type,
                "time_start": time_start, "time_end": time_end,
            }),
        )

    async def delete_atomic(
        self,
        ids: List[str],
        *,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/atomic/delete``（异步）。ids 必填，单次至多 5000 条。"""
        normalized = _normalize_delete_ids("ids", ids, 5000)
        if not normalized:
            raise ParamError("delete_atomic requires a non-empty ids list")
        return await self._stub.post(
            f"{_V3}/atomic/delete",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "ids": normalized,
            }),
        )

    async def count_atomic(
        self,
        *,
        type: Optional[str] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/atomic/count",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "type": type,
                "time_start": time_start,
                "time_end": time_end,
            }),
        )

    # -- L2 Scenario (team+agent 级，不需要 session_id) -------------------

    async def list_scenarios(self, *, path_prefix: Optional[str] = None) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/scenario/ls",
            _strip_none({**self._iso.base_body(), "path_prefix": path_prefix}),
        )

    async def read_scenario(self, path: str) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/scenario/read",
            {**self._iso.base_body(), "path": path},
        )

    async def write_scenario(
        self,
        path: str,
        content: str,
        *,
        summary: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/scenario/write",
            _strip_none({
                **self._iso.base_body(),
                "path": path, "content": content, "summary": summary,
            }),
        )

    async def rm_scenario(self, path: str) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/scenario/rm",
            {**self._iso.base_body(), "path": path},
        )

    async def count_scenario(self, *, path_prefix: Optional[str] = None) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/scenario/count",
            _strip_none({**self._iso.base_body(), "path_prefix": path_prefix}),
        )

    # -- L3 Core (team+agent 级，不需要 session_id) -----------------------

    async def read_core(self) -> Dict[str, Any]:
        return await self._stub.post(f"{_V3}/core/read", self._iso.base_body())

    async def write_core(self, content: str) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/core/write",
            {**self._iso.base_body(), "content": content},
        )

    async def count_core(self) -> Dict[str, Any]:
        return await self._stub.post(f"{_V3}/core/count", self._iso.base_body())

    # -- Chat Memory (asset-level) -----------------------------------------

    async def clear_chat_memory(self, memory_ids: List[str]) -> Dict[str, Any]:
        """``POST /v3/chat-memory/clear``（异步）。语义同同步版本。"""
        normalized = _normalize_delete_ids("memory_ids", memory_ids, 100)
        if not normalized:
            raise ParamError("clear_chat_memory requires a non-empty memory_ids list")
        # 注意：不带隔离三元组 —— 作用域由 memory_ids 决定。
        return await self._stub.post(f"{_V3}/chat-memory/clear", {"memory_ids": normalized})

    async def close(self) -> None:
        await self._stub.close()

    async def __aenter__(self) -> "AsyncMemoryClient":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()
