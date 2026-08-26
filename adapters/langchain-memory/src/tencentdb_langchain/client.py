"""Framework-agnostic client for TencentDB Agent Memory.

This module wraps the official ``tencentdb-agent-memory-sdk-python-v2`` data-plane
client and exposes a small set of *semantic* operations — capture, search, and
read — with clean, typed return values. It deliberately depends on nothing from
LangChain / LangGraph, so it can be unit-tested against a fake transport and
reused by any future integration.

The TencentDB Agent Memory model is:

    capture (L0 conversation) → distill (L1 facts, async pipeline)
                              → recall (L1 semantic search / L2 scenarios / L3 persona)

You never write a distilled fact directly. You record observations (``capture``)
and the memory pipeline extracts the facts for you; you then read them back with
``search_facts`` / ``read_persona`` / ``list_scenarios``.

The ``/v3/*`` envelope is ``{"code": 0, "message": "", "request_id": "", "data": {...}}``;
the SDK raises :class:`tencentdb_agent_memory.TDAMError` on ``code != 0`` and
otherwise returns the ``data`` object. We only map ``data`` into dataclasses here.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from tencentdb_agent_memory.v3 import AsyncMemoryClient, MemoryClient

__all__ = [
    "MemoryFact",
    "ConversationRecord",
    "Scenario",
    "Persona",
    "TencentDBMemory",
    "AsyncTencentDBMemory",
    "env_config",
    "config_from_dict",
]


# ---------------------------------------------------------------------------
# Typed results
# ---------------------------------------------------------------------------


@dataclass
class MemoryFact:
    """A single L1 atomic memory returned by ``/v3/atomic/search`` or ``query``."""

    id: str
    content: str
    type: Optional[str] = None
    score: Optional[float] = None
    background: Optional[str] = None
    version: int = 0
    team_id: Optional[str] = None
    user_id: Optional[str] = None
    agent_id: Optional[str] = None
    task_id: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


@dataclass
class ConversationRecord:
    """A single L0 conversation message returned by ``/v3/conversation/query``."""

    id: Optional[str] = None
    role: Optional[str] = None
    content: Optional[str] = None
    score: Optional[float] = None
    created_at: Optional[str] = None
    session_id: Optional[str] = None
    extra: Dict[str, Any] = field(default_factory=dict)


@dataclass
class Scenario:
    """A single L2 scenario block entry returned by ``/v3/scenario/ls``."""

    path: str
    summary: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


@dataclass
class Persona:
    """The L3 persona file returned by ``/v3/core/read``."""

    content: Optional[str] = None
    version: int = 0
    team_id: Optional[str] = None
    agent_id: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


# ---------------------------------------------------------------------------
# Mapping helpers (shared by sync and async clients)
# ---------------------------------------------------------------------------


def _fact_from_dict(d: Dict[str, Any]) -> MemoryFact:
    score = d.get("score")
    return MemoryFact(
        id=str(d.get("id", "")),
        content=str(d.get("content", "")),
        type=d.get("type"),
        score=float(score) if score is not None else None,
        background=d.get("background"),
        version=int(d.get("version", 0) or 0),
        team_id=d.get("team_id"),
        user_id=d.get("user_id"),
        agent_id=d.get("agent_id"),
        task_id=d.get("task_id"),
        created_at=d.get("created_at"),
        updated_at=d.get("updated_at"),
    )


def _conversation_from_dict(d: Dict[str, Any]) -> ConversationRecord:
    extra = {k: v for k, v in d.items() if k not in {
        "id", "role", "content", "score", "created_at", "session_id",
    }}
    return ConversationRecord(
        id=d.get("id"),
        role=d.get("role"),
        content=d.get("content"),
        score=d.get("score"),
        created_at=d.get("created_at"),
        session_id=d.get("session_id"),
        extra=extra,
    )


def _scenario_from_dict(d: Dict[str, Any]) -> Scenario:
    return Scenario(
        path=str(d.get("path", "")),
        summary=d.get("summary"),
        created_at=d.get("created_at"),
        updated_at=d.get("updated_at"),
    )


def _normalize_messages(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Validate that ``messages`` is a non-empty list of ``{role, content}`` dicts."""
    if not isinstance(messages, (list, tuple)) or not messages:
        raise ValueError("messages must be a non-empty list of {role, content} dicts")
    normalized: List[Dict[str, Any]] = []
    for m in messages:
        if isinstance(m, dict):
            role = m.get("role")
            content = m.get("content")
        else:
            # Lenient: objects exposing ``content`` (e.g. LangChain messages).
            role = getattr(m, "type", None) or getattr(m, "role", None)
            content = getattr(m, "content", None)
        if role is None or content is None:
            raise ValueError(f"each message must have role and content, got: {m!r}")
        normalized.append({"role": str(role), "content": str(content)})
    return normalized


def env_config(prefix: str = "TDAI_MEMORY_") -> Dict[str, Any]:
    """Read connection parameters from environment variables.

    Recognised keys (all optional except the ones the SDK requires at call time):

    - ``{prefix}ENDPOINT``, ``{prefix}API_KEY``, ``{prefix}SERVICE_ID``
    - ``{prefix}TEAM_ID``, ``{prefix}AGENT_ID``, ``{prefix}USER_ID``
    - ``{prefix}SESSION_ID``, ``{prefix}TASK_ID``, ``{prefix}USER_KEY``
    - ``{prefix}TIMEOUT``
    """
    def _get(key: str) -> Optional[str]:
        val = os.environ.get(prefix + key)
        return val if val not in (None, "") else None

    cfg: Dict[str, Any] = {}
    for key in ("endpoint", "api_key", "service_id", "team_id", "agent_id",
                "user_id", "session_id", "task_id", "user_key"):
        val = _get(key.upper())
        if val is not None:
            cfg[key] = val
    timeout = _get("TIMEOUT")
    if timeout is not None:
        try:
            cfg["timeout"] = float(timeout)
        except ValueError:
            pass
    return cfg


def config_from_dict(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Pick the supported connection keys out of an arbitrary dict (e.g. a YAML/JSON config)."""
    supported = {
        "endpoint", "api_key", "service_id", "team_id", "agent_id", "user_id",
        "session_id", "task_id", "user_key", "timeout", "verify",
    }
    return {k: v for k, v in raw.items() if k in supported and v is not None}


# ---------------------------------------------------------------------------
# Synchronous client
# ---------------------------------------------------------------------------


class TencentDBMemory:
    """Synchronous, semantic wrapper over the official v3 :class:`MemoryClient`.

    Parameters mirror the SDK constructor: ``endpoint``, ``api_key``,
    ``service_id`` are the transport; ``team_id`` / ``agent_id`` / ``user_id``
    are the v3 isolation context and are required. ``session_id`` is optional at
    construction but required when calling :meth:`capture`.
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
        client: Optional[MemoryClient] = None,
    ) -> None:
        self._client = client or MemoryClient(
            endpoint=endpoint,
            api_key=api_key,
            service_id=service_id,
            team_id=team_id,
            agent_id=agent_id,
            user_id=user_id,
            session_id=session_id,
            task_id=task_id,
            user_key=user_key,
            timeout=timeout,
            verify=verify,
        )

    @classmethod
    def from_env(cls, prefix: str = "TDAI_MEMORY_") -> "TencentDBMemory":
        return cls(**env_config(prefix))

    @classmethod
    def from_config(cls, config: Dict[str, Any]) -> "TencentDBMemory":
        return cls(**config_from_dict(config))

    # -- capture -----------------------------------------------------------

    def capture(
        self,
        messages: List[Dict[str, Any]],
        *,
        session_id: Optional[str] = None,
    ) -> List[str]:
        """Record a conversation turn (L0). Returns the accepted message ids.

        The memory pipeline distills L1 facts from these observations
        asynchronously; they become searchable shortly afterwards.
        """
        data = self._client.add_conversation(
            _normalize_messages(messages), session_id=session_id
        )
        ids = data.get("accepted_ids") or []
        return [str(i) for i in ids]

    # -- recall ------------------------------------------------------------

    def search_facts(
        self,
        query: str,
        *,
        limit: Optional[int] = None,
        type: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> List[MemoryFact]:
        """Semantic search over distilled L1 facts (``/v3/atomic/search``)."""
        data = self._client.search_atomic(
            query, limit=limit, type=type, session_id=session_id
        )
        items = data.get("items") or []
        return [_fact_from_dict(i) for i in items]

    def search_conversations(
        self,
        query: str,
        *,
        limit: Optional[int] = None,
        session_id: Optional[str] = None,
    ) -> List[ConversationRecord]:
        """Full-text/vector search over raw L0 conversations."""
        data = self._client.search_conversation(
            query, limit=limit, session_id=session_id
        )
        items = data.get("messages") or []
        return [_conversation_from_dict(i) for i in items]

    def list_facts(
        self,
        *,
        type: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        session_id: Optional[str] = None,
    ) -> List[MemoryFact]:
        """List L1 facts (``/v3/atomic/query``)."""
        data = self._client.query_atomic(
            type=type, limit=limit, offset=offset, session_id=session_id
        )
        items = data.get("items") or []
        return [_fact_from_dict(i) for i in items]

    def read_persona(self) -> Persona:
        """Read the L3 persona file (``/v3/core/read``)."""
        data = self._client.read_core()
        return Persona(
            content=data.get("content"),
            version=int(data.get("version", 0) or 0),
            team_id=data.get("team_id"),
            agent_id=data.get("agent_id"),
            created_at=data.get("created_at"),
            updated_at=data.get("updated_at"),
        )

    def list_scenarios(self, *, path_prefix: Optional[str] = None) -> List[Scenario]:
        """List L2 scenario blocks (``/v3/scenario/ls``)."""
        data = self._client.list_scenarios(path_prefix=path_prefix)
        entries = data.get("entries") or data.get("items") or []
        return [_scenario_from_dict(i) for i in entries]

    def read_scenario(self, path: str) -> Optional[str]:
        """Read a single L2 scenario file's content (``/v3/scenario/read``)."""
        data = self._client.read_scenario(path)
        return data.get("content")

    # -- delete ------------------------------------------------------------

    def delete_facts(self, ids: List[str], *, session_id: Optional[str] = None) -> int:
        """Delete L1 facts by id (``/v3/atomic/delete``). Returns deleted count."""
        data = self._client.delete_atomic(ids, session_id=session_id)
        return int(data.get("deleted_count", 0) or 0)

    # -- lifecycle ---------------------------------------------------------

    @property
    def client(self) -> MemoryClient:
        """The underlying SDK client, for anything not covered here."""
        return self._client

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "TencentDBMemory":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


# ---------------------------------------------------------------------------
# Asynchronous client
# ---------------------------------------------------------------------------


class AsyncTencentDBMemory:
    """Asynchronous twin of :class:`TencentDBMemory`, for LangGraph agents."""

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
        client: Optional[AsyncMemoryClient] = None,
    ) -> None:
        self._client = client or AsyncMemoryClient(
            endpoint=endpoint,
            api_key=api_key,
            service_id=service_id,
            team_id=team_id,
            agent_id=agent_id,
            user_id=user_id,
            session_id=session_id,
            task_id=task_id,
            user_key=user_key,
            timeout=timeout,
            verify=verify,
        )

    @classmethod
    def from_env(cls, prefix: str = "TDAI_MEMORY_") -> "AsyncTencentDBMemory":
        return cls(**env_config(prefix))

    @classmethod
    def from_config(cls, config: Dict[str, Any]) -> "AsyncTencentDBMemory":
        return cls(**config_from_dict(config))

    async def capture(
        self,
        messages: List[Dict[str, Any]],
        *,
        session_id: Optional[str] = None,
    ) -> List[str]:
        data = await self._client.add_conversation(
            _normalize_messages(messages), session_id=session_id
        )
        ids = data.get("accepted_ids") or []
        return [str(i) for i in ids]

    async def search_facts(
        self,
        query: str,
        *,
        limit: Optional[int] = None,
        type: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> List[MemoryFact]:
        data = await self._client.search_atomic(
            query, limit=limit, type=type, session_id=session_id
        )
        items = data.get("items") or []
        return [_fact_from_dict(i) for i in items]

    async def search_conversations(
        self,
        query: str,
        *,
        limit: Optional[int] = None,
        session_id: Optional[str] = None,
    ) -> List[ConversationRecord]:
        data = await self._client.search_conversation(
            query, limit=limit, session_id=session_id
        )
        items = data.get("messages") or []
        return [_conversation_from_dict(i) for i in items]

    async def list_facts(
        self,
        *,
        type: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        session_id: Optional[str] = None,
    ) -> List[MemoryFact]:
        data = await self._client.query_atomic(
            type=type, limit=limit, offset=offset, session_id=session_id
        )
        items = data.get("items") or []
        return [_fact_from_dict(i) for i in items]

    async def read_persona(self) -> Persona:
        data = await self._client.read_core()
        return Persona(
            content=data.get("content"),
            version=int(data.get("version", 0) or 0),
            team_id=data.get("team_id"),
            agent_id=data.get("agent_id"),
            created_at=data.get("created_at"),
            updated_at=data.get("updated_at"),
        )

    async def list_scenarios(self, *, path_prefix: Optional[str] = None) -> List[Scenario]:
        data = await self._client.list_scenarios(path_prefix=path_prefix)
        entries = data.get("entries") or data.get("items") or []
        return [_scenario_from_dict(i) for i in entries]

    async def read_scenario(self, path: str) -> Optional[str]:
        data = await self._client.read_scenario(path)
        return data.get("content")

    async def delete_facts(
        self, ids: List[str], *, session_id: Optional[str] = None
    ) -> int:
        data = await self._client.delete_atomic(ids, session_id=session_id)
        return int(data.get("deleted_count", 0) or 0)

    @property
    def client(self) -> AsyncMemoryClient:
        return self._client

    async def close(self) -> None:
        await self._client.close()

    async def __aenter__(self) -> "AsyncTencentDBMemory":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()
