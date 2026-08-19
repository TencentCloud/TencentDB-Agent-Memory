"""TencentDB Agent Memory integration for Semantic Kernel (Python).

Provides:

- :class:`TencentDBAgentMemory` — the main entry point. Wraps the memory-core
  gateway and exposes Semantic Kernel native surfaces:
    - ``as_plugin()`` → ``KernelPlugin`` with ``memory_search`` /
      ``conversation_search`` kernel functions (active retrieval).
    - ``attach(kernel)`` → registers a ``PROMPT_RENDERING`` filter that
      injects recalled memory context before each agent turn (automatic
      recall; injection modes "append" (default) and "template").
    - ``capture_thread(thread)`` → streams the incremental user/assistant
      transcript of a ``ChatHistoryAgentThread`` to ``POST /capture``.
    - ``end_session(thread)`` → flushes gateway-side short-term state.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Annotated, Any, Literal

if TYPE_CHECKING:
    from semantic_kernel.agents import ChatHistoryAgentThread
    from semantic_kernel.filters import PromptRenderContext
    from semantic_kernel.functions import KernelPlugin
    from semantic_kernel.kernel import Kernel

from semantic_kernel.functions import kernel_function

from .gateway_client import (
    CaptureRequest,
    GatewayMessage,
    MemoryGatewayClient,
    default_session_key,
    now_ts,
)

logger = logging.getLogger(__name__)

MEMORY_PLACEHOLDER = "TDaiMemory"
"""Template variable name used in ``mode="template"`` recall injection."""


@dataclass
class TDAiConfig:
    """Configuration for :class:`TencentDBAgentMemory`."""

    app_name: str = "semantic-kernel-app"
    user_id: str = "default-user"
    gateway_url: str = "http://127.0.0.1:8420"
    api_key: str = ""
    timeout: float = 5.0
    recall_mode: Literal["append", "template", "off"] = "append"
    """How recalled context is injected:
    - ``append`` (default): appended to the rendered system instructions,
      zero user configuration.
    - ``template``: written to the ``{{TDaiMemory}}`` template variable;
      users place it explicitly inside their instructions.
    - ``off``: automatic recall disabled.
    """
    memory_search_tool: bool = True
    conversation_search_tool: bool = True
    fail_open: bool = True
    """Memory errors are logged and swallowed when True (recommended: memory
    is an enhancement, not a hard dependency of the chat path)."""


class TencentDBAgentMemory:
    """TencentDB Agent Memory facade for Semantic Kernel agents."""

    def __init__(
        self,
        config: TDAiConfig | None = None,
        client: MemoryGatewayClient | None = None,
    ) -> None:
        self._config = config or TDAiConfig()
        self._client = client or MemoryGatewayClient(
            gateway_url=self._config.gateway_url,
            api_key=self._config.api_key,
            timeout=self._config.timeout,
        )
        self._owns_client = client is None
        # Watermark of the last captured message per thread id, so repeated
        # capture_thread() calls only send the delta.
        self._captured_counts: dict[str, int] = {}
        self._attached_kernels: list["Kernel"] = []

    @property
    def config(self) -> TDAiConfig:
        return self._config

    @property
    def client(self) -> MemoryGatewayClient:
        return self._client

    # ------------------------------------------------------------------
    # Kernel integration surfaces
    # ------------------------------------------------------------------

    def as_plugin(self, name: str = "TencentDBMemory") -> "KernelPlugin":
        """Return a KernelPlugin exposing the enabled retrieval tools."""
        from semantic_kernel.functions import KernelPlugin

        return KernelPlugin.from_object(name, self._ToolSurface(self))

    class _ToolSurface:
        """Holds the @kernel_function methods (bound to one facade)."""

        def __init__(self, facade: "TencentDBAgentMemory") -> None:
            self._facade = facade

        @kernel_function(
            name="memory_search",
            description=(
                "Search the user's long-term memory (extracted facts, scenarios, "
                "profile). Use when the current question depends on remembered "
                "preferences or history."
            ),
        )
        async def memory_search(
            self,
            query: Annotated[str, "Search query for remembered information."],
            limit: Annotated[int, "Maximum number of results."] = 5,
        ) -> str:
            facade = self._facade
            try:
                result = await facade._client.search_memories(
                    query=query, limit=limit, user_id=facade._config.user_id
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("memory_search failed: %s", exc)
                if facade._config.fail_open:
                    return "memory search unavailable"
                raise
            return result.results or "no matching memories"

        @kernel_function(
            name="conversation_search",
            description=(
                "Search the current user's conversation history (session scoped). "
                "Use for recalling what was said earlier."
            ),
        )
        async def conversation_search(
            self,
            query: Annotated[str, "Search query over past conversation turns."],
            limit: Annotated[int, "Maximum number of results."] = 5,
        ) -> str:
            facade = self._facade
            try:
                result = await facade._client.search_conversations(
                    query=query, limit=limit, user_id=facade._config.user_id
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("conversation_search failed: %s", exc)
                if facade._config.fail_open:
                    return "conversation search unavailable"
                raise
            return result.results or "no matching conversation turns"

    def attach(self, kernel: "Kernel") -> None:
        """Register the automatic-recall filter on a Kernel.

        With ``recall_mode='append'`` (default) the recalled context is
        appended to the rendered instructions on every agent turn. With
        ``'template'`` it is only written to the ``{{TDaiMemory}}`` variable.
        Idempotent per kernel instance.
        """
        from semantic_kernel.filters import FilterTypes

        if kernel in self._attached_kernels:
            return
        if self._config.recall_mode == "off":
            return

        facade = self

        async def tdai_recall_filter(
            context: "PromptRenderContext", next
        ) -> None:
            await facade._render_recall(context)
            await next(context)

        kernel.add_filter(FilterTypes.PROMPT_RENDERING, tdai_recall_filter)
        self._attached_kernels.append(kernel)

    # ------------------------------------------------------------------
    # Session/thread lifecycle
    # ------------------------------------------------------------------

    async def _render_recall(self, context: "PromptRenderContext") -> None:
        """PROMPT_RENDERING hook: fetch recalled context and inject it."""
        assert self._config.recall_mode != "off"
        query = self._latest_user_query(context)
        if not query:
            return
        session_key = self.session_key_for_thread(None)
        try:
            recall = await self._client.recall(
                query=query, session_key=session_key, user_id=self._config.user_id
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("tdai recall failed: %s", exc)
            if self._config.fail_open:
                return
            raise
        block = recall.context or recall.prepend_context
        if not block:
            return
        block = f"\n\n[Long-term memory]\n{block}"
        if self._config.recall_mode == "template":
            context.arguments[MEMORY_PLACEHOLDER] = block
        else:  # append
            current = context.arguments.get("instructions") or ""
            context.arguments["instructions"] = (
                f"{current}{block}" if current else block.lstrip()
            )

    def _latest_user_query(self, context: "PromptRenderContext") -> str:
        """Best-effort extraction of the latest user text from render context."""
        # The rendering context does not carry chat history directly; the
        # common path is KernelArguments['input'] or the last user message
        # passed via arguments. Fall back to empty (skip recall).
        for key in ("input", "user_input", "query"):
            value = context.arguments.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return ""

    def session_key_for_thread(self, thread: "ChatHistoryAgentThread | None") -> str:
        if thread is not None and getattr(thread, "id", None):
            return default_session_key(
                self._config.app_name, self._config.user_id, str(thread.id)
            )
        return default_session_key(
            self._config.app_name, self._config.user_id, "default"
        )

    async def capture_thread(self, thread: "ChatHistoryAgentThread") -> dict[str, Any] | None:
        """Send the uncaptured delta of a thread's chat history to /capture.

        Returns the gateway response dict, or ``None`` when there was nothing
        new to capture. Failures respect ``fail_open``.
        """
        messages = [message async for message in thread.get_messages()]
        thread_key = str(thread.id)
        start = self._captured_counts.get(thread_key, 0)
        delta = messages[start:]
        if not delta:
            return None
        user_text = ""
        assistant_text = ""
        gateway_messages: list[GatewayMessage] = []
        for message in delta:
            content = (message.content or "").strip()
            if not content:
                continue
            role = message.role.value if message.role else "user"
            gateway_messages.append(
                GatewayMessage(role=role, content=content, timestamp=now_ts())
            )
            if role == "user" and not user_text:
                user_text = content
            elif role == "assistant" and not assistant_text:
                assistant_text = content
        if not gateway_messages:
            self._captured_counts[thread_key] = len(messages)
            return None
        # Only capture once a full user/assistant pair exists.
        if not (user_text and assistant_text):
            return None
        request = CaptureRequest(
            user_content=user_text,
            assistant_content=assistant_text,
            session_key=self.session_key_for_thread(thread),
            session_id=thread_key,
            user_id=self._config.user_id,
            messages=gateway_messages,
        )
        try:
            response = await self._client.capture(request)
        except Exception as exc:  # noqa: BLE001
            logger.warning("tdai capture failed: %s", exc)
            if self._config.fail_open:
                return None
            raise
        self._captured_counts[thread_key] = len(messages)
        return response

    async def end_session(self, thread: "ChatHistoryAgentThread") -> bool:
        """Flush gateway-side session state (POST /session/end)."""
        try:
            return await self._client.end_session(
                session_key=self.session_key_for_thread(thread),
                user_id=self._config.user_id,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("tdai end_session failed: %s", exc)
            if self._config.fail_open:
                return False
            raise

    async def health(self):
        return await self._client.health()

    async def close(self) -> None:
        if self._owns_client:
            await self._client.close()
