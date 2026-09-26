"""Dify plugin provider for the TDAI memory system.

This module implements the Dify plugin interface on top of the
:class:`MemoryAdapterBase` SDK. It exposes three tools
(``memory_search``, ``conversation_search``, ``read_scene``) that Dify agents
and workflows can invoke.

The :class:`MemoryTencentdbDifyProvider` extends :class:`MemoryAdapterBase`
and implements the 4 abstract methods:

- :meth:`format_recall_result` -- produces XML-tagged blocks suitable for
  Dify's prompt injection format (``<relevant-memories>``,
  ``<user-core>``, ``<scene-navigation>``).
- :meth:`get_tool_definitions` -- returns Dify-flavoured tool schemas.
- :meth:`format_tool_result` -- formats search/scene results as plain text.
- :meth:`normalize_messages` -- converts Dify's message format (which may be
  a list of ``{query, answer}`` pairs, a list of ``{role, content}`` dicts,
  or a plain string) into the standard :class:`ConversationMessage` list.

Configuration is read from environment variables:

================================== ==============================================
``TDAI_GATEWAY_ENDPOINT``          Gateway base URL (default: http://127.0.0.1:8420)
``TDAI_GATEWAY_API_KEY``           Optional Bearer token
``TDAI_GATEWAY_SERVICE_ID``        Service ID (default: default)
``TDAI_GATEWAY_TIMEOUT_MS``        Request timeout in ms (default: 10000)
``TDAI_TEAM_ID``                   Tenancy team ID (default: default)
``TDAI_AGENT_ID``                  Tenancy agent ID (default: default)
``TDAI_USER_ID``                   Tenancy user ID (default: default)
``TDAI_RECALL_MAX_RESULTS``        Max L1 memories per recall (default: 5)
``TDAI_RECALL_INCLUDE_PERSONA``    Include L3 persona (default: true)
``TDAI_RECALL_INCLUDE_SCENE_NAV``  Include L2 scene nav (default: true)
``TDAI_CAPTURE_ENABLED``           Enable L0 capture (default: true)
================================== ==============================================

When running inside a Dify plugin, credentials supplied by the Dify runtime
(via ``self.runtime.credentials``) override the environment variables. The
credential keys recognised are: ``gateway_endpoint``, ``gateway_api_key``,
``gateway_service_id``, ``gateway_timeout_ms``, ``team_id``, ``agent_id``,
``user_id``.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Union

from .base_adapter import MemoryAdapterBase
from .types import (
    AdapterConfig,
    ConversationMessage,
    FormattedRecallResult,
    RecallResult,
    SearchResult,
    TenancyConfig,
    ToolDefinition,
)

logger = logging.getLogger(__name__)

__all__ = [
    "MemoryTencentdbDifyProvider",
    "MemorySearchTool",
    "ConversationSearchTool",
    "ReadSceneTool",
    "MemoryTencentdbToolProvider",
    "build_adapter_config_from_env",
    "build_adapter_config_from_credentials",
    "MEMORY_SEARCH_TOOL_YAML",
    "CONVERSATION_SEARCH_TOOL_YAML",
    "READ_SCENE_TOOL_YAML",
]

# ============================
# Environment variable defaults
# ============================

_DEFAULT_ENDPOINT = "http://127.0.0.1:8420"
_DEFAULT_SERVICE_ID = "default"
_DEFAULT_TIMEOUT_MS = 10_000
_DEFAULT_TEAM_ID = "default"
_DEFAULT_AGENT_ID = "default"
_DEFAULT_USER_ID = "default"
_DEFAULT_RECALL_MAX_RESULTS = 5


def _env_bool(key: str, default: bool) -> bool:
    """Parse a boolean environment variable."""
    raw = os.environ.get(key)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _env_int(key: str, default: int) -> int:
    """Parse an integer environment variable."""
    raw = os.environ.get(key)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw.strip())
    except ValueError:
        logger.warning("Invalid integer for %s=%r; using default %d", key, raw, default)
        return default


def build_adapter_config_from_env() -> AdapterConfig:
    """Build an :class:`AdapterConfig` from environment variables.

    This is the primary configuration path when the provider runs outside
    Dify (e.g. in tests or as a library).
    """
    return AdapterConfig(
        gateway={
            "endpoint": os.environ.get("TDAI_GATEWAY_ENDPOINT", _DEFAULT_ENDPOINT).strip() or _DEFAULT_ENDPOINT,
            "api_key": (os.environ.get("TDAI_GATEWAY_API_KEY") or "").strip() or None,
            "service_id": os.environ.get("TDAI_GATEWAY_SERVICE_ID", _DEFAULT_SERVICE_ID).strip() or _DEFAULT_SERVICE_ID,
            "timeout_ms": _env_int("TDAI_GATEWAY_TIMEOUT_MS", _DEFAULT_TIMEOUT_MS),
        },
        tenancy=TenancyConfig(
            team_id=os.environ.get("TDAI_TEAM_ID", _DEFAULT_TEAM_ID).strip() or _DEFAULT_TEAM_ID,
            agent_id=os.environ.get("TDAI_AGENT_ID", _DEFAULT_AGENT_ID).strip() or _DEFAULT_AGENT_ID,
            user_id=os.environ.get("TDAI_USER_ID", _DEFAULT_USER_ID).strip() or _DEFAULT_USER_ID,
        ),
        recall_max_results=_env_int("TDAI_RECALL_MAX_RESULTS", _DEFAULT_RECALL_MAX_RESULTS),
        recall_include_persona=_env_bool("TDAI_RECALL_INCLUDE_PERSONA", True),
        recall_include_scene_nav=_env_bool("TDAI_RECALL_INCLUDE_SCENE_NAV", True),
        capture_enabled=_env_bool("TDAI_CAPTURE_ENABLED", True),
    )


def build_adapter_config_from_credentials(credentials: Dict[str, Any]) -> AdapterConfig:
    """Build an :class:`AdapterConfig` from Dify plugin credentials.

    Credential keys override environment variables. Unset keys fall back to
    the environment, then to built-in defaults.
    """
    env_config = build_adapter_config_from_env()
    gateway = dict(env_config.get("gateway", {}))  # type: ignore[arg-type]
    tenancy = dict(env_config.get("tenancy", {}))  # type: ignore[arg-type]

    if credentials.get("gateway_endpoint"):
        gateway["endpoint"] = str(credentials["gateway_endpoint"]).strip()
    if credentials.get("gateway_api_key"):
        gateway["api_key"] = str(credentials["gateway_api_key"]).strip()
    if credentials.get("gateway_service_id"):
        gateway["service_id"] = str(credentials["gateway_service_id"]).strip()
    if credentials.get("gateway_timeout_ms"):
        try:
            gateway["timeout_ms"] = int(credentials["gateway_timeout_ms"])
        except (ValueError, TypeError):
            pass
    if credentials.get("team_id"):
        tenancy["team_id"] = str(credentials["team_id"]).strip()
    if credentials.get("agent_id"):
        tenancy["agent_id"] = str(credentials["agent_id"]).strip()
    if credentials.get("user_id"):
        tenancy["user_id"] = str(credentials["user_id"]).strip()

    return AdapterConfig(
        gateway=gateway,
        tenancy=tenancy,
        recall_max_results=env_config.get("recall_max_results", _DEFAULT_RECALL_MAX_RESULTS),
        recall_include_persona=env_config.get("recall_include_persona", True),
        recall_include_scene_nav=env_config.get("recall_include_scene_nav", True),
        capture_enabled=env_config.get("capture_enabled", True),
    )


# ============================
# Dify tool YAML schemas (for provider/*.yaml files)
# ============================

MEMORY_SEARCH_TOOL_YAML: Dict[str, Any] = {
    "identity": {
        "name": "memory_search",
        "author": "TDAI",
        "label": {"en_US": "Memory Search", "zh_Hans": "记忆搜索"},
        "description": {
            "human": {
                "en_US": "Search structured long-term memories (L1). Returns relevant memory fragments about user preferences, past events, rules, and facts.",
                "zh_Hans": "搜索结构化长期记忆（L1）。返回与用户偏好、过往事件、规则和事实相关的记忆片段。",
            },
            "llm": "Search structured long-term memories (L1). Returns relevant memory fragments about user preferences, past events, rules, and facts.",
        },
    },
    "parameters": [
        {
            "name": "query",
            "type": "string",
            "required": True,
            "label": {"en_US": "Query", "zh_Hans": "查询"},
            "human_description": {"en_US": "Natural language search query.", "zh_Hans": "自然语言搜索查询。"},
            "llm_description": "Natural language search query describing what you want to recall.",
            "form": "llm",
        },
        {
            "name": "limit",
            "type": "number",
            "required": False,
            "default": 5,
            "label": {"en_US": "Limit", "zh_Hans": "数量限制"},
            "human_description": {"en_US": "Max results to return (default: 5, max: 20).", "zh_Hans": "最大返回数量（默认: 5, 最大: 20）。"},
            "llm_description": "Max results to return (default: 5, max: 20).",
            "form": "llm",
        },
        {
            "name": "type",
            "type": "select",
            "required": False,
            "options": [
                {"label": {"en_US": "Persona", "zh_Hans": "人设"}, "value": "persona"},
                {"label": {"en_US": "Episodic", "zh_Hans": "情节"}, "value": "episodic"},
                {"label": {"en_US": "Instruction", "zh_Hans": "指令"}, "value": "instruction"},
            ],
            "label": {"en_US": "Memory Type", "zh_Hans": "记忆类型"},
            "human_description": {"en_US": "Filter by memory type.", "zh_Hans": "按记忆类型筛选。"},
            "llm_description": "Optional filter by memory type: persona, episodic, or instruction.",
            "form": "llm",
        },
    ],
    "extra": {"python": {"source": "tools/memory_search.py"}},
}

CONVERSATION_SEARCH_TOOL_YAML: Dict[str, Any] = {
    "identity": {
        "name": "conversation_search",
        "author": "TDAI",
        "label": {"en_US": "Conversation Search", "zh_Hans": "对话搜索"},
        "description": {
            "human": {
                "en_US": "Search raw conversation history (L0). Returns original messages with timestamps.",
                "zh_Hans": "搜索原始对话历史（L0）。返回带有时间戳的原始消息。",
            },
            "llm": "Search raw conversation history (L0). Returns original messages with timestamps. Use when memory_search does not have the information you need.",
        },
    },
    "parameters": [
        {
            "name": "query",
            "type": "string",
            "required": True,
            "label": {"en_US": "Query", "zh_Hans": "查询"},
            "human_description": {"en_US": "Search query text.", "zh_Hans": "搜索查询文本。"},
            "llm_description": "Search query describing what conversation content you want to find.",
            "form": "llm",
        },
        {
            "name": "limit",
            "type": "number",
            "required": False,
            "default": 5,
            "label": {"en_US": "Limit", "zh_Hans": "数量限制"},
            "human_description": {"en_US": "Max messages to return (default: 5, max: 20).", "zh_Hans": "最大返回消息数（默认: 5, 最大: 20）。"},
            "llm_description": "Max messages to return (default: 5, max: 20).",
            "form": "llm",
        },
        {
            "name": "session_key",
            "type": "string",
            "required": False,
            "label": {"en_US": "Session Key", "zh_Hans": "会话标识"},
            "human_description": {"en_US": "Filter by session ID.", "zh_Hans": "按会话 ID 筛选。"},
            "llm_description": "Optional session ID to filter conversations.",
            "form": "llm",
        },
    ],
    "extra": {"python": {"source": "tools/conversation_search.py"}},
}

READ_SCENE_TOOL_YAML: Dict[str, Any] = {
    "identity": {
        "name": "read_scene",
        "author": "TDAI",
        "label": {"en_US": "Read Scene", "zh_Hans": "读取场景"},
        "description": {
            "human": {
                "en_US": "Read a scene block's full content by its name. Use when you see a scene listed in Scene Navigation.",
                "zh_Hans": "按名称读取场景块的完整内容。当你在场景导航中看到列出的场景时使用。",
            },
            "llm": "Read a scene block's full content by its name. Use when you see a scene listed in Scene Navigation.",
        },
    },
    "parameters": [
        {
            "name": "scene_id",
            "type": "string",
            "required": True,
            "label": {"en_US": "Scene ID", "zh_Hans": "场景标识"},
            "human_description": {"en_US": "Scene file name (e.g. 'travel-plan.md').", "zh_Hans": "场景文件名（例如 'travel-plan.md'）。"},
            "llm_description": "Scene file name (e.g. 'travel-plan.md' or 'travel-plan').",
            "form": "llm",
        },
    ],
    "extra": {"python": {"source": "tools/read_scene.py"}},
}


# ============================
# MemoryTencentdbDifyProvider
# ============================

class MemoryTencentdbDifyProvider(MemoryAdapterBase):
    """Dify-flavoured adapter for the TDAI memory system.

    Extends :class:`MemoryAdapterBase` and implements the 4 abstract methods
    with Dify-specific conventions:

    - Recall output uses XML-tagged blocks (``<relevant-memories>`` etc.) so
      Dify's prompt template can inject them cleanly.
    - Messages are normalised from Dify's ``{query, answer}`` or
      ``{role, content}`` formats.
    - Tool results are returned as plain text for Dify's ``text_message``.
    """

    platform_name = "dify"

    def __init__(self) -> None:
        super().__init__()

    def initialize_from_env(self) -> None:
        """Convenience: build config from environment and call :meth:`initialize`."""
        self.initialize(build_adapter_config_from_env())

    def initialize_from_credentials(self, credentials: Dict[str, Any]) -> None:
        """Convenience: build config from Dify credentials and initialize."""
        self.initialize(build_adapter_config_from_credentials(credentials))

    # -- Overridable hooks --------------------------------------------------

    def on_gateway_ready(self) -> None:
        logger.info(
            "TDAI memory Gateway ready for Dify (team=%s, agent=%s, user=%s)",
            self._tenancy.get("team_id", "default"),
            self._tenancy.get("agent_id", "default"),
            self._tenancy.get("user_id", "default"),
        )

    def on_gateway_unavailable(self, status: str) -> None:
        logger.warning(
            "TDAI memory Gateway unavailable at initialize (status=%s). "
            "Memory features will be disabled until the Gateway is reachable.",
            status,
        )

    def on_recall_error(self, err: Exception) -> None:
        logger.debug("TDAI memory recall failed: %s", err)

    def on_capture_error(self, error_msg: str) -> None:
        logger.warning("TDAI memory capture failed: %s", error_msg)

    # -- Abstract method implementations ------------------------------------

    def format_recall_result(self, result: RecallResult) -> FormattedRecallResult:
        """Format recall output as XML-tagged blocks for Dify's prompt format.

        L1 memories go into ``prepend_context`` (injected before the user
        query), while L3 persona and L2 scene navigation go into
        ``append_system_context`` (appended to the system prompt).
        """
        prepend_parts: List[str] = []
        append_parts: List[str] = []

        # L1 -- structured memories (prepend to user prompt)
        if result.memories:
            lines = [f"- [{m.type}] {m.content}" for m in result.memories]
            prepend_parts.append(
                "<relevant-memories>\n"
                "The following relevant memories were recalled for reference only:\n\n"
                + "\n".join(lines)
                + "\n</relevant-memories>"
            )

        # L3 -- persona / user core (append to system prompt)
        if result.persona and result.persona.content:
            append_parts.append(
                f"<user-core>\n{result.persona.content}\n</user-core>"
            )

        # L2 -- scene navigation (append to system prompt)
        if result.scenes:
            lines = []
            for s in result.scenes:
                name = s.path.replace(".md", "") if s.path else ""
                if s.summary:
                    lines.append(f"- Scene: {name} -- {s.summary}")
                else:
                    lines.append(f"- Scene: {name}")
            append_parts.append(
                "<scene-navigation>\n"
                "Available scenes (use the read_scene tool to open any):\n"
                + "\n".join(lines)
                + "\n</scene-navigation>"
            )

        return FormattedRecallResult(
            prepend_context="\n\n".join(prepend_parts) if prepend_parts else "",
            append_system_context="\n\n".join(append_parts) if append_parts else "",
        )

    def get_tool_definitions(self) -> List[ToolDefinition]:
        """Return Dify-flavoured tool definitions.

        Uses the ``memory_tencentdb_`` prefix for consistency with the
        Hermes plugin, and includes Dify-style descriptions.
        """
        return [
            ToolDefinition(
                name="memory_tencentdb_memory_search",
                label="Memory Search",
                description=(
                    "Search through the user's long-term memories. Use this "
                    "when you need to recall specific information about the "
                    "user's preferences, past events, instructions, or context "
                    "from previous conversations."
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Search query describing what you want to recall about the user.",
                        },
                        "limit": {
                            "type": "number",
                            "description": "Maximum number of results to return (default: 5, max: 20).",
                        },
                        "type": {
                            "type": "string",
                            "enum": ["persona", "episodic", "instruction"],
                            "description": "Optional filter by memory type.",
                        },
                    },
                    "required": ["query"],
                },
            ),
            ToolDefinition(
                name="memory_tencentdb_conversation_search",
                label="Conversation Search",
                description=(
                    "Search through past conversation history (raw dialogue "
                    "records). Use when memory_search doesn't have the "
                    "information you need, or when you want to find specific "
                    "past conversations."
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Search query describing what conversation content you want to find.",
                        },
                        "limit": {
                            "type": "number",
                            "description": "Maximum number of messages to return (default: 5, max: 20).",
                        },
                        "session_key": {
                            "type": "string",
                            "description": "Optional session ID to filter conversations.",
                        },
                    },
                    "required": ["query"],
                },
            ),
            ToolDefinition(
                name="memory_tencentdb_read_scene",
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
                            "description": "Scene file name (e.g. 'travel-plan.md' or 'travel-plan').",
                        },
                    },
                    "required": ["scene_id"],
                },
            ),
        ]

    def format_tool_result(
        self,
        tool_name: str,
        raw_result: Union[SearchResult, str],
    ) -> str:
        """Format a tool result as plain text for Dify's text_message.

        For :class:`SearchResult`, formats items as bullet points or returns
        the pre-formatted ``text`` field. For strings (scene content),
        returns them verbatim.
        """
        if isinstance(raw_result, str):
            return raw_result

        if isinstance(raw_result, SearchResult):
            # If the search already produced formatted text, use it.
            if raw_result.text:
                return raw_result.text
            if raw_result.items:
                if "conversation" in tool_name:
                    return "\n".join(
                        f"[{m.type}] {m.content}" for m in raw_result.items
                    )
                return "\n".join(
                    f"- [{m.type}] {m.content}" for m in raw_result.items
                )
            return "No results found."

        return str(raw_result)

    def normalize_messages(
        self,
        raw_messages: Any,
        context: Optional[Dict[str, Any]] = None,
    ) -> List[ConversationMessage]:
        """Convert Dify's message format into standard :class:`ConversationMessage`.

        Handles the following input shapes commonly produced by Dify:

        - A list of ``{"role": "user"|"assistant"|"system", "content": "..."}``
          dicts (optionally with ``"timestamp"``).
        - A list of ``{"query": "...", "answer": "..."}`` dicts (Dify
          Q&A / chatflow format).
        - A single string (treated as one user message).
        - A dict with a ``"messages"`` key wrapping any of the above.
        - A dict with ``"query"`` and ``"answer"`` keys (single Q&A pair).
        """
        messages: List[ConversationMessage] = []
        now_ts = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

        def _ts(item: Dict[str, Any], fallback: str = now_ts) -> Optional[str]:
            ts = item.get("timestamp") or item.get("created_at") or item.get("time")
            return str(ts) if ts else fallback

        # Unwrap a dict wrapper.
        if isinstance(raw_messages, dict):
            if "messages" in raw_messages:
                raw_messages = raw_messages["messages"]
            elif "query" in raw_messages or "answer" in raw_messages:
                raw_messages = [raw_messages]

        # Single string -> one user message.
        if isinstance(raw_messages, str):
            if raw_messages.strip():
                messages.append(ConversationMessage(
                    role="user", content=raw_messages.strip(), timestamp=now_ts,
                ))
            return messages

        if not isinstance(raw_messages, (list, tuple)):
            logger.debug("normalize_messages: unsupported type %s", type(raw_messages).__name__)
            return messages

        for item in raw_messages:
            if not isinstance(item, dict):
                # A bare string in the list -> user message.
                if isinstance(item, str) and item.strip():
                    messages.append(ConversationMessage(
                        role="user", content=item.strip(), timestamp=now_ts,
                    ))
                continue

            # Dify Q&A pair: {query, answer}
            query = item.get("query")
            answer = item.get("answer")
            if query is not None and answer is not None:
                if str(query).strip():
                    messages.append(ConversationMessage(
                        role="user", content=str(query).strip(), timestamp=_ts(item),
                    ))
                if str(answer).strip():
                    messages.append(ConversationMessage(
                        role="assistant", content=str(answer).strip(), timestamp=_ts(item),
                    ))
                continue

            # Dify input/output pair
            inp = item.get("input") or item.get("inputs")
            out = item.get("output") or item.get("outputs")
            if inp is not None and out is not None:
                if isinstance(inp, str) and inp.strip():
                    messages.append(ConversationMessage(
                        role="user", content=inp.strip(), timestamp=_ts(item),
                    ))
                if isinstance(out, str) and out.strip():
                    messages.append(ConversationMessage(
                        role="assistant", content=out.strip(), timestamp=_ts(item),
                    ))
                continue

            # Standard {role, content} format
            role = str(item.get("role", "user")).lower()
            content = item.get("content") or item.get("text") or ""
            if role not in ("user", "assistant", "system", "tool"):
                role = "user"
            content_str = str(content).strip() if content else ""
            if content_str:
                messages.append(ConversationMessage(
                    role=role,  # type: ignore[arg-type]
                    content=content_str,
                    timestamp=_ts(item),
                ))

        return messages


# ============================
# Dify plugin interface (Tool / ToolProvider)
# ============================
#
# These classes bridge the TDAI adapter into Dify's plugin SDK. They are
# guarded with a try/except import so that the package can be imported and
# unit-tested without the ``dify_plugin`` runtime installed.

try:
    from collections.abc import Generator as _Generator
    from dify_plugin import Tool as _DifyTool, ToolProvider as _DifyToolProvider
    from dify_plugin.entities.tool import ToolInvokeMessage as _ToolInvokeMessage
    from dify_plugin.errors.tool import ToolProviderCredentialValidationError

    _DIFY_AVAILABLE = True
except ImportError:  # pragma: no cover -- optional dependency
    _DIFY_AVAILABLE = False
    _DifyTool = object  # type: ignore[assignment, misc]
    _DifyToolProvider = object  # type: ignore[assignment, misc]
    _ToolInvokeMessage = object  # type: ignore[assignment, misc]
    _Generator = object  # type: ignore[assignment, misc]

    class ToolProviderCredentialValidationError(Exception):  # type: ignore[no-redef]
        """Fallback when ``dify_plugin`` is not installed."""


def _get_provider_from_tool(tool: Any) -> MemoryTencentdbDifyProvider:
    """Create or retrieve a :class:`MemoryTencentdbDifyProvider` from a Dify Tool.

    The provider is configured from the tool's runtime credentials (which
    override environment variables). The provider is cached on the tool
    instance so it is only initialised once per tool lifecycle.
    """
    cached = getattr(tool, "_tdai_provider", None)
    if cached is not None:
        return cached

    provider = MemoryTencentdbDifyProvider()
    credentials: Dict[str, Any] = {}
    runtime = getattr(tool, "runtime", None)
    if runtime is not None:
        credentials = getattr(runtime, "credentials", {}) or {}
    provider.initialize_from_credentials(credentials)
    tool._tdai_provider = provider  # type: ignore[attr-defined]
    return provider


class MemorySearchTool(_DifyTool):  # type: ignore[misc]
    """Dify Tool: search structured L1 memories."""

    def _invoke(self, tool_parameters: Dict[str, Any]) -> "_Generator[_ToolInvokeMessage]":  # type: ignore[override]
        provider = _get_provider_from_tool(self)
        query = str(tool_parameters.get("query", ""))
        if not query:
            yield self.create_text_message("Error: 'query' parameter is required.")
            return

        limit = tool_parameters.get("limit")
        type_filter = tool_parameters.get("type")
        result = provider.search_memories(
            query=query,
            limit=int(limit) if limit is not None else None,
            type_filter=str(type_filter) if type_filter else None,
        )
        yield self.create_text_message(result.text)


class ConversationSearchTool(_DifyTool):  # type: ignore[misc]
    """Dify Tool: search raw L0 conversation history."""

    def _invoke(self, tool_parameters: Dict[str, Any]) -> "_Generator[_ToolInvokeMessage]":  # type: ignore[override]
        provider = _get_provider_from_tool(self)
        query = str(tool_parameters.get("query", ""))
        if not query:
            yield self.create_text_message("Error: 'query' parameter is required.")
            return

        limit = tool_parameters.get("limit")
        session_key = tool_parameters.get("session_key")
        result = provider.search_conversations(
            query=query,
            limit=int(limit) if limit is not None else None,
            session_id=str(session_key) if session_key else None,
        )
        yield self.create_text_message(result.text)


class ReadSceneTool(_DifyTool):  # type: ignore[misc]
    """Dify Tool: read an L2 scene block by name."""

    def _invoke(self, tool_parameters: Dict[str, Any]) -> "_Generator[_ToolInvokeMessage]":  # type: ignore[override]
        provider = _get_provider_from_tool(self)
        scene_id = str(tool_parameters.get("scene_id", ""))
        if not scene_id:
            yield self.create_text_message("Error: 'scene_id' parameter is required.")
            return

        content = provider.read_scene(scene_id)
        yield self.create_text_message(content)


class MemoryTencentdbToolProvider(_DifyToolProvider):  # type: ignore[misc]
    """Dify ToolProvider: validates credentials by probing the Gateway.

    On validation, a :class:`MemoryTencentdbDifyProvider` is initialised from
    the supplied credentials and a health check is performed. If the Gateway
    is unreachable, validation fails with a clear error message.
    """

    def _validate_credentials(self, credentials: Dict[str, Any]) -> None:  # type: ignore[override]
        provider = MemoryTencentdbDifyProvider()
        try:
            provider.initialize_from_credentials(credentials)
        except Exception as e:
            raise ToolProviderCredentialValidationError(
                f"Failed to initialize TDAI memory provider: {e}"
            )

        if provider._client is None:
            raise ToolProviderCredentialValidationError(
                "TDAI memory provider was not initialized correctly."
            )

        health = provider._client.health(timeout_ms=3_000)
        status = health.get("status", "unknown")
        if status not in ("ok", "degraded"):
            raise ToolProviderCredentialValidationError(
                f"TDAI memory Gateway is not reachable (status={status}). "
                f"Please verify the endpoint and API key."
            )
        logger.info("TDAI memory credentials validated (Gateway status=%s)", status)
