"""LangGraph node adapter for TencentDB Agent Memory."""

from __future__ import annotations

import os
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage

from ._sdk import ensure_adapter_sdk_path

ensure_adapter_sdk_path()

from tdai_adapter_sdk import AdapterSession, CompletedTurn, TdaiAdapterRuntime, TdaiGatewayClient  # noqa: E402

_MEMORY_CONTEXT_KEY = "tdai_memory_context"


def _text_from_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "\n".join(parts)
    return str(content) if content is not None else ""


def _message_role(message: Any) -> str:
    if isinstance(message, HumanMessage):
        return "user"
    if isinstance(message, AIMessage):
        return "assistant"
    if isinstance(message, SystemMessage):
        return "system"
    if isinstance(message, dict):
        return str(message.get("role") or message.get("type") or "").lower()
    return str(getattr(message, "type", "") or getattr(message, "role", "") or "").lower()


def _message_text(message: Any) -> str:
    if isinstance(message, dict):
        return _text_from_content(message.get("content")).strip()
    return _text_from_content(getattr(message, "content", "")).strip()


def _message_to_payload(message: Any) -> dict[str, str]:
    role = _message_role(message)
    if role == "human":
        role = "user"
    if role == "ai":
        role = "assistant"
    return {"role": role or "user", "content": _message_text(message)}


def _state_messages(state: dict[str, Any]) -> list[Any]:
    messages = state.get("messages")
    return list(messages) if isinstance(messages, list) else []


class TdaiLangGraphAdapter:
    """Small LangGraph node wrapper around the shared adapter SDK."""

    def __init__(
        self,
        *,
        client: TdaiGatewayClient | None = None,
        session_prefix: str | None = None,
    ) -> None:
        self.session_prefix = session_prefix if session_prefix is not None else os.environ.get("TDAI_LANGGRAPH_SESSION_PREFIX", "langgraph")
        self._runtime = TdaiAdapterRuntime(
            platform=_LangGraphPlatformAdapter(self),
            client=client,
        )

    def recall_node(self, state: dict[str, Any]) -> dict[str, Any]:
        return self._runtime.handle({"event": "recall", "state": state}) or {}

    def capture_node(self, state: dict[str, Any]) -> dict[str, Any]:
        self._runtime.handle({"event": "capture", "state": state})
        return {}

    def session_end_node(self, state: dict[str, Any]) -> dict[str, Any]:
        self._runtime.handle({"event": "session_end", "state": state})
        return {}


class _LangGraphPlatformAdapter:
    def __init__(self, owner: TdaiLangGraphAdapter) -> None:
        self._owner = owner

    def event(self, request: dict[str, Any]) -> str:
        event = request.get("event")
        return event if isinstance(event, str) else "ignore"

    def session(self, request: dict[str, Any]) -> AdapterSession | None:
        state = request.get("state")
        if not isinstance(state, dict):
            return None

        thread_id = state.get("thread_id") or state.get("session_id")
        if not isinstance(thread_id, str) or not thread_id.strip():
            return None

        prefix = self._owner.session_prefix.strip()
        session_key = f"{prefix}:{thread_id.strip()}" if prefix else thread_id.strip()
        user_id = state.get("user_id")
        return AdapterSession(
            session_key=session_key,
            session_id=thread_id.strip(),
            user_id=user_id.strip() if isinstance(user_id, str) and user_id.strip() else None,
        )

    def recall_query(self, request: dict[str, Any], context: dict[str, Any]) -> str | None:
        state = request.get("state")
        if not isinstance(state, dict):
            return None
        for message in reversed(_state_messages(state)):
            if _message_role(message) in {"user", "human"}:
                return _message_text(message)
        return None

    def inject_recall(self, context_text: str, request: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
        state = request.get("state")
        messages = _state_messages(state) if isinstance(state, dict) else []
        memory_message = SystemMessage(
            content=f"TencentDB Agent Memory recalled context:\n{context_text}",
            additional_kwargs={_MEMORY_CONTEXT_KEY: True, "hide_from_ui": True},
        )
        return {"messages": [memory_message, *messages]}

    def completed_turn(self, request: dict[str, Any], context: dict[str, Any]) -> CompletedTurn | None:
        state = request.get("state")
        if not isinstance(state, dict):
            return None

        assistant_content = ""
        user_content = ""
        messages = _state_messages(state)
        for message in reversed(messages):
            role = _message_role(message)
            if not assistant_content and role in {"assistant", "ai"}:
                assistant_content = _message_text(message)
                continue
            if assistant_content and role in {"user", "human"}:
                user_content = _message_text(message)
                break

        if not user_content or not assistant_content:
            return None

        session = context.get("session")
        session_id = session.session_id if isinstance(session, AdapterSession) else None
        user_id = session.user_id if isinstance(session, AdapterSession) else None
        return CompletedTurn(
            user_content=user_content,
            assistant_content=assistant_content,
            session_id=session_id,
            user_id=user_id,
            messages=[_message_to_payload(m) for m in messages if _message_role(m) in {"user", "human", "assistant", "ai"}],
        )

    def pass_through(self, request: dict[str, Any], context: dict[str, Any]) -> dict[str, Any] | None:
        return None
