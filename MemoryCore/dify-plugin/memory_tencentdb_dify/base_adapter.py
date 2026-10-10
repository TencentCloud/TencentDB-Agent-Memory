"""MemoryAdapterBase -- Abstract base class for all platform adapters.

This is the Python counterpart to the TypeScript ``MemoryAdapterBase`` in
``src/adapters/sdk/base-adapter.ts``.

New platforms extend this class and implement only 4 abstract methods:

1. ``format_recall_result(result)`` -- Format memory recall output for the
   platform's prompt injection convention.
2. ``get_tool_definitions()`` -- Return tool schemas the platform registers
   with its LLM.
3. ``format_tool_result(tool_name, raw_result)`` -- Format tool call output
   for the platform's expected response format.
4. ``normalize_messages(raw_messages, context)`` -- Convert platform-specific
   message format into the standard ``ConversationMessage`` list.

The base class handles:
- Gateway connection and health checking
- Circuit breaker (pauses calls after N consecutive failures)
- Recall (parallel L1 + L3 + L2 fetch via MemoryGatewayClient)
- Capture (conversation add via MemoryGatewayClient)
- Search (memory + conversation search via MemoryGatewayClient)
- Session management

Usage::

    class DifyAdapter(MemoryAdapterBase):
        platform_name = "dify"
        # implement 4 abstract methods...

    adapter = DifyAdapter()
    adapter.initialize({"gateway": {"endpoint": "http://127.0.0.1:8420"}})
    prepend, append = adapter.recall("user query", "session-1")
    adapter.capture(messages, "session-1")
"""

from __future__ import annotations

import abc
import logging
import time
from typing import Any, Dict, List, Optional, Tuple, Union

from .gateway_client import MemoryGatewayClient
from .types import (
    AdapterConfig,
    CaptureResult,
    ConversationMessage,
    FormattedRecallResult,
    RecallResult,
    SearchResult,
    TenancyConfig,
    ToolDefinition,
)

logger = logging.getLogger(__name__)

__all__ = [
    "MemoryAdapterBase",
    "DEFAULT_MEMORY_SEARCH_TOOL",
    "DEFAULT_CONVERSATION_SEARCH_TOOL",
    "DEFAULT_READ_SCENE_TOOL",
    "BREAKER_THRESHOLD",
    "BREAKER_COOLDOWN_MS",
]

# ============================
# Circuit breaker constants
# ============================

BREAKER_THRESHOLD = 5
BREAKER_COOLDOWN_MS = 60_000


# ============================
# Default tool definitions
# ============================

DEFAULT_MEMORY_SEARCH_TOOL = ToolDefinition(
    name="tdai_memory_search",
    label="Memory Search",
    description=(
        "Search structured memories (L1). Returns relevant memory fragments "
        "about user preferences, past events, rules, and facts."
    ),
    parameters={
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Search query text (natural language).",
            },
            "limit": {
                "type": "number",
                "description": "Max results to return (default: 5).",
            },
            "type": {
                "type": "string",
                "description": "Filter by memory type.",
            },
        },
        "required": ["query"],
    },
)

DEFAULT_CONVERSATION_SEARCH_TOOL = ToolDefinition(
    name="tdai_conversation_search",
    label="Conversation Search",
    description=(
        "Search raw conversation history (L0). Returns original messages "
        "with timestamps."
    ),
    parameters={
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Search query text.",
            },
            "limit": {
                "type": "number",
                "description": "Max results (default: 5).",
            },
            "session_key": {
                "type": "string",
                "description": "Filter by session ID.",
            },
        },
        "required": ["query"],
    },
)

DEFAULT_READ_SCENE_TOOL = ToolDefinition(
    name="tdai_read_scene",
    label="Read Scene",
    description=(
        "Read a scene block's full content by its name. "
        "Use when you see a scene listed in Scene Navigation."
    ),
    parameters={
        "type": "object",
        "properties": {
            "scene_id": {
                "type": "string",
                "description": "Scene file name (e.g. 'travel-plan.md').",
            },
        },
        "required": ["scene_id"],
    },
)


class MemoryAdapterBase(abc.ABC):
    """Abstract base class for all platform adapters.

    Subclasses implement 4 abstract methods and optionally override the
    lifecycle hooks (``on_gateway_ready``, ``on_gateway_unavailable``,
    ``on_recall_error``, ``on_capture_error``). All Gateway communication,
    health checking, circuit breaking, and error handling are handled here.
    """

    #: Platform identifier (e.g. ``"dify"``, ``"hermes"``). Set by subclass.
    platform_name: str = ""

    def __init__(self) -> None:
        self._client: Optional[MemoryGatewayClient] = None
        self._config: Optional[AdapterConfig] = None
        self._tenancy: Dict[str, str] = {
            "team_id": "default",
            "agent_id": "default",
            "user_id": "default",
        }
        self._session_id: str = ""

        # Circuit breaker state
        self._consecutive_failures: int = 0
        self._breaker_open_until: float = 0.0

    # -- Properties ----------------------------------------------------------

    @property
    def is_initialized(self) -> bool:
        """Whether :meth:`initialize` has been called successfully."""
        return self._client is not None

    @property
    def session_id(self) -> str:
        """The current session ID for capture operations."""
        return self._session_id

    # ============================
    # Lifecycle
    # ============================

    def initialize(self, config: AdapterConfig) -> None:
        """Initialize the adapter with configuration.

        Creates the Gateway client and performs a best-effort health check.
        Does not raise on health check failure -- the Gateway might come up
        later.

        Args:
            config: Full adapter configuration. See :class:`AdapterConfig`.
        """
        self._config = config
        gateway = config.get("gateway", {})
        tenancy = config.get("tenancy") or {}

        self._tenancy = {
            "team_id": tenancy.get("team_id", "default") or "default",
            "agent_id": tenancy.get("agent_id", "default") or "default",
            "user_id": tenancy.get("user_id", "default") or "default",
        }

        self._client = MemoryGatewayClient(
            endpoint=gateway.get("endpoint", "http://127.0.0.1:8420"),
            api_key=gateway.get("api_key"),
            service_id=gateway.get("service_id", "default"),
            timeout_ms=gateway.get("timeout_ms", 10_000),
            reject_unauthorized=gateway.get("reject_unauthorized", True),
        )

        # Best-effort health check (non-blocking on failure)
        health = self._client.health(timeout_ms=3_000)
        status = health.get("status", "unknown")
        if status in ("ok", "degraded"):
            self.on_gateway_ready()
        else:
            self.on_gateway_unavailable(status)

    def set_session_id(self, session_id: str) -> None:
        """Set the current session ID for capture operations.

        Args:
            session_id: The session identifier.
        """
        self._session_id = session_id

    def shutdown(self) -> None:
        """Shutdown the adapter.

        The base class has no persistent resources to close. Subclasses can
        override for platform-specific cleanup.
        """
        pass

    # ============================
    # Core capabilities (implemented by base class)
    # ============================

    def recall(
        self,
        query: str,
        session_id: Optional[str] = None,
    ) -> Tuple[str, str]:
        """Recall memories for the current user query.

        Performs parallel L1 (structured memories) + L3 (persona) + L2 (scene
        navigation) fetch from the Gateway, then delegates formatting to the
        platform-specific :meth:`format_recall_result` method.

        Returns empty strings on failure -- never raises.

        Args:
            query: The user's query text.
            session_id: Optional session override. Falls back to the
                session set via :meth:`set_session_id`.

        Returns:
            A tuple of ``(prepend_context, append_system_context)`` strings.
        """
        if not query or self._client is None or self._is_breaker_open():
            return "", ""

        effective_session = session_id or self._session_id
        start_ms = self._now_ms()

        try:
            memories, persona, scenes = self._client.recall(
                query,
                self._tenancy,
                options={
                    "max_results": (self._config or {}).get("recall_max_results", 5),
                    "include_persona": (self._config or {}).get("recall_include_persona", True),
                    "include_scene_nav": (self._config or {}).get("recall_include_scene_nav", True),
                },
            )

            latency_ms = self._now_ms() - start_ms
            result = RecallResult(
                prepend_context="",
                append_system_context="",
                memories=memories,
                persona=persona,
                scenes=scenes,
                latency_ms=latency_ms,
            )

            self._record_success()

            formatted = self.format_recall_result(result)
            return (
                formatted.get("prepend_context", "") or "",
                formatted.get("append_system_context", "") or "",
            )
        except Exception as err:
            self._record_failure()
            self.on_recall_error(err)
            return "", ""

    def capture(
        self,
        raw_messages: Any,
        session_id: Optional[str] = None,
        context: Optional[Dict[str, Any]] = None,
    ) -> CaptureResult:
        """Capture conversation messages.

        Normalizes platform-specific messages via :meth:`normalize_messages`,
        then sends them to the Gateway for L0 recording.

        Returns a failure result on error -- never raises.

        Args:
            raw_messages: Platform-specific message format.
            session_id: Optional session override.
            context: Optional context dict passed to :meth:`normalize_messages`.

        Returns:
            A :class:`CaptureResult` with capture status.
        """
        if self._client is None or self._is_breaker_open():
            return CaptureResult(captured_count=0, success=False, error="circuit breaker open")

        if not (self._config or {}).get("capture_enabled", True):
            return CaptureResult(captured_count=0, success=True)

        try:
            messages = self.normalize_messages(raw_messages, context)
            if not messages:
                return CaptureResult(captured_count=0, success=True)

            effective_session = session_id or self._session_id
            captured_count, success = self._client.capture(
                messages,
                effective_session,
                self._tenancy,
            )

            if success:
                self._record_success()
            else:
                self._record_failure()

            return CaptureResult(captured_count=captured_count, success=success)
        except Exception as err:
            self._record_failure()
            error_msg = str(err)
            self.on_capture_error(error_msg)
            return CaptureResult(captured_count=0, success=False, error=error_msg)

    def search_memories(
        self,
        query: str,
        limit: Optional[int] = None,
        type_filter: Optional[str] = None,
    ) -> SearchResult:
        """Search L1 structured memories.

        Args:
            query: Search query text.
            limit: Max results to return (default: 5).
            type_filter: Filter by memory type.

        Returns:
            A :class:`SearchResult`. Returns empty result on failure.
        """
        if not query or self._client is None or self._is_breaker_open():
            return SearchResult(text="No results.", total=0)

        try:
            options: Dict[str, Any] = {}
            if limit is not None:
                options["limit"] = limit
            if type_filter is not None:
                options["type"] = type_filter

            items, total = self._client.search_memories(
                query,
                self._tenancy,
                options=options if options else None,
            )
            self._record_success()

            if not items:
                text = "No memories found for this query."
            else:
                text = "\n".join(f"- [{m.type}] {m.content}" for m in items)

            return SearchResult(text=text, total=total, items=items)
        except Exception as err:
            self._record_failure()
            return SearchResult(text=f"Search failed: {err}", total=0)

    def search_conversations(
        self,
        query: str,
        limit: Optional[int] = None,
        session_id: Optional[str] = None,
    ) -> SearchResult:
        """Search L0 raw conversations.

        Args:
            query: Search query text.
            limit: Max results to return (default: 5).
            session_id: Filter by session ID.

        Returns:
            A :class:`SearchResult`. Returns empty result on failure.
        """
        if not query or self._client is None or self._is_breaker_open():
            return SearchResult(text="No results.", total=0)

        try:
            options: Dict[str, Any] = {}
            if limit is not None:
                options["limit"] = limit
            if session_id is not None:
                options["session_id"] = session_id

            items, total = self._client.search_conversations(
                query,
                self._tenancy,
                options=options if options else None,
            )
            self._record_success()

            if not items:
                text = "No conversations found for this query."
            else:
                text = "\n".join(f"[{m.type}] {m.content}" for m in items)

            return SearchResult(text=text, total=total, items=items)
        except Exception as err:
            self._record_failure()
            return SearchResult(text=f"Search failed: {err}", total=0)

    def read_scene(self, scene_id: str) -> str:
        """Read a scene block by path.

        Args:
            scene_id: Scene file name (with or without ``.md`` extension).

        Returns:
            The scene content text, or an error message on failure.
        """
        if not scene_id or self._client is None or self._is_breaker_open():
            return "Scene not available."

        try:
            path = scene_id if scene_id.endswith(".md") else f"{scene_id}.md"
            content = self._client.read_scene(path, self._tenancy)
            self._record_success()
            return content or f"Scene '{scene_id}' is empty or not found."
        except Exception as err:
            self._record_failure()
            return f"Failed to read scene: {err}"

    def handle_tool_call(
        self,
        tool_name: str,
        args: Dict[str, Any],
    ) -> str:
        """Handle a tool call by name. Dispatches to the appropriate method.

        Supports both the generic (``tdai_*``) and provider-prefixed
        (``memory_tencentdb_*``) tool name conventions.

        Args:
            tool_name: The tool name to dispatch.
            args: Tool call arguments.

        Returns:
            The formatted tool result as a string.
        """
        try:
            raw_result: Union[SearchResult, str]

            if tool_name in ("tdai_memory_search", "memory_tencentdb_memory_search"):
                raw_result = self.search_memories(
                    str(args.get("query", "")),
                    limit=args.get("limit") if isinstance(args.get("limit"), (int, float)) else None,
                    type_filter=args.get("type") if isinstance(args.get("type"), str) else None,
                )
            elif tool_name in ("tdai_conversation_search", "memory_tencentdb_conversation_search"):
                raw_result = self.search_conversations(
                    str(args.get("query", "")),
                    limit=args.get("limit") if isinstance(args.get("limit"), (int, float)) else None,
                    session_id=args.get("session_key") if isinstance(args.get("session_key"), str) else None,
                )
            elif tool_name in ("tdai_read_scene", "memory_tencentdb_read_scene"):
                raw_result = self.read_scene(str(args.get("scene_id", "")))
            else:
                import json
                return json.dumps({"error": f"Unknown tool: {tool_name}"})

            return self.format_tool_result(tool_name, raw_result)
        except Exception as err:
            import json
            return json.dumps({"error": f"Tool call failed: {err}"})

    def get_tool_definitions(self) -> List[ToolDefinition]:
        """Get the default tool definitions.

        Returns the three default tools (memory search, conversation search,
        scene read). Platforms can override to customize.

        Returns:
            A list of :class:`ToolDefinition` instances.
        """
        return [
            DEFAULT_MEMORY_SEARCH_TOOL,
            DEFAULT_CONVERSATION_SEARCH_TOOL,
            DEFAULT_READ_SCENE_TOOL,
        ]

    # ============================
    # Circuit breaker
    # ============================

    def _is_breaker_open(self) -> bool:
        """Check whether the circuit breaker is currently open."""
        if self._consecutive_failures < BREAKER_THRESHOLD:
            return False
        if self._now_ms() >= self._breaker_open_until:
            self._consecutive_failures = 0
            return False
        return True

    def _record_success(self) -> None:
        """Reset the circuit breaker failure counter."""
        self._consecutive_failures = 0

    def _record_failure(self) -> None:
        """Increment the failure counter and trip the breaker if threshold reached."""
        self._consecutive_failures += 1
        if self._consecutive_failures >= BREAKER_THRESHOLD:
            self._breaker_open_until = self._now_ms() + BREAKER_COOLDOWN_MS
            logger.warning(
                "%s circuit breaker tripped after %d consecutive failures. "
                "Pausing Gateway calls for %dms.",
                self.platform_name or "adapter",
                self._consecutive_failures,
                BREAKER_COOLDOWN_MS,
            )

    @staticmethod
    def _now_ms() -> float:
        """Current monotonic time in milliseconds."""
        return time.monotonic() * 1000.0

    # ============================
    # Overridable hooks (platform-specific)
    # ============================

    def on_gateway_ready(self) -> None:
        """Called when the Gateway becomes reachable after :meth:`initialize`.

        Override in subclass for platform-specific logging.
        """
        pass

    def on_gateway_unavailable(self, status: str) -> None:
        """Called when the Gateway is not reachable at :meth:`initialize`.

        Override in subclass for platform-specific fallback.

        Args:
            status: The health check status string.
        """
        pass

    def on_recall_error(self, err: Exception) -> None:
        """Called when a recall operation fails.

        Override in subclass for platform-specific error handling.

        Args:
            err: The exception that caused the failure.
        """
        pass

    def on_capture_error(self, error_msg: str) -> None:
        """Called when a capture operation fails.

        Override in subclass for platform-specific error handling.

        Args:
            error_msg: The error message string.
        """
        pass

    # ============================
    # Abstract methods (must be implemented by each platform)
    # ============================

    @abc.abstractmethod
    def format_recall_result(self, result: RecallResult) -> FormattedRecallResult:
        """Format a recall result for this platform's prompt injection.

        Different platforms have different conventions for how memory context
        is injected into prompts. This method lets each platform control the
        exact format.

        Args:
            result: The raw :class:`RecallResult` from the Gateway.

        Returns:
            A dict with optional ``prepend_context`` and
            ``append_system_context`` keys.
        """
        ...

    @abc.abstractmethod
    def format_tool_result(
        self,
        tool_name: str,
        raw_result: Union[SearchResult, str],
    ) -> str:
        """Format tool call output for the platform's expected response format.

        Args:
            tool_name: The name of the tool that was called.
            raw_result: The raw :class:`SearchResult` or string result.

        Returns:
            The formatted result as a string.
        """
        ...

    @abc.abstractmethod
    def normalize_messages(
        self,
        raw_messages: Any,
        context: Optional[Dict[str, Any]] = None,
    ) -> List[ConversationMessage]:
        """Convert platform-specific message format into standard messages.

        Different platforms represent conversations differently. This method
        normalizes them into the standard :class:`ConversationMessage` list.

        Args:
            raw_messages: Platform-specific message format.
            context: Optional context dict.

        Returns:
            A list of :class:`ConversationMessage` instances.
        """
        ...
