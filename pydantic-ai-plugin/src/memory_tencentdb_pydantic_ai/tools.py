from __future__ import annotations

import logging
from typing import Any

from pydantic_ai import FunctionToolset

from .client import GatewayClient
from .errors import GatewayError
from .identity import MemoryIdentity

logger = logging.getLogger(__name__)


def create_memory_toolset(
    client: GatewayClient,
    identity: MemoryIdentity,
    *,
    strict: bool,
) -> FunctionToolset[Any]:
    toolset: FunctionToolset[Any] = FunctionToolset(
        instructions=(
            "Use memory_search for relevant long-term facts and preferences. "
            "Use conversation_search for evidence from earlier turns."
        )
    )

    @toolset.tool_plain
    async def memory_search(
        query: str,
        limit: int = 5,
        memory_type: str | None = None,
        scene: str | None = None,
    ) -> dict[str, Any]:
        """Search relevant long-term memory for the current user."""
        try:
            return await client.asearch_memories(
                query,
                limit,
                memory_type,
                scene,
            )
        except GatewayError as exc:
            if strict:
                raise
            logger.warning("TencentDB memory_search unavailable: %s", exc)
            return {
                "available": False,
                "error": "memory service unavailable",
                "results": "",
            }

    @toolset.tool_plain
    async def conversation_search(
        query: str,
        limit: int = 5,
    ) -> dict[str, Any]:
        """Search earlier conversation evidence in the current session."""
        try:
            return await client.asearch_conversations(
                query,
                limit,
                identity.session_key,
            )
        except GatewayError as exc:
            if strict:
                raise
            logger.warning(
                "TencentDB conversation_search unavailable: %s",
                exc,
            )
            return {
                "available": False,
                "error": "memory service unavailable",
                "results": "",
            }

    return toolset
