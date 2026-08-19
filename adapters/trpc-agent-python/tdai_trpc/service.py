"""TencentDBMemoryService: a trpc-agent-python memory service backed by the
TencentDB Agent Memory gateway.

Implements the framework's ``MemoryServiceABC`` contract (``store_session`` /
``search_memory`` / ``close``) the same way the built-in remote memory
services do, so it plugs into ``Runner(memory_service=...)`` without any
framework changes:

- ``store_session``: incrementally streams each completed user/assistant
  turn of a session to ``POST /capture`` (L0). The gateway owns extraction,
  storage, and the L0 → L3 pipeline; this service never extracts locally.
- ``search_memory``: resolves the two-level key (``session.save_key`` →
  gateway user scope, ``session.id`` → gateway session scope) and queries
  ``POST /search/memories``, mapping results into the framework's
  ``SearchMemoryResponse``.
- ``close``: releases the underlying HTTP client.

Identity follows the framework convention: the session's ``save_key``
(``{app}/{user}``) is the primary scope, exactly like the built-in Mem0
service. Config values are only fallbacks.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from trpc_agent_sdk.abc import MemoryServiceABC as BaseMemoryService
from trpc_agent_sdk.abc import MemoryServiceConfig
from trpc_agent_sdk.context import AgentContext
from trpc_agent_sdk.log import logger
from trpc_agent_sdk.sessions import Session
from trpc_agent_sdk.types import Content
from trpc_agent_sdk.types import MemoryEntry
from trpc_agent_sdk.types import Part
from trpc_agent_sdk.types import SearchMemoryResponse

from .config import TDAiConfig
from .gateway_client import (
    CaptureRequest,
    GatewayMessage,
    MemoryGatewayClient,
    default_session_key,
    now_ts,
)

_EVENT_ROLE_USER = "user"


def _event_to_role(event: Any) -> str:
    """Map a framework event author to a chat role (user/assistant)."""
    return _EVENT_ROLE_USER if getattr(event, "author", None) == _EVENT_ROLE_USER else "assistant"


def _event_to_text(event: Any) -> str:
    """Extract joined text parts from an event's content."""
    content = getattr(event, "content", None)
    parts = getattr(content, "parts", None)
    if not parts:
        return ""
    texts = [part.text for part in parts if getattr(part, "text", None)]
    return " ".join(texts).strip()


class TencentDBMemoryService(BaseMemoryService):
    """Memory service storing/searching through the TencentDB gateway.

    Two-level key strategy (mirrors the built-in Mem0 service):
    - level 1 (primary): ``session.save_key`` → gateway user scope
    - level 2 (sub-key): ``session.id`` → gateway session scope
    """

    def __init__(
        self,
        tdai_config: Optional[TDAiConfig] = None,
        memory_service_config: Optional[MemoryServiceConfig] = None,
        client: Optional[MemoryGatewayClient] = None,
        validate_config: bool = True,
    ) -> None:
        """Initialize the service.

        Args:
            tdai_config: Gateway settings (URL, key, timeouts, fail-open).
            memory_service_config: Framework memory-service settings; when
                omitted, an enabled no-TTL config is used so the runner's
                post-turn persistence calls ``store_session``.
            client: Optional pre-built gateway client (tests inject fakes).
            validate_config: Skip config validation when False (for callers
                that construct their own transport).
        """
        self._tdai = tdai_config or TDAiConfig()
        if validate_config:
            self._tdai.validate()
        if memory_service_config is None:
            memory_service_config = MemoryServiceConfig(enabled=True)
            memory_service_config.clean_ttl_config()
        super().__init__(memory_service_config=memory_service_config)
        self._client = client or MemoryGatewayClient(
            gateway_url=self._tdai.gateway_url,
            api_key=self._tdai.api_key,
            timeout=self._tdai.timeout,
        )
        self._owns_client = client is None
        # Watermark of the last captured event position per session id, so
        # repeated store_session calls (runner calls after every turn) only
        # send the delta instead of replaying the whole transcript.
        self._captured_counts: dict[str, int] = {}

    @property
    def tdai_config(self) -> TDAiConfig:
        return self._tdai

    @property
    def client(self) -> MemoryGatewayClient:
        return self._client

    # ------------------------------------------------------------------
    # MemoryServiceABC
    # ------------------------------------------------------------------

    async def store_session(
        self, session: Session, agent_context: Optional[AgentContext] = None
    ) -> None:
        """Store the uncaptured delta of a session into the gateway.

        Only completed user/assistant pairs are captured; a trailing lone
        user message waits for its assistant reply. The per-session
        watermark advances only after a successful gateway response, so a
        failed capture is retried on the next call.

        Failures are logged and swallowed when ``fail_open`` (default), so a
        gateway outage never breaks the agent loop.
        """
        if not self.enabled:
            return
        try:
            await self._store_session_inner(session)
        except Exception as exc:  # pylint: disable=broad-except
            if self._tdai.fail_open:
                logger.warning(
                    "Failed to store session in TencentDB Agent Memory. "
                    "save_key=%s, session_id=%s, err=%s",
                    getattr(session, "save_key", "?"),
                    getattr(session, "id", "?"),
                    exc,
                )
            else:
                raise

    async def _store_session_inner(self, session: Session) -> None:
        events = list(getattr(session, "events", []) or [])
        session_id = str(getattr(session, "id", "") or "")
        if not session_id:
            return
        start = self._captured_counts.get(session_id, 0)
        delta = events[start:]
        if not delta:
            return

        user_text = ""
        assistant_text = ""
        gateway_messages: list[GatewayMessage] = []
        for event in delta:
            text = _event_to_text(event)
            if not text:
                continue
            role = _event_to_role(event)
            gateway_messages.append(
                GatewayMessage(role=role, content=text, timestamp=now_ts())
            )
            if role == _EVENT_ROLE_USER and not user_text:
                user_text = text
            elif role != _EVENT_ROLE_USER and not assistant_text:
                assistant_text = text

        if gateway_messages and not (user_text and assistant_text):
            # Incomplete turn; wait for the assistant reply before capturing.
            return
        if not gateway_messages:
            self._captured_counts[session_id] = len(events)
            return

        app_name, user_id = self._resolve_scope(session)
        request = CaptureRequest(
            user_content=user_text,
            assistant_content=assistant_text,
            session_key=default_session_key(app_name, user_id, session_id),
            session_id=session_id,
            user_id=user_id,
            messages=gateway_messages,
        )
        await self._client.capture(request)
        self._captured_counts[session_id] = len(events)

    async def search_memory(
        self,
        key: str,
        query: str,
        limit: int = 10,
        agent_context: Optional[AgentContext] = None,
    ) -> SearchMemoryResponse:
        """Search long-term memories for the user behind ``key`` (save_key)."""
        response = SearchMemoryResponse()
        if not self.enabled:
            return response
        app_name, user_id = self._resolve_save_key(key)
        try:
            result = await self._client.search_memories(query=query, limit=limit, user_id=user_id)
        except Exception as exc:  # pylint: disable=broad-except
            if self._tdai.fail_open:
                logger.warning(
                    "Failed to search TencentDB Agent Memory. key=%s, query=%s, err=%s",
                    key,
                    query,
                    exc,
                )
                return response
            raise
        if result.results:
            response.memories.append(
                MemoryEntry(
                    content=Content(parts=[Part.from_text(text=result.results)], role="assistant"),
                    author="tencentdb-memory",
                    timestamp=datetime.now().isoformat(),
                )
            )
        return response

    async def close(self) -> None:
        """Release the underlying HTTP client when owned by this service."""
        if self._owns_client:
            await self._client.close()

    # ------------------------------------------------------------------
    # Non-contract helpers (optional lifecycle conveniences)
    # ------------------------------------------------------------------

    async def health(self):
        """Probe the gateway readiness endpoint."""
        return await self._client.health()

    async def end_session(self, session: Session) -> bool:
        """Flush gateway-side session state (``POST /session/end``)."""
        session_id = str(getattr(session, "id", "") or "")
        app_name, user_id = self._resolve_scope(session)
        try:
            return await self._client.end_session(
                session_key=default_session_key(app_name, user_id, session_id),
                user_id=user_id,
            )
        except Exception as exc:  # pylint: disable=broad-except
            if self._tdai.fail_open:
                logger.warning("TencentDB end_session failed: %s", exc)
                return False
            raise

    # ------------------------------------------------------------------
    # Identity mapping
    # ------------------------------------------------------------------

    def _resolve_scope(self, session: Session) -> tuple[str, str]:
        """Resolve (app_name, user_id) from the session, with config fallback."""
        save_key = str(getattr(session, "save_key", "") or "")
        session_id = str(getattr(session, "id", "") or "")
        app_name, user_id = self._resolve_save_key(save_key)
        # save_key does not carry the session id; keep it out of the app/user
        # scope and use the framework session id for the session dimension.
        del session_id
        return app_name, user_id

    def _resolve_save_key(self, save_key: str) -> tuple[str, str]:
        """Parse ``{app}/{user}`` save_key into (app, user).

        Falls back to the configured identity when the key is empty or has
        no ``/`` separator.
        """
        key = (save_key or "").strip()
        if not key:
            return self._tdai.app_name, self._tdai.user_id
        parts = key.split("/", 1)
        if len(parts) == 2 and parts[1].strip():
            return parts[0].strip(), parts[1].strip()
        return self._tdai.app_name, key
