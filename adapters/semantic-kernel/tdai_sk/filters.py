"""Automatic recall via Semantic Kernel's PROMPT_RENDERING filter.

Registered by :meth:`TencentDBAgentMemory.attach`; runs before the agent's
instructions are rendered on every turn, fetches recalled context from the
gateway, and injects it either into the rendered instructions (``append``
mode, default) or into the ``{{TDaiMemory}}`` template variable
(``template`` mode). Failures respect the ``fail_open`` config.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from semantic_kernel.filters import PromptRenderContext

from .config import TDAiConfig
from .format import format_recall_context
from .gateway_client import MemoryGatewayClient

logger = logging.getLogger(__name__)

MEMORY_PLACEHOLDER = "TDaiMemory"
"""Template variable name used in ``recall_mode="template"`` injection."""


def latest_user_query(context: "PromptRenderContext") -> str:
    """Best-effort extraction of the latest user text from render context."""
    for key in ("input", "user_input", "query"):
        value = context.arguments.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


async def render_recall(
    context: "PromptRenderContext",
    config: TDAiConfig,
    client: MemoryGatewayClient,
    session_key: str,
) -> None:
    """Fetch recalled context for the current prompt and inject it.

    The recalled block is bounded, sanitized, and marked untrusted by
    :func:`format_recall_context` before it touches any prompt surface.
    """
    assert config.recall_mode != "off"
    query = latest_user_query(context)
    if not query:
        return
    try:
        recall = await client.recall(
            query=query, session_key=session_key, user_id=config.user_id
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("tdai recall failed: %s", exc)
        if config.fail_open:
            return
        raise
    block = format_recall_context(
        recall.context or recall.prepend_context, config.max_context_chars
    )
    if not block:
        return
    if config.recall_mode == "template":
        context.arguments[MEMORY_PLACEHOLDER] = block
        return
    current = context.arguments.get("instructions") or ""
    context.arguments["instructions"] = (
        f"{current}\n\n{block}" if current.strip() else block
    )


def make_recall_filter(config: TDAiConfig, client: MemoryGatewayClient, session_key: str):
    """Build the PROMPT_RENDERING filter callable for a facade."""

    async def tdai_recall_filter(context: "PromptRenderContext", next) -> None:
        await render_recall(context, config, client, session_key)
        await next(context)

    return tdai_recall_filter
