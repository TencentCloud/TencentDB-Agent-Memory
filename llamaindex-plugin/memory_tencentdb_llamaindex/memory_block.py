"""Native LlamaIndex memory block backed by the TDAI Gateway."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from llama_index.core.base.llms.types import ChatMessage
from llama_index.core.memory import BaseMemoryBlock
from memory_tencentdb_gateway import TdaiGatewayClient
from pydantic import Field, PrivateAttr, model_validator


class TencentDBMemoryBlock(BaseMemoryBlock[str]):
    """Recall and archive long-term memory through LlamaIndex's block lifecycle."""

    name: str = "tencentdb-agent-memory"
    description: str | None = "Long-term context from TencentDB Agent Memory"
    priority: int = 10
    gateway_url: str = "http://127.0.0.1:8420"
    gateway_api_key: str | None = Field(default=None, exclude=True, repr=False)
    gateway_timeout: float = Field(default=10.0, gt=0)
    session_key: str | None = None
    session_key_prefix: str = "llamaindex"
    user_id: str | None = None
    search_limit: int = Field(default=5, ge=1, le=20)
    strict: bool = False

    _client: TdaiGatewayClient = PrivateAttr()
    _logger: logging.Logger = PrivateAttr(
        default_factory=lambda: logging.getLogger(__name__)
    )

    @model_validator(mode="after")
    def validate_identity(self) -> "TencentDBMemoryBlock":
        if self.session_key is not None:
            self.session_key = self.session_key.strip()
            if not self.session_key:
                raise ValueError("session_key must contain non-whitespace characters")
        self.session_key_prefix = self.session_key_prefix.strip().strip(":")
        if not self.session_key_prefix:
            raise ValueError("session_key_prefix must contain non-whitespace characters")
        return self

    def model_post_init(self, __context: Any) -> None:
        self._client = TdaiGatewayClient(
            self.gateway_url,
            api_key=self.gateway_api_key,
            timeout=self.gateway_timeout,
        )

    @classmethod
    def class_name(cls) -> str:
        return "TencentDBMemoryBlock"

    @classmethod
    def from_defaults(cls, **kwargs: Any) -> "TencentDBMemoryBlock":
        return cls(**kwargs)

    async def _aget(
        self,
        messages: list[ChatMessage] | None = None,
        **block_kwargs: Any,
    ) -> str:
        query = _query_from_messages(messages or [])
        if not query:
            return ""
        session_key = self._effective_session_key(block_kwargs.get("session_id"))
        try:
            recall, search = await asyncio.gather(
                asyncio.to_thread(
                    self._client.recall,
                    query,
                    session_key,
                    user_id=self.user_id,
                ),
                asyncio.to_thread(
                    self._client.search_memories,
                    query,
                    limit=self.search_limit,
                ),
            )
            return _format_context(recall, search)
        except Exception as error:
            if self.strict:
                raise
            self._logger.warning("TencentDB memory recall failed open: %s", error)
            return ""

    async def _aput(self, messages: list[ChatMessage]) -> None:
        if not messages:
            return
        session_id = next(
            (
                str(value)
                for message in reversed(messages)
                if (value := message.additional_kwargs.get("session_id"))
            ),
            None,
        )
        session_key = self._effective_session_key(session_id)
        user_content, assistant_content = _capture_pair(messages)
        if not user_content and not assistant_content:
            return
        try:
            await asyncio.to_thread(
                self._client.capture,
                user_content or "(no user message in archived batch)",
                assistant_content or "(no assistant message in archived batch)",
                session_key,
                session_id=session_id or session_key,
                user_id=self.user_id,
            )
        except Exception as error:
            if self.strict:
                raise
            self._logger.warning("TencentDB memory capture failed open: %s", error)

    async def aclose(self, session_id: str | None = None) -> None:
        """Flush the Gateway session associated with this block."""
        session_key = self._effective_session_key(session_id)
        try:
            await asyncio.to_thread(
                self._client.end_session,
                session_key,
                user_id=self.user_id,
            )
        except Exception as error:
            if self.strict:
                raise
            self._logger.warning("TencentDB session flush failed open: %s", error)

    def _effective_session_key(self, session_id: Any) -> str:
        if self.session_key:
            return self.session_key
        suffix = str(session_id or "default").strip() or "default"
        return f"{self.session_key_prefix}:{suffix}"


def _query_from_messages(messages: list[ChatMessage]) -> str:
    for message in reversed(messages):
        content = (message.content or "").strip()
        if content and message.role.value == "user":
            return content
    for message in reversed(messages):
        content = (message.content or "").strip()
        if content:
            return content
    return ""


def _capture_pair(messages: list[ChatMessage]) -> tuple[str, str]:
    user_lines: list[str] = []
    assistant_lines: list[str] = []
    for message in messages:
        content = (message.content or "").strip()
        if not content:
            continue
        role = message.role.value
        line = f"{role}: {content}"
        if role == "user":
            user_lines.append(line)
        else:
            assistant_lines.append(line)
    return "\n".join(user_lines), "\n".join(assistant_lines)


def _format_context(recall: dict[str, Any], search: dict[str, Any]) -> str:
    sections: list[str] = []
    for value in (recall.get("context"), search.get("results")):
        if isinstance(value, str):
            normalized = value.strip()
            if normalized and normalized not in sections:
                sections.append(normalized)
    return "\n\n".join(sections)
