"""DeerFlow middleware for turn-level TencentDB Agent Memory recall/capture."""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
from collections import deque
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import HumanMessage

from .client import TdaiGatewayClient, TdaiGatewayError
from ._sdk import ensure_adapter_sdk_path

ensure_adapter_sdk_path()

from tdai_adapter_sdk import AdapterSession, CompletedTurn, TdaiAdapterRuntime  # noqa: E402

logger = logging.getLogger(__name__)

_TDAI_MEMORY_CONTEXT_KEY = "tdai_memory_context"
_TDAI_MEMORY_USER_KEY = "tdai_memory_user"


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


def _message_text(message: Any) -> str:
    return _text_from_content(getattr(message, "content", "")).strip()


def _message_type(message: Any) -> str:
    return str(getattr(message, "type", "") or "").lower()


def _is_hidden(message: Any) -> bool:
    additional_kwargs = getattr(message, "additional_kwargs", None)
    return isinstance(additional_kwargs, dict) and bool(additional_kwargs.get("hide_from_ui"))


def _is_human(message: Any) -> bool:
    return _message_type(message) == "human"


def _is_ai(message: Any) -> bool:
    return _message_type(message) == "ai"


def _session_prefix() -> str:
    return os.environ.get("TDAI_DEER_FLOW_SESSION_PREFIX", "deer-flow").strip()


def _fallback_user_id() -> str:
    return (
        os.environ.get("TDAI_DEER_FLOW_USER_ID")
        or os.environ.get("USER")
        or os.environ.get("USERNAME")
        or "default_user"
    )


class TdaiMemoryMiddleware(AgentMiddleware):
    """Inject recalled memory before a DeerFlow turn and capture the final turn.

    The middleware is intentionally fail-open: Gateway errors are logged as
    warnings and never block DeerFlow's agent execution.
    """

    def __init__(
        self,
        *,
        client: TdaiGatewayClient | None = None,
        max_capture_cache: int = 512,
    ) -> None:
        super().__init__()
        self._client = client or TdaiGatewayClient()
        self._runtime = TdaiAdapterRuntime(
            platform=_DeerFlowPlatformAdapter(self),
            client=self._client,
            adapter_logger=logger,
        )
        self._captured_turns: deque[tuple[str, str, str]] = deque(maxlen=max_capture_cache)
        self._captured_turn_keys: set[tuple[str, str, str]] = set()

    @staticmethod
    def _runtime_context(runtime: Any) -> dict[str, Any]:
        context = getattr(runtime, "context", None)
        return context if isinstance(context, dict) else {}

    @classmethod
    def _thread_id(cls, runtime: Any) -> str | None:
        context = cls._runtime_context(runtime)
        raw = context.get("thread_id") or context.get("session_id")
        if isinstance(raw, str) and raw.strip():
            return raw.strip()

        try:
            from langgraph.config import get_config

            config = get_config()
            configurable = config.get("configurable", {}) if isinstance(config, dict) else {}
            raw = configurable.get("thread_id") or configurable.get("session_id")
            if isinstance(raw, str) and raw.strip():
                return raw.strip()
        except Exception:
            return None
        return None

    @classmethod
    def _session_key(cls, runtime: Any) -> str | None:
        thread_id = cls._thread_id(runtime)
        if not thread_id:
            return None
        prefix = _session_prefix()
        return f"{prefix}:{thread_id}" if prefix else thread_id

    @classmethod
    def _user_id(cls, runtime: Any) -> str:
        context = cls._runtime_context(runtime)
        raw = context.get("user_id")
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
        try:
            from deerflow.runtime.user_context import get_effective_user_id

            effective = get_effective_user_id()
            if isinstance(effective, str) and effective.strip():
                return effective.strip()
        except Exception:
            pass
        return _fallback_user_id()

    @staticmethod
    def _last_visible_human(messages: list[Any]) -> Any | None:
        for message in reversed(messages):
            if not _is_human(message) or _is_hidden(message):
                continue
            additional_kwargs = getattr(message, "additional_kwargs", None)
            if isinstance(additional_kwargs, dict) and additional_kwargs.get(_TDAI_MEMORY_CONTEXT_KEY):
                continue
            return message
        return None

    @staticmethod
    def _build_recall_messages(original: Any, context: str) -> list[HumanMessage]:
        stable_id = getattr(original, "id", None) or str(uuid.uuid4())
        original_kwargs = getattr(original, "additional_kwargs", None)
        cloned_kwargs = dict(original_kwargs) if isinstance(original_kwargs, dict) else {}
        cloned_kwargs[_TDAI_MEMORY_USER_KEY] = True

        memory_content = "\n".join(
            [
                "<memory>",
                "TencentDB Agent Memory recalled context:",
                context,
                "</memory>",
            ]
        )

        return [
            HumanMessage(
                content=memory_content,
                id=stable_id,
                additional_kwargs={
                    "hide_from_ui": True,
                    _TDAI_MEMORY_CONTEXT_KEY: True,
                },
            ),
            HumanMessage(
                content=getattr(original, "content", ""),
                id=f"{stable_id}__tdai_user",
                name=getattr(original, "name", None),
                additional_kwargs=cloned_kwargs,
            ),
        ]

    def _recall(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        return self._runtime.handle({"event": "recall", "state": state, "runtime": runtime})

    @staticmethod
    def _filtered_messages(messages: list[Any]) -> list[Any]:
        try:
            from deerflow.agents.memory.message_processing import filter_messages_for_memory

            return list(filter_messages_for_memory(messages))
        except Exception:
            return [
                message
                for message in messages
                if not _is_hidden(message) and (_is_human(message) or (_is_ai(message) and not getattr(message, "tool_calls", None)))
            ]

    @staticmethod
    def _last_turn(messages: list[Any]) -> tuple[str, str] | None:
        assistant_content = ""
        user_content = ""

        for message in reversed(messages):
            if not assistant_content and _is_ai(message) and not getattr(message, "tool_calls", None):
                assistant_content = _message_text(message)
                continue
            if assistant_content and _is_human(message):
                user_content = _message_text(message)
                break

        if user_content and assistant_content:
            return user_content, assistant_content
        return None

    def _remember_captured(self, key: tuple[str, str, str]) -> bool:
        if key in self._captured_turn_keys:
            return False
        if len(self._captured_turns) == self._captured_turns.maxlen and self._captured_turns:
            old = self._captured_turns[0]
            self._captured_turn_keys.discard(old)
        self._captured_turns.append(key)
        self._captured_turn_keys.add(key)
        return True

    def _capture(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        return self._runtime.handle({"event": "capture", "state": state, "runtime": runtime})

    def before_agent(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        return self._recall(state, runtime)

    async def abefore_agent(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        return await asyncio.to_thread(self._recall, state, runtime)

    def after_agent(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        return self._capture(state, runtime)

    async def aafter_agent(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        return await asyncio.to_thread(self._capture, state, runtime)


class _DeerFlowPlatformAdapter:
    """DeerFlow-specific lifecycle mapping for the shared adapter runtime."""

    def __init__(self, owner: TdaiMemoryMiddleware) -> None:
        self._owner = owner

    def event(self, request: dict[str, Any]) -> str:
        event = request.get("event")
        return event if isinstance(event, str) else "ignore"

    def _messages(self, request: dict[str, Any]) -> list[Any]:
        state = request.get("state")
        return list(state.get("messages", [])) if isinstance(state, dict) else []

    def session(self, request: dict[str, Any]) -> AdapterSession | None:
        runtime = request.get("runtime")
        session_key = self._owner._session_key(runtime)
        if not session_key:
            return None
        return AdapterSession(
            session_key=session_key,
            session_id=self._owner._thread_id(runtime),
            user_id=self._owner._user_id(runtime),
        )

    def recall_query(self, request: dict[str, Any], context: dict[str, Any]) -> str | None:
        original = self._owner._last_visible_human(self._messages(request))
        if original is None:
            return None

        original_kwargs = getattr(original, "additional_kwargs", None)
        if isinstance(original_kwargs, dict) and original_kwargs.get(_TDAI_MEMORY_USER_KEY):
            return None
        return _message_text(original)

    def inject_recall(self, context_text: str, request: dict[str, Any], context: dict[str, Any]) -> dict[str, Any] | None:
        original = self._owner._last_visible_human(self._messages(request))
        if original is None:
            return None
        return {"messages": self._owner._build_recall_messages(original, context_text)}

    def completed_turn(self, request: dict[str, Any], context: dict[str, Any]) -> CompletedTurn | None:
        session = context.get("session")
        if not isinstance(session, AdapterSession):
            return None

        turn = self._owner._last_turn(self._owner._filtered_messages(self._messages(request)))
        if turn is None:
            return None

        user_content, assistant_content = turn
        capture_key = (session.session_key, user_content, assistant_content)
        if not self._owner._remember_captured(capture_key):
            return None

        return CompletedTurn(
            user_content=user_content,
            assistant_content=assistant_content,
            session_id=session.session_id,
            user_id=session.user_id,
            messages=[
                {"role": "user", "content": user_content},
                {"role": "assistant", "content": assistant_content},
            ],
        )

    def pass_through(self, request: dict[str, Any], context: dict[str, Any]) -> None:
        return None
