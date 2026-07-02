"""Local fallback compaction for the TencentDB Hermes ContextEngine."""

from __future__ import annotations

from typing import Any, Dict, List

FALLBACK_NOTICE = (
    "[TencentDB offload fallback] Earlier conversation messages were omitted "
    "because the remote offload service was unavailable. Continue from the "
    "remaining recent context."
)


def fallback_compress_messages(
    messages: List[Dict[str, Any]],
    *,
    keep_tail: int = 12,
) -> List[Dict[str, Any]]:
    """Keep system messages plus the recent tail, inserting a valid notice."""
    if keep_tail <= 0:
        keep_tail = 12

    system_messages = [m for m in messages if m.get("role") == "system"]
    non_system = [m for m in messages if m.get("role") != "system"]
    tail = non_system[-keep_tail:]

    if len(tail) == len(non_system):
        return list(messages)

    notice = {"role": "system", "content": FALLBACK_NOTICE}
    return [*system_messages, notice, *tail]
