"""Runtime helper for thin TencentDB Agent Memory platform adapters."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Protocol

from .client import TdaiGatewayClient

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class AdapterSession:
    session_key: str
    session_id: str | None = None
    user_id: str | None = None


@dataclass(slots=True)
class CompletedTurn:
    user_content: str
    assistant_content: str
    session_id: str | None = None
    user_id: str | None = None
    messages: list[dict[str, Any]] | None = None


class PlatformAdapter(Protocol):
    def event(self, request: Any) -> str: ...
    def session(self, request: Any) -> AdapterSession | None: ...
    def recall_query(self, request: Any, context: dict[str, Any]) -> str | None: ...
    def completed_turn(self, request: Any, context: dict[str, Any]) -> CompletedTurn | None: ...
    def inject_recall(self, context_text: str, request: Any, context: dict[str, Any]) -> Any: ...
    def pass_through(self, request: Any, context: dict[str, Any]) -> Any: ...


def _non_empty(value: Any) -> str:
    return value.strip() if isinstance(value, str) and value.strip() else ""


def _event_name(value: str | None) -> str:
    if value == "sessionEnd":
        return "session_end"
    if value == "session-end":
        return "session_end"
    return value or "ignore"


class TdaiAdapterRuntime:
    """Runs recall/capture/session-end against the Gateway for a platform adapter."""

    def __init__(
        self,
        *,
        platform: PlatformAdapter,
        client: TdaiGatewayClient | None = None,
        fail_open: bool = True,
        adapter_logger: logging.Logger | None = None,
    ) -> None:
        self.platform = platform
        self.client = client or TdaiGatewayClient()
        self.fail_open = fail_open
        self.logger = adapter_logger or logger

    def handle(self, request: Any) -> Any:
        context = {"client": self.client, "logger": self.logger}
        try:
            event = _event_name(self.platform.event(request))
            if event == "recall":
                return self._handle_recall(request, context)
            if event == "capture":
                return self._handle_capture(request, context)
            if event == "session_end":
                return self._handle_session_end(request, context)
            return self._pass_through(request, context)
        except Exception as exc:
            if not self.fail_open:
                raise
            self.logger.warning("TencentDB Agent Memory adapter failed open: %s", exc)
            return self._pass_through(request, context)

    def _session(self, request: Any, context: dict[str, Any]) -> AdapterSession | None:
        session = self.platform.session(request)
        if not session or not _non_empty(session.session_key):
            return None
        return session

    def _handle_recall(self, request: Any, context: dict[str, Any]) -> Any:
        session = self._session(request, context)
        if not session:
            return self._pass_through(request, context)
        context = {**context, "session": session}
        query = _non_empty(self.platform.recall_query(request, context))
        if not query:
            return self._pass_through(request, context)
        response = self.client.recall(
            query=query,
            session_key=session.session_key,
            user_id=session.user_id,
        )
        context_text = _non_empty(response.get("context"))
        if not context_text:
            return self._pass_through(request, context)
        return self.platform.inject_recall(context_text, request, {**context, "query": query, "recall": response})

    def _handle_capture(self, request: Any, context: dict[str, Any]) -> Any:
        session = self._session(request, context)
        if not session:
            return self._pass_through(request, context)
        context = {**context, "session": session}
        turn = self.platform.completed_turn(request, context)
        if not turn or not _non_empty(turn.user_content) or not _non_empty(turn.assistant_content):
            return self._pass_through(request, context)
        response = self.client.capture(
            user_content=turn.user_content,
            assistant_content=turn.assistant_content,
            session_key=session.session_key,
            session_id=turn.session_id or session.session_id,
            user_id=turn.user_id or session.user_id,
            messages=turn.messages,
        )
        after_capture = getattr(self.platform, "after_capture", None)
        if callable(after_capture):
            after_capture(response, request, {**context, "turn": turn})
        return self._pass_through(request, context)

    def _handle_session_end(self, request: Any, context: dict[str, Any]) -> Any:
        session = self._session(request, context)
        if not session:
            return self._pass_through(request, context)
        response = self.client.end_session(session_key=session.session_key, user_id=session.user_id)
        after_session_end = getattr(self.platform, "after_session_end", None)
        if callable(after_session_end):
            after_session_end(response, request, {**context, "session": session})
        return self._pass_through(request, context)

    def _pass_through(self, request: Any, context: dict[str, Any]) -> Any:
        return self.platform.pass_through(request, context)
