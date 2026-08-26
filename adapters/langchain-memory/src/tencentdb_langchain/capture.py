"""Conversation capture helpers for LangChain / LangGraph.

Recording observations (L0 conversations) is how TencentDB Agent Memory is
populated: the memory pipeline distills L1 facts from these records in the
background. These helpers make it a one-liner to feed a LangChain/LangGraph
conversation into that pipeline.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

from .client import AsyncTencentDBMemory, TencentDBMemory

__all__ = [
    "langchain_messages_to_dicts",
    "capture_conversation",
    "acapture_conversation",
    "create_capture_node",
]

_ROLE_MAP = {
    "human": "user",
    "user": "user",
    "ai": "assistant",
    "assistant": "assistant",
    "system": "system",
    "tool": "tool",
    "function": "tool",
}


def langchain_messages_to_dicts(messages: List[Any]) -> List[Dict[str, Any]]:
    """Convert LangChain message objects into ``{role, content}`` dicts.

    Any object with a ``type``/``role`` and ``content`` attribute is accepted;
    non-string content (e.g. multimodal blocks) is JSON-serialised.
    """
    import json

    result: List[Dict[str, Any]] = []
    for m in messages:
        if isinstance(m, dict):
            result.append({"role": str(m.get("role", "user")), "content": str(m.get("content", ""))})
            continue
        msg_type = getattr(m, "type", None) or getattr(m, "role", None) or "user"
        role = _ROLE_MAP.get(str(msg_type), "user")
        content = getattr(m, "content", "")
        if not isinstance(content, str):
            content = json.dumps(content, ensure_ascii=False)
        result.append({"role": role, "content": content})
    return result


def capture_conversation(
    memory: TencentDBMemory,
    messages: List[Any],
    *,
    session_id: Optional[str] = None,
) -> List[str]:
    """Capture a conversation turn (L0) through a sync client.

    ``messages`` may be LangChain messages or plain ``{role, content}`` dicts.
    Returns the accepted message ids.
    """
    return memory.capture(langchain_messages_to_dicts(messages), session_id=session_id)


async def acapture_conversation(
    memory: AsyncTencentDBMemory,
    messages: List[Any],
    *,
    session_id: Optional[str] = None,
) -> List[str]:
    """Async twin of :func:`capture_conversation`."""
    return await memory.capture(
        langchain_messages_to_dicts(messages), session_id=session_id
    )


def create_capture_node(
    memory: AsyncTencentDBMemory,
    *,
    session_id: Optional[str] = None,
    session_id_from_state: Optional[Callable[[Dict[str, Any]], Optional[str]]] = None,
    last_n: int = 2,
) -> Callable[[Dict[str, Any]], Dict[str, Any]]:
    """Return an async LangGraph node that captures the trailing exchange.

    The node is a *side-effecting* step: it reads ``state["messages"]``, captures
    the last ``last_n`` messages to memory, and returns ``{}`` (no state change),
    so it is safe to attach as a post-model step (e.g. via ``@after_model`` or as
    a plain edge target).

    ``session_id`` may be fixed, or resolved per-call with ``session_id_from_state``.
    """

    async def _capture_node(state: Dict[str, Any]) -> Dict[str, Any]:
        messages = state.get("messages") or []
        if not messages:
            return {}
        window = list(messages)[-last_n:] if last_n > 0 else list(messages)
        sid = session_id
        if sid is None and session_id_from_state is not None:
            sid = session_id_from_state(state)
        await acapture_conversation(memory, window, session_id=sid)
        return {}

    return _capture_node
