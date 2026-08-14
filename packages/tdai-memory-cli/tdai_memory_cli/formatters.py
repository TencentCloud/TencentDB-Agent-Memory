from __future__ import annotations

from typing import Any

from .gateway_http import GatewayHttpError


def format_recall(result: dict[str, Any]) -> str:
    context = str(result.get("context") or "").strip()
    lines = [
        "# TDAI Memory Recall",
        "",
        f"strategy: {result.get('strategy', 'unknown')}",
        f"memory_count: {result.get('memory_count', 0)}",
    ]
    if context:
        lines.extend(["", "## Context", "", context])
    else:
        lines.extend(["", "No recalled memory context was returned."])
    return "\n".join(lines)


def format_capture(result: dict[str, Any]) -> str:
    return "\n".join([
        "# TDAI Memory Capture",
        "",
        f"l0_recorded: {result.get('l0_recorded', 0)}",
        f"scheduler_notified: {_format_bool(bool(result.get('scheduler_notified')))}",
    ])


def format_session_end(result: dict[str, Any]) -> str:
    return "\n".join([
        "# TDAI Session End",
        "",
        f"flushed: {_format_bool(bool(result.get('flushed')))}",
    ])


def format_error(error: BaseException) -> str:
    status = "error"
    path = ""
    if isinstance(error, GatewayHttpError):
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
