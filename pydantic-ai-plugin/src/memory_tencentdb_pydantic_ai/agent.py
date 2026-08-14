from __future__ import annotations

import logging
from typing import Any

from pydantic_ai import Agent, AgentRunResult

from .client import GatewayClient
from .errors import GatewayError
from .identity import MemoryIdentity
from .serialization import serialize_output
from .tools import create_memory_toolset

logger = logging.getLogger(__name__)

MEMORY_INSTRUCTION_PREFIX = (
    "TencentDB Agent Memory recalled the following context. "
    "Use it only when relevant and do not claim it is newer than the "
    "current user message:\n"
)


def _merge_instructions(existing: Any, context: str) -> Any:
    if not context.strip():
        return existing
    memory_instruction = MEMORY_INSTRUCTION_PREFIX + context.strip()
    if existing is None:
        return memory_instruction
    if isinstance(existing, (list, tuple)):
        return [*existing, memory_instruction]
    return [existing, memory_instruction]


def _merge_toolsets(existing: Any, memory_toolset: Any) -> list[Any]:
    return [*(existing or ()), memory_toolset]


class TencentDBMemoryAgent:
    def __init__(
        self,
        agent: Agent[Any, Any],
        client: GatewayClient,
        *,
        strict: bool = False,
    ) -> None:
        self._agent = agent
        self._client = client
        self._strict = strict

    @property
    def agent(self) -> Agent[Any, Any]:
        return self._agent

    async def run(
        self,
        user_prompt: str,
        *,
        user_id: str,
        session_id: str,
        session_key: str | None = None,
        **run_kwargs: Any,
    ) -> AgentRunResult[Any]:
        if not isinstance(user_prompt, str):
            raise TypeError(
                "TencentDBMemoryAgent currently supports text prompts only"
            )

        identity = MemoryIdentity.create(
            user_id,
            session_id,
            session_key=session_key,
        )
        context = await self._recall_async(user_prompt, identity)
        memory_toolset = create_memory_toolset(
            self._client,
            identity,
            strict=self._strict,
        )
        run_kwargs["instructions"] = _merge_instructions(
            run_kwargs.get("instructions"),
            context,
        )
        run_kwargs["toolsets"] = _merge_toolsets(
            run_kwargs.get("toolsets"),
            memory_toolset,
        )

        result = await self._agent.run(user_prompt, **run_kwargs)
        await self._capture_async(user_prompt, result.output, identity)
        return result

    def run_sync(
        self,
        user_prompt: str,
        *,
        user_id: str,
        session_id: str,
        session_key: str | None = None,
        **run_kwargs: Any,
    ) -> AgentRunResult[Any]:
        if not isinstance(user_prompt, str):
            raise TypeError(
                "TencentDBMemoryAgent currently supports text prompts only"
            )

        identity = MemoryIdentity.create(
            user_id,
            session_id,
            session_key=session_key,
        )
        context = self._recall_sync(user_prompt, identity)
        memory_toolset = create_memory_toolset(
            self._client,
            identity,
            strict=self._strict,
        )
        run_kwargs["instructions"] = _merge_instructions(
            run_kwargs.get("instructions"),
            context,
        )
        run_kwargs["toolsets"] = _merge_toolsets(
            run_kwargs.get("toolsets"),
            memory_toolset,
        )

        result = self._agent.run_sync(user_prompt, **run_kwargs)
        self._capture_sync(user_prompt, result.output, identity)
        return result

    async def end_session(
        self,
        *,
        user_id: str,
        session_id: str,
        session_key: str | None = None,
    ) -> bool:
        identity = MemoryIdentity.create(
            user_id,
            session_id,
            session_key=session_key,
        )
        try:
            response = await self._client.aend_session(
                identity.session_key,
                identity.user_id,
            )
            return bool(response["flushed"])
        except GatewayError as exc:
            if self._strict:
                raise
            logger.warning("TencentDB session end unavailable: %s", exc)
            return False

    def end_session_sync(
        self,
        *,
        user_id: str,
        session_id: str,
        session_key: str | None = None,
    ) -> bool:
        identity = MemoryIdentity.create(
            user_id,
            session_id,
            session_key=session_key,
        )
        try:
            response = self._client.end_session(
                identity.session_key,
                identity.user_id,
            )
            return bool(response["flushed"])
        except GatewayError as exc:
            if self._strict:
                raise
            logger.warning("TencentDB session end unavailable: %s", exc)
            return False

    async def _recall_async(
        self,
        user_prompt: str,
        identity: MemoryIdentity,
    ) -> str:
        try:
            response = await self._client.arecall(
                user_prompt,
                identity.session_key,
                identity.user_id,
            )
            return str(response["context"])
        except GatewayError as exc:
            if self._strict:
                raise
            logger.warning("TencentDB recall unavailable: %s", exc)
            return ""

    async def _capture_async(
        self,
        user_prompt: str,
        output: Any,
        identity: MemoryIdentity,
    ) -> None:
        try:
            await self._client.acapture(
                user_prompt,
                serialize_output(output),
                identity.session_key,
                identity.session_id,
                identity.user_id,
            )
        except GatewayError as exc:
            if self._strict:
                raise
            logger.warning("TencentDB capture unavailable: %s", exc)

    def _recall_sync(
        self,
        user_prompt: str,
        identity: MemoryIdentity,
    ) -> str:
        try:
            response = self._client.recall(
                user_prompt,
                identity.session_key,
                identity.user_id,
            )
            return str(response["context"])
        except GatewayError as exc:
            if self._strict:
                raise
            logger.warning("TencentDB recall unavailable: %s", exc)
            return ""

    def _capture_sync(
        self,
        user_prompt: str,
        output: Any,
        identity: MemoryIdentity,
    ) -> None:
        try:
            self._client.capture(
                user_prompt,
                serialize_output(output),
                identity.session_key,
                identity.session_id,
                identity.user_id,
            )
        except GatewayError as exc:
            if self._strict:
                raise
            logger.warning("TencentDB capture unavailable: %s", exc)
