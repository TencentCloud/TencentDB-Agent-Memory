from __future__ import annotations

from typing import Any

from .gateway_transport import McpGatewayHttpError


def format_health(result: dict[str, Any]) -> str:
    stores = result.get("stores") if isinstance(result.get("stores"), dict) else {}
    return "\n".join([
        "# TDAI Gateway Health",
        "",
        f"status: {result.get('status', 'unknown')}",
        f"version: {result.get('version', 'unknown')}",
        f"uptime_seconds: {result.get('uptime', 'unknown')}",
        f"vector_store: {_format_bool(bool(stores.get('vectorStore')))}",
        f"embedding_service: {_format_bool(bool(stores.get('embeddingService')))}",
    ])


def format_memory_search(result: dict[str, Any]) -> str:
    return "\n".join([
        "# TDAI Memory Search",
        "",
        f"total: {result.get('total', 0)}",
        f"strategy: {result.get('strategy', 'unknown')}",
        "",
        str(result.get("results") or "No memories matched the query.").strip(),
    ])


def format_conversation_search(result: dict[str, Any]) -> str:
    return "\n".join([
        "# TDAI Conversation Search",
        "",
        f"total: {result.get('total', 0)}",
        "",
        str(result.get("results") or "No conversations matched the query.").strip(),
    ])


def format_error(error: BaseException) -> str:
    status = "error"
    path = ""
    if isinstance(error, McpGatewayHttpError):
        status = f"HTTP {error.status}" if error.status > 0 else "error"
        path = error.path
    lines = [
        "# TDAI Memory Adapter Error",
        "",
        f"{status}: {error}",
    ]
    if path:
        lines.append(f"path: {path}")
    return "\n".join(lines)


def _format_bool(value: bool) -> str:
    return "true" if value else "false"
