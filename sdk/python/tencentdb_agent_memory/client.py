"""TencentDB Agent Memory v2 Python SDK — synchronous + asynchronous clients.

Exposes the v2 data-plane API (14 routes) over a Bearer-token authenticated
HTTP transport.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from ._http import AsyncHttpStub, HttpStub, Stub
from .cos import AsyncMemoryFileReader, AsyncStsCredentialManager, MemoryFileReader, StsCredentialManager

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_V2 = "/v2"


def _strip_none(d: Dict[str, Any]) -> Dict[str, Any]:
    """Return a copy of *d* with ``None`` values removed."""
    return {k: v for k, v in d.items() if v is not None}


# ---------------------------------------------------------------------------
# Synchronous client
# ---------------------------------------------------------------------------

class MemoryClient:
    """Synchronous client for the TencentDB Agent Memory v2 data-plane API.

    Example::

        from tencentdb_agent_memory import MemoryClient

        client = MemoryClient(
            endpoint="https://memory.tencentyun.com",
            api_key="sk-xxxxxxxx",
            service_id="mem-xxxxxxxx",
        )
        result = client.add_conversation("sess-1", [
            {"role": "user", "content": "hello"},
        ])
        print(result)  # {"accepted_ids": [...], "total_count": 1}

    Parameters
    ----------
    endpoint : str
        Base URL of the memory service.
    api_key : str
        Bearer token.
    service_id : str
        Memory instance ID (sent via ``x-tdai-service-id`` header).
    timeout : float
        Request timeout in seconds.
    stub : Stub | None
        Inject a custom transport (useful for testing).
    """

    def __init__(
        self,
        endpoint: str = "",
        api_key: str = "",
        service_id: Optional[str] = None,
        *,
        timeout: float = 30,
        verify: bool = False,
        stub: Optional[Stub] = None,
    ) -> None:
        if stub is not None:
            self._stub = stub
        else:
            if not service_id:
                raise ValueError("service_id must be provided")
            self._stub = HttpStub(endpoint, api_key, service_id, timeout=timeout, verify=verify)

        # Memory file reader (lazy init on first read_file call)
        self._cos_reader: Optional[MemoryFileReader] = None
        self._sts_manager: Optional[StsCredentialManager] = None

    # -- L0 Conversation ---------------------------------------------------

    def add_conversation(
        self,
        session_id: str,
        messages: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """``POST /conversation/add``"""
        return self._stub.post(
            f"{_V2}/conversation/add",
            {"session_id": session_id, "messages": messages},
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
        """``POST /conversation/query``"""
        return self._stub.post(
            f"{_V2}/conversation/query",
            _strip_none({
                "session_id": session_id,
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
        """``POST /conversation/search``"""
        return self._stub.post(
            f"{_V2}/conversation/search",
            _strip_none({
                "query": query,
                "limit": limit,
                "session_id": session_id,
                "time_start": time_start,
                "time_end": time_end,
            }),
        )

    def delete_conversation(
        self,
        *,
        message_ids: Optional[List[str]] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /conversation/delete`` — *message_ids* 和 *session_id* 二选一。"""
        return self._stub.post(
            f"{_V2}/conversation/delete",
            _strip_none({
                "message_ids": message_ids,
                "session_id": session_id,
            }),
        )

    # -- L1 Atomic ---------------------------------------------------------

    def update_atomic(self, id: str, content: str, *, background: Optional[str] = None) -> Dict[str, Any]:
        """``POST /atomic/update``"""
        return self._stub.post(
            f"{_V2}/atomic/update",
            _strip_none({"id": id, "content": content, "background": background}),
        )

    def query_atomic(
        self,
        *,
        type: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /atomic/query``"""
        return self._stub.post(
            f"{_V2}/atomic/query",
            _strip_none({
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
    ) -> Dict[str, Any]:
        """``POST /atomic/search``"""
        return self._stub.post(
            f"{_V2}/atomic/search",
            _strip_none({
                "query": query,
                "limit": limit,
                "type": type,
                "time_start": time_start,
                "time_end": time_end,
            }),
        )

    def delete_atomic(self, ids: List[str]) -> Dict[str, Any]:
        """``POST /atomic/delete``"""
        return self._stub.post(f"{_V2}/atomic/delete", {"ids": ids})

    # -- L2 Scenario -------------------------------------------------------

    def list_scenarios(
        self,
        *,
        path_prefix: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /scenario/ls``"""
        return self._stub.post(
            f"{_V2}/scenario/ls",
            _strip_none({
                "path_prefix": path_prefix,
            }),
        )

    def read_scenario(self, path: str) -> Dict[str, Any]:
        """``POST /scenario/read``

        Returns dict with ``content``, ``created_at``, ``updated_at``.
        If the file does not exist, ``content`` will be ``None``.
        """
        return self._stub.post(f"{_V2}/scenario/read", {"path": path})

    def write_scenario(self, path: str, content: str, *, summary: Optional[str] = None) -> Dict[str, Any]:
        """``POST /scenario/write``"""
        return self._stub.post(
            f"{_V2}/scenario/write",
            _strip_none({"path": path, "content": content, "summary": summary}),
        )

    def rm_scenario(self, path: str) -> Dict[str, Any]:
        """``POST /scenario/rm``"""
        return self._stub.post(f"{_V2}/scenario/rm", {"path": path})

    # -- L3 Core -----------------------------------------------------------

    def read_core(self) -> Dict[str, Any]:
        """``POST /core/read``

        Returns dict with ``content``, ``created_at``, ``updated_at``.
        If core memory has not been generated yet, ``content`` will be ``None``.
        """
        return self._stub.post(f"{_V2}/core/read", {})

    def write_core(self, content: str) -> Dict[str, Any]:
        """``POST /core/write``"""
        return self._stub.post(f"{_V2}/core/write", {"content": content})

    # -- Offload (Ingest + Compact + Read-Ref + Query-MMD) -----------------

    def offload_ingest(
        self,
        session_id: str,
        tool_pairs: List[Dict[str, Any]],
        *,
        prompt: Optional[str] = None,
        recent_messages: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """``POST /v2/offload/ingest`` — 上报工具调用对，触发 L1 异步处理。

        可 fire-and-forget 使用（忽略返回值）。

        Parameters
        ----------
        session_id : str
            会话 ID。
        tool_pairs : list[dict]
            工具调用对列表，每个元素包含 ``tool_name``、``tool_call_id``、
            ``params``、``result``、``timestamp``，可选 ``duration_ms``。
        prompt : str, optional
            最新 user message，用于 L1.5 任务判断。
        recent_messages : list[dict], optional
            近期历史消息列表（``role`` + ``content``），辅助 L1 提取上下文。
        """
        return self._stub.post(
            f"{_V2}/offload/ingest",
            _strip_none({
                "session_id": session_id,
                "tool_pairs": tool_pairs,
                "prompt": prompt,
                "recent_messages": recent_messages,
            }),
        )

    def offload_compact(
        self,
        session_id: str,
        messages: List[Dict[str, Any]],
        ratio: float,
        total_tokens: int,
        *,
        context_window: Optional[int] = None,
        message_tokens: Optional[List[int]] = None,
    ) -> Dict[str, Any]:
        """``POST /v2/offload/compact`` — 对 messages 执行服务端上下文压缩。

        Parameters
        ----------
        session_id : str
            会话 ID。
        messages : list[dict]
            当前完整对话消息列表。
        ratio : float
            当前 token 使用比例（已用 / context_window），触发压缩策略判断。
        total_tokens : int
            当前完整上下文的总 token 数（包含 system prompt、tool schemas 等不在
            messages 中的隐性开销）。服务端用于计算 fixed overhead 和校准 token 估算。
        context_window : int, optional
            模型 context window 大小（token 数）。
        message_tokens : list[int], optional
            每条消息对应的 token 数，提供时可跳过服务端估算，提升性能。

        Returns
        -------
        dict
            ``messages``（压缩后消息列表）+ ``report``（压缩报告）。
        """
        return self._stub.post(
            f"{_V2}/offload/compact",
            _strip_none({
                "session_id": session_id,
                "messages": messages,
                "ratio": ratio,
                "total_tokens": total_tokens,
                "context_window": context_window,
                "message_tokens": message_tokens,
            }),
        )

    def offload_read_ref(
        self,
        session_id: str,
        result_ref: str,
        *,
        query: Optional[str] = None,
        start_line: Optional[int] = None,
        end_line: Optional[int] = None,
        max_tokens: Optional[int] = None,
    ) -> Dict[str, Any]:
        """``POST /v2/offload/read-ref`` — read an archived tool result.

        The server verifies that ``result_ref`` belongs to ``session_id`` and
        bounds the returned content. ``query`` and line-range options are
        mutually exclusive.

        Parameters
        ----------
        session_id : str
            Session that owns the archived result.
        result_ref : str
            Reference returned by Offload V2 compaction.
        query : str, optional
            Case-insensitive substring used to select a bounded excerpt.
        start_line, end_line : int, optional
            One-based inclusive line range.
        max_tokens : int, optional
            Maximum response token budget. The server applies its own hard cap.
        """
        return self._stub.post(
            f"{_V2}/offload/read-ref",
            _strip_none({
                "session_id": session_id,
                "result_ref": result_ref,
                "query": query,
                "start_line": start_line,
                "end_line": end_line,
                "max_tokens": max_tokens,
            }),
        )

    def offload_query_mmd(
        self,
        session_id: str,
        *,
        limit: Optional[int] = None,
    ) -> Dict[str, Any]:
        """``POST /v2/offload/query-mmd`` — 查询 session 的任务流程图（MMD 文件）。

        Parameters
        ----------
        session_id : str
            会话 ID。
        limit : int, optional
            最多返回几个 MMD 文件。``limit=1`` 时走快速路径只返回当前活跃 MMD。

        Returns
        -------
        dict
            ``mmds``（列表，每项含 ``filename``、``content``、``version``）+
            ``current_mmd``（当前活跃 MMD 文件名，无则为 ``None``）。
        """
        return self._stub.post(
            f"{_V2}/offload/query-mmd",
            _strip_none({
                "session_id": session_id,
                "limit": limit,
            }),
        )

    # -- File read (memory pipeline artifacts) -----------------------------

    def read_file(self, path: str) -> str:
        """Read a memory pipeline artifact (e.g. ``persona.md``,
        ``scene_blocks/*.md``) by relative path.

        Parameters
        ----------
        path : str
            Relative path within the memory space, e.g.
            ``"scene_blocks/cooking-recipes.md"`` or ``"persona.md"``.

        Returns
        -------
        str
            File content.

        Raises
        ------
        TDAMError
            On 404 (not found), 403 (auth failure after retry), or other errors.
        """
        if self._cos_reader is None:
            self._sts_manager = StsCredentialManager(
                endpoint=self._stub.endpoint,
                api_key=self._stub.headers["Authorization"].removeprefix("Bearer "),
                service_id=self._stub.headers["x-tdai-service-id"],
            )
            self._cos_reader = MemoryFileReader(self._sts_manager)
        return self._cos_reader.read(path)

    # -- lifecycle ---------------------------------------------------------

    def close(self) -> None:
        if self._cos_reader is not None:
            self._cos_reader.close()
        self._stub.close()

    def __enter__(self) -> "MemoryClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


# ---------------------------------------------------------------------------
# Asynchronous client
# ---------------------------------------------------------------------------

class AsyncMemoryClient:
    """Asynchronous client for the TencentDB Agent Memory v2 data-plane API.

    Same API surface as :class:`MemoryClient` but all methods are coroutines.
    """

    def __init__(
        self,
        endpoint: str = "",
        api_key: str = "",
        service_id: Optional[str] = None,
        *,
        timeout: float = 30,
        verify: bool = False,
    ) -> None:
        if not service_id:
            raise ValueError("service_id must be provided")
        self._stub = AsyncHttpStub(endpoint, api_key, service_id, timeout=timeout, verify=verify)

        # Memory file reader (lazy init)
        self._cos_reader: Optional[AsyncMemoryFileReader] = None
        self._sts_manager: Optional[AsyncStsCredentialManager] = None

    # -- L0 Conversation ---------------------------------------------------

    async def add_conversation(
        self, session_id: str, messages: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V2}/conversation/add",
            {"session_id": session_id, "messages": messages},
        )

    async def query_conversation(
        self, *, session_id: Optional[str] = None, limit: Optional[int] = None,
        offset: Optional[int] = None, time_start: Optional[str] = None,
        time_end: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V2}/conversation/query",
            _strip_none({"session_id": session_id, "limit": limit, "offset": offset,
                         "time_start": time_start, "time_end": time_end}),
        )

    async def search_conversation(
        self, query: str, *, limit: Optional[int] = None,
        session_id: Optional[str] = None, time_start: Optional[str] = None,
        time_end: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V2}/conversation/search",
            _strip_none({"query": query, "limit": limit, "session_id": session_id,
                         "time_start": time_start, "time_end": time_end}),
        )

    async def delete_conversation(
        self, *, message_ids: Optional[List[str]] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V2}/conversation/delete",
            _strip_none({"message_ids": message_ids, "session_id": session_id}),
        )

    # -- L1 Atomic ---------------------------------------------------------

    async def update_atomic(self, id: str, content: str, *, background: Optional[str] = None) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V2}/atomic/update",
            _strip_none({"id": id, "content": content, "background": background}),
        )

    async def query_atomic(
        self, *, type: Optional[str] = None, limit: Optional[int] = None,
        offset: Optional[int] = None, time_start: Optional[str] = None,
        time_end: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V2}/atomic/query",
            _strip_none({"type": type, "limit": limit, "offset": offset,
                         "time_start": time_start, "time_end": time_end}),
        )

    async def search_atomic(
        self, query: str, *, limit: Optional[int] = None,
        type: Optional[str] = None, time_start: Optional[str] = None,
        time_end: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V2}/atomic/search",
            _strip_none({"query": query, "limit": limit, "type": type,
                         "time_start": time_start, "time_end": time_end}),
        )

    async def delete_atomic(self, ids: List[str]) -> Dict[str, Any]:
        return await self._stub.post(f"{_V2}/atomic/delete", {"ids": ids})

    # -- L2 Scenario -------------------------------------------------------

    async def list_scenarios(
        self, *, path_prefix: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V2}/scenario/ls",
            _strip_none({"path_prefix": path_prefix}),
        )

    async def read_scenario(self, path: str) -> Dict[str, Any]:
        """``POST /scenario/read`` — returns ``content: None`` if file does not exist."""
        return await self._stub.post(f"{_V2}/scenario/read", {"path": path})

    async def write_scenario(self, path: str, content: str, *, summary: Optional[str] = None) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V2}/scenario/write", _strip_none({"path": path, "content": content, "summary": summary}),
        )

    async def rm_scenario(self, path: str) -> Dict[str, Any]:
        return await self._stub.post(f"{_V2}/scenario/rm", {"path": path})

    # -- L3 Core -----------------------------------------------------------

    async def read_core(self) -> Dict[str, Any]:
        """``POST /core/read`` — returns ``content: None`` if not yet generated."""
        return await self._stub.post(f"{_V2}/core/read", {})

    async def write_core(self, content: str) -> Dict[str, Any]:
        return await self._stub.post(f"{_V2}/core/write", {"content": content})

    # -- Offload (Ingest + Compact + Read-Ref + Query-MMD) -----------------

    async def offload_ingest(
        self,
        session_id: str,
        tool_pairs: List[Dict[str, Any]],
        *,
        prompt: Optional[str] = None,
        recent_messages: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """``POST /v2/offload/ingest``（异步）"""
        return await self._stub.post(
            f"{_V2}/offload/ingest",
            _strip_none({
                "session_id": session_id,
                "tool_pairs": tool_pairs,
                "prompt": prompt,
                "recent_messages": recent_messages,
            }),
        )

    async def offload_compact(
        self,
        session_id: str,
        messages: List[Dict[str, Any]],
        ratio: float,
        total_tokens: int,
        *,
        context_window: Optional[int] = None,
        message_tokens: Optional[List[int]] = None,
    ) -> Dict[str, Any]:
        """``POST /v2/offload/compact``（异步）"""
        return await self._stub.post(
            f"{_V2}/offload/compact",
            _strip_none({
                "session_id": session_id,
                "messages": messages,
                "ratio": ratio,
                "total_tokens": total_tokens,
                "context_window": context_window,
                "message_tokens": message_tokens,
            }),
        )

    async def offload_read_ref(
        self,
        session_id: str,
        result_ref: str,
        *,
        query: Optional[str] = None,
        start_line: Optional[int] = None,
        end_line: Optional[int] = None,
        max_tokens: Optional[int] = None,
    ) -> Dict[str, Any]:
        """``POST /v2/offload/read-ref``（异步）"""
        return await self._stub.post(
            f"{_V2}/offload/read-ref",
            _strip_none({
                "session_id": session_id,
                "result_ref": result_ref,
                "query": query,
                "start_line": start_line,
                "end_line": end_line,
                "max_tokens": max_tokens,
            }),
        )

    async def offload_query_mmd(
        self,
        session_id: str,
        *,
        limit: Optional[int] = None,
    ) -> Dict[str, Any]:
        """``POST /v2/offload/query-mmd``（异步）"""
        return await self._stub.post(
            f"{_V2}/offload/query-mmd",
            _strip_none({
                "session_id": session_id,
                "limit": limit,
            }),
        )

    # -- lifecycle ---------------------------------------------------------

    # -- File read (memory pipeline artifacts) -----------------------------

    async def read_file(self, path: str) -> str:
        """Read a memory pipeline artifact (async)."""
        if self._cos_reader is None:
            self._sts_manager = AsyncStsCredentialManager(
                endpoint=self._stub.endpoint,
                api_key=self._stub.headers["Authorization"].removeprefix("Bearer "),
                service_id=self._stub.headers["x-tdai-service-id"],
            )
            self._cos_reader = AsyncMemoryFileReader(self._sts_manager)
        return await self._cos_reader.read(path)

    # -- lifecycle ---------------------------------------------------------

    async def close(self) -> None:
        if self._cos_reader is not None:
            await self._cos_reader.close()
        await self._stub.close()

    async def __aenter__(self) -> "AsyncMemoryClient":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()
