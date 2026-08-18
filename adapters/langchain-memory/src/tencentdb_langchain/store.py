"""LangGraph long-term memory store backed by TencentDB Agent Memory.

:class:`TencentDBStore` implements :class:`langgraph.store.base.BaseStore`, the
standard LangGraph abstraction for cross-thread long-term memory. It lets a
LangGraph agent persist and recall memories across conversations without
re-training or re-introducing itself.

Semantic mapping
----------------

TencentDB Agent Memory is *not* a generic key-value store. It follows a
``capture → distill → recall`` model, so the store methods map onto that model
rather than onto exact-KV semantics:

===================================  ==========================================
LangGraph ``BaseStore`` method         TencentDB operation
===================================  ==========================================
``search`` / ``asearch``               ``/v3/atomic/search`` (recall distilled L1 facts)
``put`` / ``aput``                     ``/v3/conversation/add`` (record an L0 observation)
``get`` / ``aget``                     recall the fact most relevant to ``key``
``delete`` / ``adelete``               ``/v3/atomic/delete`` (best-effort, by fact id)
``list_namespaces``                    ``/v3/scenario/ls`` (L2 scenarios as namespaces)
===================================  ==========================================

The important consequence: ``put`` records an *observation* that the memory
pipeline distills into searchable facts asynchronously, so a fact written with
``put`` may not be visible to ``search`` until the pipeline has run. This is
intentional — you record what happened, and the system turns it into memory.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Iterable, List, Optional, Tuple

from langgraph.store.base import (
    BaseStore,
    GetOp,
    Item,
    ListNamespacesOp,
    PutOp,
    Result,
    SearchItem,
    SearchOp,
)

from .client import (
    AsyncTencentDBMemory,
    MemoryFact,
    TencentDBMemory,
    config_from_dict,
    env_config,
)

__all__ = ["TencentDBStore"]

Namespace = Tuple[str, ...]

_MARKER = "tencentdb-langgraph"


def _parse_dt(value: Optional[str]) -> datetime:
    """Parse an ISO-8601 timestamp, falling back to ``now`` when absent/malformed."""
    if value:
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except (ValueError, TypeError):
            pass
    return datetime.now(timezone.utc)


def _fact_to_item(fact: MemoryFact, namespace: Namespace) -> SearchItem:
    created = _parse_dt(fact.created_at)
    updated = _parse_dt(fact.updated_at) if fact.updated_at else created
    value: dict[str, Any] = {"content": fact.content}
    if fact.type is not None:
        value["type"] = fact.type
    if fact.background is not None:
        value["background"] = fact.background
    return SearchItem(
        namespace=namespace,
        key=fact.id,
        value=value,
        created_at=created,
        updated_at=updated,
        score=fact.score,
    )


def _observation_value(namespace: Namespace, key: str, value: dict[str, Any]) -> dict[str, Any]:
    """Encode a ``put`` into a traceable observation message."""
    return {
        "source": _MARKER,
        "namespace": list(namespace),
        "key": key,
        "value": value,
    }


class TencentDBStore(BaseStore):
    """LangGraph ``BaseStore`` backed by TencentDB Agent Memory.

    Construct it from clients or from configuration:

    >>> store = TencentDBStore.from_config({
    ...     "endpoint": "https://memory.example.com",
    ...     "api_key": "sk-...", "service_id": "mem-...",
    ...     "team_id": "t1", "agent_id": "a1", "user_id": "u1",
    ... })

    Both sync and async clients are created, so the store works in sync and
    async LangGraph graphs alike.
    """

    def __init__(
        self,
        *,
        memory: Optional[TencentDBMemory] = None,
        async_memory: Optional[AsyncTencentDBMemory] = None,
        default_session_id: Optional[str] = None,
    ) -> None:
        if memory is None and async_memory is None:
            raise ValueError(
                "TencentDBStore requires at least one of memory / async_memory"
            )
        self._memory = memory
        self._async_memory = async_memory
        self._default_session_id = default_session_id

    @classmethod
    def from_env(cls, prefix: str = "TDAI_MEMORY_") -> "TencentDBStore":
        cfg = env_config(prefix)
        return cls(
            memory=TencentDBMemory(**cfg),
            async_memory=AsyncTencentDBMemory(**cfg),
            default_session_id=cfg.get("session_id"),
        )

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> "TencentDBStore":
        cfg = config_from_dict(config)
        return cls(
            memory=TencentDBMemory(**cfg),
            async_memory=AsyncTencentDBMemory(**cfg),
            default_session_id=cfg.get("session_id"),
        )

    # -- helpers -----------------------------------------------------------

    def _require_memory(self) -> TencentDBMemory:
        if self._memory is None:
            raise RuntimeError("This store has no sync client; use the async methods.")
        return self._memory

    def _require_async_memory(self) -> AsyncTencentDBMemory:
        if self._async_memory is None:
            raise RuntimeError("This store has no async client; use the sync methods.")
        return self._async_memory

    def _session(self, namespace: Namespace) -> Optional[str]:
        # L0 writes require a session_id. Prefer the explicitly configured
        # default, otherwise derive one from the namespace's top-level scope so
        # ``put`` is self-contained.
        if self._default_session_id:
            return self._default_session_id
        if namespace:
            return namespace[0]
        return None

    # -- put ---------------------------------------------------------------

    def put(
        self,
        namespace: Namespace,
        key: str,
        value: dict[str, Any],
        index: object = None,
        *,
        ttl: object = None,
    ) -> None:
        memory = self._require_memory()
        message = {
            "role": "user",
            "content": json.dumps(
                _observation_value(namespace, key, value), ensure_ascii=False
            ),
        }
        memory.capture([message], session_id=self._session(namespace))

    async def aput(
        self,
        namespace: Namespace,
        key: str,
        value: dict[str, Any],
        index: object = None,
        *,
        ttl: object = None,
    ) -> None:
        memory = self._require_async_memory()
        message = {
            "role": "user",
            "content": json.dumps(
                _observation_value(namespace, key, value), ensure_ascii=False
            ),
        }
        await memory.capture([message], session_id=self._session(namespace))

    # -- search ------------------------------------------------------------

    def search(
        self,
        namespace_prefix: Namespace,
        /,
        *,
        query: Optional[str] = None,
        filter: Optional[dict[str, Any]] = None,
        limit: int = 10,
        offset: int = 0,
        refresh_ttl: Optional[bool] = None,
    ) -> List[SearchItem]:
        memory = self._require_memory()
        q = query or ""
        facts = memory.search_facts(q, limit=limit or 10)
        return [_fact_to_item(f, namespace_prefix) for f in facts]

    async def asearch(
        self,
        namespace_prefix: Namespace,
        /,
        *,
        query: Optional[str] = None,
        filter: Optional[dict[str, Any]] = None,
        limit: int = 10,
        offset: int = 0,
        refresh_ttl: Optional[bool] = None,
    ) -> List[SearchItem]:
        memory = self._require_async_memory()
        q = query or ""
        facts = await memory.search_facts(q, limit=limit or 10)
        return [_fact_to_item(f, namespace_prefix) for f in facts]

    # -- get ---------------------------------------------------------------

    def get(
        self,
        namespace: Namespace,
        key: str,
        *,
        refresh_ttl: Optional[bool] = None,
    ) -> Optional[Item]:
        memory = self._require_memory()
        facts = memory.search_facts(key, limit=1)
        if not facts:
            return None
        return _fact_to_item(facts[0], namespace)

    async def aget(
        self,
        namespace: Namespace,
        key: str,
        *,
        refresh_ttl: Optional[bool] = None,
    ) -> Optional[Item]:
        memory = self._require_async_memory()
        facts = await memory.search_facts(key, limit=1)
        if not facts:
            return None
        return _fact_to_item(facts[0], namespace)

    # -- delete ------------------------------------------------------------

    def delete(self, namespace: Namespace, key: str) -> None:
        # Best-effort: the key is treated as a fact id. If it does not match a
        # fact, the gateway returns deleted_count=0 and nothing is harmed.
        self._require_memory().delete_facts([key])

    async def adelete(self, namespace: Namespace, key: str) -> None:
        await self._require_async_memory().delete_facts([key])

    # -- list_namespaces ---------------------------------------------------

    def list_namespaces(
        self,
        *,
        prefix: Optional[Namespace] = None,
        suffix: Optional[Namespace] = None,
        max_depth: Optional[int] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> List[Namespace]:
        path_prefix = "/".join(prefix) if prefix else None
        scenarios = self._require_memory().list_scenarios(path_prefix=path_prefix)
        return [tuple(s.path.strip("/").split("/")) for s in scenarios]

    async def alist_namespaces(
        self,
        *,
        prefix: Optional[Namespace] = None,
        suffix: Optional[Namespace] = None,
        max_depth: Optional[int] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> List[Namespace]:
        path_prefix = "/".join(prefix) if prefix else None
        scenarios = await self._require_async_memory().list_scenarios(
            path_prefix=path_prefix
        )
        return [tuple(s.path.strip("/").split("/")) for s in scenarios]

    # -- batch -------------------------------------------------------------

    def batch(self, ops: Iterable[Any]) -> List[Result]:
        results: List[Result] = []
        for op in ops:
            if isinstance(op, PutOp):
                self.put(op.namespace, op.key, op.value, op.index, ttl=op.ttl)
                results.append(None)
            elif isinstance(op, GetOp):
                results.append(self.get(op.namespace, op.key, refresh_ttl=op.refresh_ttl))
            elif isinstance(op, SearchOp):
                results.append(self.search(op.namespace_prefix, query=op.query,
                                          filter=op.filter, limit=op.limit,
                                          offset=op.offset, refresh_ttl=op.refresh_ttl))
            elif isinstance(op, ListNamespacesOp):
                results.append(self.list_namespaces(
                    max_depth=op.max_depth, limit=op.limit, offset=op.offset))
            else:
                results.append(None)
        return results

    async def abatch(self, ops: Iterable[Any]) -> List[Result]:
        results: List[Result] = []
        for op in ops:
            if isinstance(op, PutOp):
                await self.aput(op.namespace, op.key, op.value, op.index, ttl=op.ttl)
                results.append(None)
            elif isinstance(op, GetOp):
                results.append(await self.aget(op.namespace, op.key, refresh_ttl=op.refresh_ttl))
            elif isinstance(op, SearchOp):
                results.append(await self.asearch(
                    op.namespace_prefix, query=op.query, filter=op.filter,
                    limit=op.limit, offset=op.offset, refresh_ttl=op.refresh_ttl))
            elif isinstance(op, ListNamespacesOp):
                results.append(await self.alist_namespaces(
                    max_depth=op.max_depth, limit=op.limit, offset=op.offset))
            else:
                results.append(None)
        return results
