"""PydanticAI capability that recalls and captures TencentDB memory."""

from __future__ import annotations

import copy
import inspect
import json
import logging
from collections.abc import Awaitable, Callable, Sequence
from typing import Any, TypeAlias

from pydantic_ai import AgentRunResult, RunContext
from pydantic_ai.capabilities import AbstractCapability

from .client import GatewayClientProtocol, TdaiGatewayClient, TdaiGatewayError

logger = logging.getLogger(__name__)

Resolver: TypeAlias = str | Callable[[RunContext[Any]], str | Awaitable[str]]


async def _resolve(
    resolver: Resolver,
    ctx: RunContext[Any],
    label: str,
) -> str:
    value = resolver(ctx) if callable(resolver) else resolver
    if inspect.isawaitable(value):
        value = await value
    resolved = str(value).strip()
    if label == "session key" and not resolved:
        raise ValueError("TencentDB memory session key must not be empty")
    return resolved


def _prompt_text(prompt: object) -> str:
    if isinstance(prompt, str):
        return prompt.strip()
    if isinstance(prompt, Sequence) and not isinstance(prompt, (bytes, bytearray)):
        return "\n".join(
            item.strip()
            for item in prompt
            if isinstance(item, str) and item.strip()
        )
    return ""


def _output_text(output: object) -> str:
    if isinstance(output, str):
        return output
    if hasattr(output, "model_dump"):
        output = output.model_dump(mode="json")
    try:
        return json.dumps(
            output,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    except (TypeError, ValueError):
        return str(output)


class TencentDBMemoryCapability(AbstractCapability[Any]):
    """Add automatic memory recall and capture to a PydanticAI agent."""

    def __init__(
        self,
        *,
        session_key: Resolver,
        user_id: Resolver = "default_user",
        base_url: str = "http://127.0.0.1:8420",
        timeout: float = 10.0,
        api_key: str | None = None,
        client: GatewayClientProtocol | None = None,
    ) -> None:
        self._session_resolver = session_key
        self._user_resolver = user_id
        self._client = client or TdaiGatewayClient(
            base_url,
            timeout=timeout,
            api_key=api_key,
        )
        self._resolved_session_key = ""
        self._resolved_user_id = ""
        self._recall_loaded = False
        self._recall_context = ""

    async def for_run(
        self,
        ctx: RunContext[Any],
    ) -> TencentDBMemoryCapability:
        run_capability = copy.copy(self)
        run_capability._resolved_session_key = await _resolve(
            self._session_resolver,
            ctx,
            "session key",
        )
        run_capability._resolved_user_id = await _resolve(
            self._user_resolver,
            ctx,
            "user ID",
        )
        run_capability._recall_loaded = False
        run_capability._recall_context = ""
        return run_capability

    def get_instructions(self):
        async def recall(ctx: RunContext[Any]) -> str:
            if self._recall_loaded:
                return self._recall_context
            self._recall_loaded = True
            query = _prompt_text(ctx.prompt)
            if not query:
                return ""
            try:
                response = await self._client.recall(
                    query,
                    self._resolved_session_key,
                    self._resolved_user_id,
                )
                context = response.get("context", "")
                self._recall_context = context if isinstance(context, str) else ""
            except TdaiGatewayError as exc:
                logger.warning("TencentDB memory recall unavailable: %s", exc)
            return self._recall_context

        return recall

    async def after_run(
        self,
        ctx: RunContext[Any],
        *,
        result: AgentRunResult[Any],
    ) -> AgentRunResult[Any]:
        user_text = _prompt_text(ctx.prompt)
        assistant_text = _output_text(result.output)
        if user_text and assistant_text:
            try:
                await self._client.capture(
                    user_text,
                    assistant_text,
                    self._resolved_session_key,
                    user_id=self._resolved_user_id,
                )
            except TdaiGatewayError as exc:
                logger.warning("TencentDB memory capture unavailable: %s", exc)
        return result
