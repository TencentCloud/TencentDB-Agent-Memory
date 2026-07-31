"""memory_tencentdb_dify -- Dify plugin adapter for the TDAI memory system.

This package provides a Python SDK and Dify plugin integration for the
TDAI four-layer memory engine (L0 conversation, L1 extraction, L2 scene
blocks, L3 persona synthesis) via the local Gateway HTTP API.

Single import point for any new Agent platform that wants to integrate
with the TDAI memory engine::

    from memory_tencentdb_dify import (
        MemoryAdapterBase,
        MemoryGatewayClient,
        MemoryTencentdbDifyProvider,
    )

New platforms only need to:
1. Extend :class:`MemoryAdapterBase`
2. Implement 4 abstract methods
3. Call ``initialize()`` -> ``recall()`` / ``capture()`` / ``search_memories()``
"""

from __future__ import annotations

from .base_adapter import (
    BREAKER_COOLDOWN_MS,
    BREAKER_THRESHOLD,
    DEFAULT_CONVERSATION_SEARCH_TOOL,
    DEFAULT_MEMORY_SEARCH_TOOL,
    DEFAULT_READ_SCENE_TOOL,
    MemoryAdapterBase,
)
from .gateway_client import GatewayError, MemoryGatewayClient
from .provider import (
    CONVERSATION_SEARCH_TOOL_YAML,
    MEMORY_SEARCH_TOOL_YAML,
    READ_SCENE_TOOL_YAML,
    ConversationSearchTool,
    MemorySearchTool,
    MemoryTencentdbDifyProvider,
    MemoryTencentdbToolProvider,
    ReadSceneTool,
    build_adapter_config_from_credentials,
    build_adapter_config_from_env,
)
from .types import (
    AdapterConfig,
    CaptureResult,
    ConversationMessage,
    FormattedRecallResult,
    GatewayConnectionConfig,
    MemoryItem,
    PersonaContent,
    RecallResult,
    SceneEntry,
    SearchResult,
    TenancyConfig,
    ToolDefinition,
    ToolParameter,
)

__version__ = "1.0.0"

__all__ = [
    # Base adapter
    "MemoryAdapterBase",
    "DEFAULT_MEMORY_SEARCH_TOOL",
    "DEFAULT_CONVERSATION_SEARCH_TOOL",
    "DEFAULT_READ_SCENE_TOOL",
    "BREAKER_THRESHOLD",
    "BREAKER_COOLDOWN_MS",
    # Gateway client
    "MemoryGatewayClient",
    "GatewayError",
    # Dify provider
    "MemoryTencentdbDifyProvider",
    "MemoryTencentdbToolProvider",
    "MemorySearchTool",
    "ConversationSearchTool",
    "ReadSceneTool",
    "build_adapter_config_from_env",
    "build_adapter_config_from_credentials",
    "MEMORY_SEARCH_TOOL_YAML",
    "CONVERSATION_SEARCH_TOOL_YAML",
    "READ_SCENE_TOOL_YAML",
    # Types
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
