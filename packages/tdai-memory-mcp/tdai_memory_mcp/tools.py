from __future__ import annotations

from typing import Any

from .client import GatewayClient
from .formatters import format_conversation_search, format_error, format_memory_search

TOOLS: list[dict[str, Any]] = [
    {
        "name": "tdai_memory_search",
        "description": "Search L1 structured memories through the existing Gateway /search/memories API.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query."},
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 50,
                    "description": "Maximum result count. Defaults to 5.",
                },
                "type": {"type": "string", "description": "Optional L1 memory type filter."},
                "scene": {"type": "string", "description": "Optional scene filter."},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "name": "tdai_conversation_search",
        "description": "Search L0 raw conversations through the existing Gateway /search/conversations API.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query."},
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 50,
                    "description": "Maximum result count. Defaults to 5.",
                },
                "session_key": {"type": "string", "description": "Optional session key filter."},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
]


def call_tool(name: str, args: Any, client: GatewayClient) -> dict[str, Any]:
    try:
        data = args if isinstance(args, dict) else {}
        if name == "tdai_memory_search":
            query = _require_string(data, "query")
            return _text_result(format_memory_search(client.search_memories(
                query=query,
                limit=_normalize_limit(data.get("limit")),
                type_filter=_optional_string(data.get("type")),
                scene=_optional_string(data.get("scene")),
            )))
        if name == "tdai_conversation_search":
            query = _require_string(data, "query")
            return _text_result(format_conversation_search(client.search_conversations(
                query=query,
                limit=_normalize_limit(data.get("limit")),
                session_key=_optional_string(data.get("session_key")),
            )))
        return _error_result(f"Unknown tool: {name}")
    except Exception as error:
        return _error_result(format_error(error))


def _text_result(text: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}]}


def _error_result(text: str) -> dict[str, Any]:
    return {"isError": True, "content": [{"type": "text", "text": text}]}


def _require_string(data: dict[str, Any], key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"Missing required string argument: {key}")
    return value.strip()


def _optional_string(value: Any) -> str:
    return value.strip() if isinstance(value, str) and value.strip() else ""


def _normalize_limit(value: Any) -> int:
    if value is None or value == "":
        return 5
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return 5
    if parsed < 1:
        return 5
    return min(parsed, 50)
