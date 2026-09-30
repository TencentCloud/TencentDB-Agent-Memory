"""Unified Adapter SDK -- Type definitions.

These types define the contract between any Agent platform and the TDAI memory
engine. A new platform only needs to implement the ``MemoryAdapterBase``
abstract class; all Gateway communication, health checking, circuit breaking,
and error handling are handled by the SDK base class.

This module is the Python counterpart to the TypeScript
``src/adapters/sdk/types.ts``.

Design goals:
1. Platform-agnostic -- no dependency on Dify, Hermes, MCP, or any specific
   agent framework.
2. Minimal surface area -- platforms implement 4 abstract methods.
3. Graceful degradation -- every method returns empty results on failure
   rather than raising, so the host agent never crashes.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional, TypedDict

__all__ = [
    "GatewayConnectionConfig",
    "TenancyConfig",
    "AdapterConfig",
    "ConversationMessage",
    "MemoryItem",
    "PersonaContent",
    "SceneEntry",
    "RecallResult",
    "CaptureResult",
    "SearchResult",
    "ToolDefinition",
    "ToolParameter",
    "FormattedRecallResult",
]


# ============================
# Configuration
# ============================


class GatewayConnectionConfig(TypedDict, total=False):
    """Connection configuration for the TDAI Gateway.

    Attributes:
        endpoint: Gateway base URL (e.g. ``http://127.0.0.1:8420``).
        api_key: Optional Bearer API key for authentication.
        service_id: Instance / service ID for multi-tenant routing.
        timeout_ms: Request timeout in milliseconds (default: 10000).
        reject_unauthorized: Whether to reject unauthorized TLS certs.
    """

    endpoint: str
    api_key: Optional[str]
    service_id: str
    timeout_ms: int
    reject_unauthorized: bool


class TenancyConfig(TypedDict, total=False):
    """Tenancy identifiers for v3 API isolation.

    All fields default to ``"default"`` when omitted.
    """

    team_id: str
    agent_id: str
    user_id: str


class AdapterConfig(TypedDict, total=False):
    """Full adapter configuration passed to :meth:`MemoryAdapterBase.initialize`.

    Attributes:
        gateway: Gateway connection settings.
        tenancy: Tenancy isolation (all default to ``"default"``).
        recall_max_results: Maximum L1 memories to recall per turn (default: 5).
        recall_include_persona: Whether to include L3 persona (default: True).
        recall_include_scene_nav: Whether to include L2 scene nav (default: True).
        capture_enabled: Whether conversation capture is enabled (default: True).
    """

    gateway: GatewayConnectionConfig
    tenancy: TenancyConfig
    recall_max_results: int
    recall_include_persona: bool
    recall_include_scene_nav: bool
    capture_enabled: bool


# ============================
# Memory data types
# ============================


@dataclass
class ConversationMessage:
    """A single message in a conversation.

    Attributes:
        role: The speaker role -- ``user``, ``assistant``, ``system``, or ``tool``.
        content: The message content text.
        timestamp: ISO 8601 timestamp (optional).
    """

    role: Literal["user", "assistant", "system", "tool"]
    content: str
    timestamp: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Serialize to a plain dict for JSON transport."""
        result: Dict[str, Any] = {"role": self.role, "content": self.content}
        if self.timestamp is not None:
            result["timestamp"] = self.timestamp
        return result


@dataclass
class MemoryItem:
    """An L1 structured memory item.

    Attributes:
        type: Memory type (e.g. ``persona``, ``episodic``, ``instruction``).
        content: Memory content text.
        score: Relevance score (0..1), optional.
        metadata: Optional metadata dict.
        timestamp: Optional ISO 8601 timestamp (used for L0 conversation items).
    """

    type: str
    content: str
    score: Optional[float] = None
    metadata: Optional[Dict[str, Any]] = None
    timestamp: Optional[str] = None


@dataclass
class PersonaContent:
    """L3 persona / user core content.

    Attributes:
        content: The persona/core text.
        updated_at: When the persona was last updated (ISO 8601).
    """

    content: str
    updated_at: Optional[str] = None


@dataclass
class SceneEntry:
    """L2 scene navigation entry.

    Attributes:
        path: Scene file path (e.g. ``scene_blocks/travel.md``).
        summary: Scene summary, optional.
        heat: Heat score (access frequency), optional.
    """

    path: str
    summary: Optional[str] = None
    heat: Optional[int] = None


# ============================
# Result types
# ============================


@dataclass
class RecallResult:
    """Result of a recall (prefetch) operation.

    Attributes:
        prepend_context: Text to prepend to the user's prompt (L1 memories).
        append_system_context: Text to append to the system prompt (persona, scene nav).
        memories: Raw L1 memory items (for platform-specific formatting).
        persona: Raw L3 persona content (if available).
        scenes: Raw L2 scene entries (if available).
        latency_ms: Recall latency in milliseconds.
    """

    prepend_context: str = ""
    append_system_context: str = ""
    memories: List[MemoryItem] = field(default_factory=list)
    persona: Optional[PersonaContent] = None
    scenes: List[SceneEntry] = field(default_factory=list)
    latency_ms: int = 0


@dataclass
class CaptureResult:
    """Result of a capture operation.

    Attributes:
        captured_count: Number of messages captured.
        success: Whether the Gateway accepted the capture.
        error: Error message on failure, optional.
    """

    captured_count: int = 0
    success: bool = False
    error: Optional[str] = None


@dataclass
class SearchResult:
    """Result of a memory search operation.

    Attributes:
        text: Formatted text result for LLM consumption.
        total: Total matching items.
        items: Raw memory items (for platform-specific formatting).
    """

    text: str = ""
    total: int = 0
    items: List[MemoryItem] = field(default_factory=list)


# ============================
# Tool definition (for platform tool registration)
# ============================


class ToolParameter(TypedDict, total=False):
    """JSON Schema fragment for a single tool parameter."""

    type: str
    description: str
    enum: List[str]


@dataclass
class ToolDefinition:
    """A tool definition that platforms register with their host.

    Attributes:
        name: Tool name (unique within the platform).
        description: Tool description for the LLM.
        parameters: JSON Schema for tool parameters.
        label: Human-readable label, optional.
    """

    name: str
    description: str
    parameters: Dict[str, Any]
    label: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Serialize to a plain dict for platform registration."""
        result: Dict[str, Any] = {
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters,
        }
        if self.label is not None:
            result["label"] = self.label
        return result


class FormattedRecallResult(TypedDict, total=False):
    """Return type of :meth:`MemoryAdapterBase.format_recall_result`."""

    prepend_context: str
    append_system_context: str
