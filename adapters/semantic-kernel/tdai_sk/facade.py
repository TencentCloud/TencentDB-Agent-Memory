"""Facade wiring TencentDB Agent Memory into Semantic Kernel agents."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from semantic_kernel.agents import ChatHistoryAgentThread
    from semantic_kernel.filters import KernelPlugin
    from semantic_kernel.kernel import Kernel

from .config import TDAiConfig
from .filters import make_recall_filter
from .gateway_client import (
    CaptureRequest,
    GatewayMessage,
    MemoryGatewayClient,
    default_session_key,
    now_ts,
)
from .plugin import MemoryToolSurface

logger = logging.getLogger(__name__)


class TencentDBAgentMemory:
    """TencentDB Agent Memory facade for Semantic Kernel agents.

    Surfaces:
        - ``as_plugin()``: ``KernelPlugin`` with ``memory_search`` /
          ``conversation_search`` kernel functions.
        - ``attach(kernel)``: registers the automatic-recall
          ``PROMPT_RENDERING`` filter (append/template modes).
        - ``capture_thread(thread)``: incremental transcript capture.
        - ``end_session(thread)``: flush gateway-side session state.
    """

    def __init__(
        self,
        config: TDAiConfig | None = None,
        client: MemoryGatewayClient | None = None,
        validate_config: bool = True,
    ) -> None:
        self._config = config or TDAiConfig()
        if validate_config:
            self._config.validate()
        self._client = client or MemoryGatewayClient(
            gateway_url=self._config.gateway_url,
            api_key=self._config.api_key,
            timeout=self._config.timeout,
        )
        self._owns_client = client is None
        # Watermark of the last captured message count per thread id, so
        # repeated capture_thread() calls only send the delta.
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

        surface = MemoryToolSurface(self._config, self._client)

        exposed: list[str] = []
        if self._config.memory_search_tool:
            exposed.extend(
                [
                    "memory_search",
                ]
            )
        if self._config.conversation_search_tool:
            exposed.append("conversation_search")

        holder = _SurfaceHolder(surface, exposed)
        return KernelPlugin.from_object(name, holder)

    def attach(self, kernel: "Kernel") -> None:
        """Register the automatic-recall filter on a Kernel (idempotent).

        No-op when ``recall_mode="off"``.
        """
        from semantic_kernel.filters import FilterTypes

        if self._config.recall_mode == "off":
            return
        if kernel in self._attached_kernels:
            return
        kernel.add_filter(
            FilterTypes.PROMPT_RENDERING,
            make_recall_filter(
                self._config,
                self._client,
                # The filter stack has no thread handle; the default session
                # scope is used and per-thread sessions get their own keys on
                # the capture path.
                self.session_key(None),
            ),
        )
        self._attached_kernels.append(kernel)

    # ------------------------------------------------------------------
    # Session/thread lifecycle
    # ------------------------------------------------------------------

    def session_key(self, thread: "ChatHistoryAgentThread | None") -> str:
        """Gateway session_key for a thread (urlsafe-b64 app:user:session)."""
        session_id = str(thread.id) if thread is not None and thread.id else "default"
        return default_session_key(self._config.app_name, self._config.user_id, session_id)

    async def capture_thread(self, thread: "ChatHistoryAgentThread") -> dict[str, Any] | None:
        """Send the uncaptured delta of a thread's history to ``/capture``.

        Only full user/assistant pairs are captured; a trailing lone user
        message waits for its assistant reply. The per-thread watermark is
        advanced only after a successful gateway response, so a failed
        capture is retried on the next call.

        Note the narrow duplicate window: if the gateway persists the turn
        but the response is lost, the retry resends the same delta (the
        server assigns message IDs, so this creates a duplicate).
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

        if gateway_messages and not (user_text and assistant_text):
            # Incomplete turn; wait for the assistant reply before capturing.
            return None
        if not gateway_messages:
            self._captured_counts[thread_key] = len(messages)
            return None

        request = CaptureRequest(
            user_content=user_text,
            assistant_content=assistant_text,
            session_key=self.session_key(thread),
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
        """Flush gateway-side session state (``POST /session/end``)."""
        try:
            return await self._client.end_session(
                session_key=self.session_key(thread),
                user_id=self._config.user_id,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("tdai end_session failed: %s", exc)
            if self._config.fail_open:
                return False
            raise

    async def health(self):
        """Probe the gateway readiness endpoint."""
        return await self._client.health()

    async def close(self) -> None:
        """Release the underlying HTTP client when owned by this facade."""
        if self._owns_client:
            await self._client.close()


class _SurfaceHolder:
    """Exposes only the config-enabled tool methods to KernelPlugin."""

    def __init__(self, surface: MemoryToolSurface, exposed: list[str]) -> None:
        for method_name in exposed:
            setattr(self, method_name, getattr(surface, method_name))
