"""Native CrewAI ``Memory`` implementation backed by the TDAI Gateway."""

from __future__ import annotations

import asyncio
import logging
import threading
from typing import Any, Literal

from crewai.memory import Memory, MemoryMatch, MemoryRecord
from memory_tencentdb_gateway import TdaiGatewayClient
from pydantic import Field, PrivateAttr


class TencentDBMemory(Memory):
    """Use TencentDB Agent Memory through CrewAI's native memory lifecycle.

    CrewAI calls ``recall`` before agent work and ``remember_many`` after it
    extracts durable insights. This adapter maps those calls to the existing
    Gateway without starting CrewAI's default LanceDB or embedding pipeline.
    """

    gateway_url: str = Field(default="http://127.0.0.1:8420")
    gateway_api_key: str | None = Field(default=None, exclude=True, repr=False)
    gateway_timeout: float = Field(default=10.0, gt=0)
    session_key: str = Field(default="crewai:default", min_length=1)
    user_id: str | None = Field(default=None)
    strict: bool = Field(
        default=False,
        description="Raise Gateway failures instead of degrading to empty memory.",
    )

    _client: TdaiGatewayClient = PrivateAttr()
    _logger: logging.Logger = PrivateAttr(
        default_factory=lambda: logging.getLogger(__name__)
    )
    _failures: list[BaseException] = PrivateAttr(default_factory=list)
    _failure_lock: threading.Lock = PrivateAttr(default_factory=threading.Lock)
    _closed: bool = PrivateAttr(default=False)

    def model_post_init(self, __context: Any) -> None:
        """Initialize only the Gateway client, not CrewAI's local memory stack."""
        session_key = self.session_key.strip()
        if not session_key:
            raise ValueError("session_key must contain non-whitespace characters")
        self.session_key = session_key
        self._client = TdaiGatewayClient(
            self.gateway_url,
            api_key=self.gateway_api_key,
            timeout=self.gateway_timeout,
        )

    def recall(
        self,
        query: str,
        scope: str | None = None,
        categories: list[str] | None = None,
        limit: int = 10,
        depth: Literal["shallow", "deep"] = "deep",
        source: str | None = None,
        include_private: bool = False,
    ) -> list[MemoryMatch]:
        del categories, depth, include_private
        query = query.strip()
        if not query:
            return []
        try:
            self.drain_writes()
            recall = self._client.recall(
                query,
                self.session_key,
                user_id=self.user_id,
            )
            search = self._client.search_memories(query, limit=limit)
            return self._to_matches(
                recall,
                search,
                scope=scope,
                source=source,
            )
        except Exception as error:
            return self._handle_recall_failure(error)

    def remember(
        self,
        content: str,
        scope: str | None = None,
        categories: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        importance: float | None = None,
        source: str | None = None,
        private: bool = False,
        agent_role: str | None = None,
        root_scope: str | None = None,
    ) -> MemoryRecord | None:
        del private
        content = content.strip()
        if not content or self.read_only:
            return None
        try:
            self._capture([content], agent_role=agent_role)
        except Exception as error:
            if self.strict:
                raise
            self._logger.warning("TencentDB memory capture failed open: %s", error)
            return None
        return MemoryRecord(
            content=content,
            scope=self._effective_scope(scope, root_scope),
            categories=categories or [],
            metadata={"platform": "crewai", **(metadata or {})},
            importance=importance if importance is not None else 0.5,
            source=source or self.user_id or self.session_key,
        )

    def remember_many(
        self,
        contents: list[str],
        scope: str | None = None,
        categories: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        importance: float | None = None,
        source: str | None = None,
        private: bool = False,
        agent_role: str | None = None,
        root_scope: str | None = None,
    ) -> list[MemoryRecord]:
        del scope, categories, metadata, importance, source, private, root_scope
        normalized = [item.strip() for item in contents if item.strip()]
        if not normalized or self.read_only:
            return []
        self._submit_gateway_save(normalized, agent_role)
        return []

    def _submit_gateway_save(
        self,
        contents: list[str],
        agent_role: str | None,
    ) -> None:
        """Queue a write without assuming CrewAI's internal event scope."""
        future = self._save_pool.submit(self._capture_background, contents, agent_role)
        with self._pending_lock:
            self._pending_saves.append(future)

        def discard(completed: Any) -> None:
            with self._pending_lock:
                if completed in self._pending_saves:
                    self._pending_saves.remove(completed)

        future.add_done_callback(discard)

    async def aremember(
        self,
        content: str,
        **kwargs: Any,
    ) -> MemoryRecord | None:
        return await asyncio.to_thread(self.remember, content, **kwargs)

    async def aremember_many(
        self,
        contents: list[str],
        **kwargs: Any,
    ) -> list[MemoryRecord]:
        return self.remember_many(contents, **kwargs)

    async def arecall(self, query: str, **kwargs: Any) -> list[MemoryMatch]:
        return await asyncio.to_thread(self.recall, query, **kwargs)

    def drain_writes(self) -> None:
        super().drain_writes()
        if self.strict:
            with self._failure_lock:
                if self._failures:
                    raise self._failures.pop(0)

    def reset(self) -> None:
        message = (
            "TencentDBMemory does not expose a remote reset operation; "
            "use the Gateway's data-management workflow explicitly"
        )
        if self.strict:
            raise NotImplementedError(message)
        self._logger.warning(message)

    async def areset(self, **_: Any) -> None:
        self.reset()

    def close(self) -> None:
        if self._closed:
            return
        try:
            self.drain_writes()
            self._client.end_session(self.session_key, user_id=self.user_id)
        except Exception as error:
            if self.strict:
                raise
            self._logger.warning("TencentDB session flush failed open: %s", error)
        finally:
            self._save_pool.shutdown(wait=True)
            self._closed = True

    def _capture_background(
        self,
        contents: list[str],
        agent_role: str | None,
    ) -> None:
        try:
            self._capture(contents, agent_role=agent_role)
        except Exception as error:
            with self._failure_lock:
                self._failures.append(error)
            if self.strict:
                raise
            self._logger.warning("TencentDB memory capture failed open: %s", error)

    def _capture(self, contents: list[str], *, agent_role: str | None) -> None:
        heading = "CrewAI extracted durable memory"
        if agent_role:
            heading += f" for agent role {agent_role}"
        assistant_content = "\n".join(
            f"{index}. {content}" for index, content in enumerate(contents, start=1)
        )
        self._client.capture(
            heading,
            assistant_content,
            self.session_key,
            session_id=self.session_key,
            user_id=self.user_id,
        )

    def _to_matches(
        self,
        recall: dict[str, Any],
        search: dict[str, Any],
        *,
        scope: str | None,
        source: str | None,
    ) -> list[MemoryMatch]:
        blocks: list[tuple[str, float, dict[str, Any]]] = []
        context = recall.get("context")
        if isinstance(context, str) and context.strip():
            blocks.append(
                (
                    context.strip(),
                    1.0,
                    {
                        "kind": "recall",
                        "strategy": recall.get("strategy"),
                        "memory_count": recall.get("memory_count"),
                    },
                )
            )
        results = search.get("results")
        if isinstance(results, str) and results.strip():
            blocks.append(
                (
                    results.strip(),
                    0.9,
                    {
                        "kind": "memory_search",
                        "strategy": search.get("strategy"),
                        "total": search.get("total"),
                    },
                )
            )

        matches: list[MemoryMatch] = []
        seen: set[str] = set()
        for content, score, metadata in blocks:
            if content in seen:
                continue
            seen.add(content)
            matches.append(
                MemoryMatch(
                    record=MemoryRecord(
                        content=content,
                        scope=self._effective_scope(scope, None),
                        categories=["tencentdb-agent-memory"],
                        metadata={"platform": "crewai", **metadata},
                        source=source or self.user_id or self.session_key,
                    ),
                    score=score,
                    match_reasons=[metadata["kind"]],
                )
            )
        return matches

    def _effective_scope(
        self,
        scope: str | None,
        root_scope: str | None,
    ) -> str:
        return root_scope or scope or self.root_scope or f"/crewai/{self.session_key}"

    def _handle_recall_failure(self, error: Exception) -> list[MemoryMatch]:
        if self.strict:
            raise error
        self._logger.warning("TencentDB memory recall failed open: %s", error)
        return []
