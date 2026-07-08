"""Dify tool definitions — memory search + conversation search.

Exposed to the Dify agent as two callable tools. Both route via the
standalone Gateway HTTP sidecar using MemoryTencentdbClient.
"""

from __future__ import annotations

from typing import Any, Dict

MEMORY_SEARCH_TOOL = {
    "name": "memory_tencentdb_memory_search",
    "description": {
        "en_US": (
            "Search through the user's long-term structured memories (L1). "
            "Use this when you need to recall specific information about the "
            "user's preferences, past events, instructions, or context from "
            "previous conversations. Returns relevant memory records ranked "
            "by relevance."
        ),
        "zh_Hans": (
            "搜索用户的长期结构化记忆（L1）。当你需要回忆用户的偏好、历史事件、"
            "指令或之前对话的上下文时使用此工具。返回按相关度排序的记忆记录。"
        ),
    },
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": {"en_US": "Search query.", "zh_Hans": "搜索查询。"},
            },
            "limit": {
                "type": "integer",
                "description": {"en_US": "Max results (default: 5, max: 20).", "zh_Hans": "最大返回数量（默认 5，上限 20）。"},
            },
            "type": {
                "type": "string",
                "enum": ["persona", "episodic", "instruction"],
                "description": {"en_US": "Optional memory type filter.", "zh_Hans": "可选记忆类型过滤。"},
            },
            "scene": {
                "type": "string",
                "description": {"en_US": "Optional scene name filter.", "zh_Hans": "可选场景名过滤。"},
            },
        },
        "required": ["query"],
    },
}

CONVERSATION_SEARCH_TOOL = {
    "name": "memory_tencentdb_conversation_search",
    "description": {
        "en_US": (
            "Search through past conversation history (raw L0 dialogue records). "
            "Use this when memory_tencentdb_memory_search doesn't have what you "
            "need, or when you want to find specific past conversations or exact "
            "words the user said before."
        ),
        "zh_Hans": (
            "搜索历史对话记录（原始 L0 对话）。当 memory_tencentdb_memory_search "
            "没有你需要的信息时，或想查找特定对话原文时使用。"
        ),
    },
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": {"en_US": "Search query.", "zh_Hans": "搜索查询。"},
            },
            "limit": {
                "type": "integer",
                "description": {"en_US": "Max results (default: 5, max: 20).", "zh_Hans": "最大返回数量（默认 5，上限 20）。"},
            },
            "session_key": {
                "type": "string",
                "description": {"en_US": "Optional session filter.", "zh_Hans": "可选的会话过滤。"},
            },
        },
        "required": ["query"],
    },
}

# Collect all tool definitions for the provider's tool listing
TOOL_DEFINITIONS: list[Dict[str, Any]] = [
    MEMORY_SEARCH_TOOL,
    CONVERSATION_SEARCH_TOOL,
]
