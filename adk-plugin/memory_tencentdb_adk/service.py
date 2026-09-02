"""TdaiMemoryService — google-adk BaseMemoryService backed by the TDAI Gateway.

Wire-up:

    from google.adk.runners import Runner
    from memory_tencentdb_adk import TdaiMemoryService

    memory_service = TdaiMemoryService()  # Gateway on 127.0.0.1:8420
    runner = Runner(
        agent=agent,
        app_name="my-app",
        session_service=session_service,
        memory_service=memory_service,
    )

ADK calls ``add_session_to_memory`` to ingest conversations and
``search_memory`` when the agent uses memory tools (``load_memory`` /
``preload_memory``). Both are bridged to the Gateway REST API:

    add_session_to_memory  → POST /capture   (one call per completed turn)
    add_events_to_memory   → POST /capture   (delta ingestion)
    search_memory          → POST /search/memories + /search/conversations

The service is *fail-open* by default: when the Gateway is down, searches
return an empty result set and ingestion logs a warning instead of
breaking the agent turn. Pass ``strict=True`` to surface
``TdaiGatewayError`` to the caller instead.
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING, Any, Optional, Set

from google.adk.memory.base_memory_service import (
    BaseMemoryService,
    SearchMemoryResponse,
)
from google.adk.memory.memory_entry import MemoryEntry
from google.genai import types

from .client import DEFAULT_BASE_URL, TdaiGatewayClient, TdaiGatewayError
from .turns import Turn, pair_turns

if TYPE_CHECKING:
    from google.adk.events.event import Event
    from google.adk.sessions.session import Session

logger = logging.getLogger(__name__)

_MEMORY_AUTHOR = "memory-tencentdb"
_UNKNOWN_SESSION_ID = "__unknown_session_id__"


def _env_base_url() -> str:
    """Resolve the Gateway base URL from the environment.

    ``TDAI_GATEWAY_URL`` wins; otherwise host/port are assembled from
    ``MEMORY_TENCENTDB_GATEWAY_HOST`` / ``MEMORY_TENCENTDB_GATEWAY_PORT``
    (the same variables the Hermes provider reads), falling back to the
    Gateway default ``127.0.0.1:8420``.
    """
    url = (os.environ.get("TDAI_GATEWAY_URL") or "").strip()
    if url:
        return url
    host = (os.environ.get("MEMORY_TENCENTDB_GATEWAY_HOST") or "127.0.0.1").strip() or "127.0.0.1"
    port = (os.environ.get("MEMORY_TENCENTDB_GATEWAY_PORT") or "8420").strip() or "8420"
    return f"http://{host}:{port}"


def _env_api_key() -> Optional[str]:
    """Optional Bearer token, sourced like the Hermes provider sources it."""
    for var in ("MEMORY_TENCENTDB_GATEWAY_API_KEY", "TDAI_GATEWAY_API_KEY"):
        raw = os.environ.get(var)
        if raw and raw.strip():
            return raw.strip()
    return None


class TdaiMemoryService(BaseMemoryService):
    """ADK memory service backed by the memory-tencentdb Gateway.

    Args:
        base_url: Gateway base URL. Defaults to ``TDAI_GATEWAY_URL`` or
            ``http://127.0.0.1:8420``.
        api_key: Optional Bearer token (defaults to the
            ``MEMORY_TENCENTDB_GATEWAY_API_KEY`` / ``TDAI_GATEWAY_API_KEY``
            environment variables).
        strict: When ``True``, Gateway failures raise ``TdaiGatewayError``.
            When ``False`` (default), ingestion failures are logged and
            searches return empty results, so a down Gateway never breaks
            the agent loop.
        search_limit: Maximum hits requested per search backend.
        include_conversations: Also search raw L0 conversation history (in
            addition to structured L1/L2/L3 memories) on ``search_memory``.
        client: Injectable pre-configured client (tests).
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        *,
        api_key: Optional[str] = None,
        strict: bool = False,
        search_limit: int = 5,
        include_conversations: bool = True,
        client: Optional[TdaiGatewayClient] = None,
    ) -> None:
        self._client = client or TdaiGatewayClient(
            base_url or _env_base_url(),
            api_key=api_key if api_key is not None else _env_api_key(),
        )
        self._strict = strict
        self._search_limit = search_limit
        self._include_conversations = include_conversations
        # Event IDs already captured, keyed per session scope — makes
        # repeated add_session_to_memory calls over a growing session
        # idempotent within this process (ADK explicitly allows a session
        # to be added multiple times during its lifetime).
        self._captured: dict[str, Set[str]] = {}
        self._lock = threading.Lock()

    @property
    def client(self) -> TdaiGatewayClient:
        return self._client

    # -- scoping -------------------------------------------------------------

    @staticmethod
    def _session_key(app_name: str, user_id: str, session_id: str) -> str:
        """Stable Gateway session key for an ADK session.

        The Gateway groups L0 rounds by ``session_key``; embedding app,
        user and session IDs keeps distinct ADK sessions distinct while
        remaining human-greppable in the store.
        """
        return f"adk:{app_name}:{user_id}:{session_id}"

    # -- ingestion -----------------------------------------------------------

    async def add_session_to_memory(self, session: Session) -> None:
        """Ingest every completed turn of *session* into the Gateway."""
        await self._capture_events(
            app_name=session.app_name,
            user_id=session.user_id,
            session_id=session.id,
            events=session.events,
        )

    async def add_events_to_memory(
        self,
        *,
        app_name: str,
        user_id: str,
        events: Sequence[Event],
        session_id: str | None = None,
        custom_metadata: Mapping[str, object] | None = None,
    ) -> None:
        """Ingest an event delta (e.g. only the latest turn)."""
        del custom_metadata  # No implementation-specific keys supported yet.
        await self._capture_events(
            app_name=app_name,
            user_id=user_id,
            session_id=session_id or _UNKNOWN_SESSION_ID,
            events=events,
        )

    async def _capture_events(
        self,
        *,
        app_name: str,
        user_id: str,
        session_id: str,
        events: Sequence[Any],
    ) -> None:
        session_key = self._session_key(app_name, user_id, session_id)
        turns = pair_turns(events)
        new_turns: list[Turn] = []
        with self._lock:
            seen = self._captured.setdefault(session_key, set())
            for turn in turns:
                # A turn with no event IDs cannot be tracked — capture it
                # unconditionally rather than silently dropping it.
                if turn.event_ids and all(eid in seen for eid in turn.event_ids):
                    continue
                seen.update(turn.event_ids)
                new_turns.append(turn)

        for turn in new_turns:
            try:
                result = await asyncio.to_thread(
                    self._client.capture,
                    turn.user_text,
                    turn.assistant_text,
                    session_key,
                    session_id=session_id,
                    user_id=user_id,
                    messages=turn.messages,
                )
                logger.debug(
                    "tdai capture ok (session=%s l0=%s)",
                    session_key,
                    result.get("l0_recorded"),
                )
            except TdaiGatewayError as exc:
                # Roll back the dedup marks so a Gateway blip does not
                # permanently skip these turns on the next ingestion.
                with self._lock:
                    self._captured.get(session_key, set()).difference_update(turn.event_ids)
                if self._strict:
                    raise
                logger.warning("tdai capture failed (session=%s): %s", session_key, exc)

    # -- search --------------------------------------------------------------

    async def search_memory(
        self,
        *,
        app_name: str,
        user_id: str,
        query: str,
    ) -> SearchMemoryResponse:
        """Search structured memories (and optionally raw conversations)."""
        del app_name, user_id  # The local Gateway store is single-tenant.
        response = SearchMemoryResponse()

        try:
            memories = await asyncio.to_thread(
                self._client.search_memories, query, limit=self._search_limit
            )
        except TdaiGatewayError as exc:
            if self._strict:
                raise
            logger.warning("tdai memory search failed: %s", exc)
            return response
        self._append_entry(
            response,
            text=str(memories.get("results") or ""),
            total=memories.get("total"),
            source="memories",
            strategy=memories.get("strategy"),
        )

        if self._include_conversations:
            try:
                conversations = await asyncio.to_thread(
                    self._client.search_conversations, query, limit=self._search_limit
                )
            except TdaiGatewayError as exc:
                if self._strict:
                    raise
                logger.warning("tdai conversation search failed: %s", exc)
                return response
            self._append_entry(
                response,
                text=str(conversations.get("results") or ""),
                total=conversations.get("total"),
                source="conversations",
                strategy=None,
            )

        return response

    @staticmethod
    def _append_entry(
        response: SearchMemoryResponse,
        *,
        text: str,
        total: Any,
        source: str,
        strategy: Any,
    ) -> None:
        """Append one MemoryEntry per non-empty Gateway result blob.

        The Gateway returns pre-formatted text blocks (not per-record
        rows), so each backend contributes at most one entry; the metadata
        records provenance and hit counts for downstream prompt builders.
        """
        if not text.strip() or not total:
            return
        metadata: dict[str, Any] = {"tdai.source": source, "tdai.total": total}
        if strategy:
            metadata["tdai.strategy"] = strategy
        response.memories.append(
            MemoryEntry(
                content=types.Content(role="model", parts=[types.Part(text=text)]),
                author=_MEMORY_AUTHOR,
                custom_metadata=metadata,
            )
        )

    # -- session lifecycle ----------------------------------------------------

    async def end_session(
        self,
        *,
        app_name: str,
        user_id: str,
        session_id: str,
    ) -> None:
        """Flush the Gateway pipeline for one session (``POST /session/end``).

        ADK has no memory-service session-end hook; call this from your app
        when a conversation finishes so L1→L3 processing runs promptly.
        Fail-open like the rest of the service.
        """
        session_key = self._session_key(app_name, user_id, session_id)
        try:
            await asyncio.to_thread(self._client.session_end, session_key, user_id)
        except TdaiGatewayError as exc:
            if self._strict:
                raise
            logger.warning("tdai session end failed (session=%s): %s", session_key, exc)
