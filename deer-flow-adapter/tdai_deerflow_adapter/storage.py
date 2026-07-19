"""DeerFlow MemoryStorage adapter backed by TencentDB Agent Memory Gateway."""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from deerflow.agents.memory.storage import MemoryStorage, create_empty_memory, utc_now_iso_z

from .client import TdaiGatewayClient, TdaiGatewayError

logger = logging.getLogger(__name__)


def _session_key(agent_name: str | None, user_id: str | None) -> str:
    prefix = os.environ.get("TDAI_DEER_FLOW_STORAGE_SESSION_PREFIX", "deer-flow-memory").strip()
    parts = [prefix] if prefix else []
    if user_id:
        parts.append(f"user:{user_id}")
    if agent_name:
        parts.append(f"agent:{agent_name}")
    if not parts:
        return "deer-flow-memory"
    return ":".join(parts)


def _load_query(agent_name: str | None) -> str:
    configured = os.environ.get("TDAI_DEER_FLOW_STORAGE_RECALL_QUERY", "").strip()
    if configured:
        return configured
    if agent_name:
        return f"Current long-term memory context for DeerFlow agent {agent_name}"
    return "Current long-term memory context for DeerFlow"


def _memory_from_context(context: str) -> dict[str, Any]:
    memory = create_empty_memory()
    context = context.strip()
    if not context:
        return memory

    now = utc_now_iso_z()
    memory["user"]["topOfMind"] = {
        "summary": context,
        "updatedAt": now,
    }
    memory["facts"] = [
        {
            "id": "tdai_recalled_context",
            "content": context,
            "category": "context",
            "confidence": 1.0,
            "createdAt": now,
            "source": "tencentdb-agent-memory",
        }
    ]
    memory["lastUpdated"] = now
    return memory


def _memory_to_text(memory_data: dict[str, Any]) -> str:
    max_chars_raw = os.environ.get("TDAI_DEER_FLOW_STORAGE_CAPTURE_MAX_CHARS", "20000").strip()
    try:
        max_chars = int(max_chars_raw)
    except ValueError:
        max_chars = 20000
    max_chars = max(1000, max_chars)

    text = json.dumps(memory_data, ensure_ascii=False, indent=2, sort_keys=True)
    if len(text) > max_chars:
        return text[:max_chars] + "\n...[truncated]"
    return text


class TdaiMemoryStorage(MemoryStorage):
    """DeerFlow storage provider that proxies memory reads/writes to the Gateway.

    This class is useful when an operator wants to configure DeerFlow's native
    ``memory.storage_class`` instead of instantiating custom middlewares. For
    direct turn-level capture, prefer :class:`tdai_deerflow_adapter.TdaiMemoryMiddleware`.
    """

    def __init__(self, client: TdaiGatewayClient | None = None) -> None:
        self._client = client or TdaiGatewayClient()

    def load(self, agent_name: str | None = None, *, user_id: str | None = None) -> dict[str, Any]:
        return self.reload(agent_name, user_id=user_id)

    def reload(self, agent_name: str | None = None, *, user_id: str | None = None) -> dict[str, Any]:
        session_key = _session_key(agent_name, user_id)
        try:
            response = self._client.recall(
                query=_load_query(agent_name),
                session_key=session_key,
                user_id=user_id,
            )
        except TdaiGatewayError as exc:
            logger.warning("TencentDB Agent Memory storage load failed: %s", exc)
            return create_empty_memory()

        context = response.get("context")
        return _memory_from_context(context) if isinstance(context, str) else create_empty_memory()

    def save(self, memory_data: dict[str, Any], agent_name: str | None = None, *, user_id: str | None = None) -> bool:
        session_key = _session_key(agent_name, user_id)
        try:
            self._client.capture(
                user_content="DeerFlow native memory state update",
                assistant_content=_memory_to_text(memory_data),
                session_key=session_key,
                session_id=session_key,
                user_id=user_id,
                messages=[
                    {"role": "user", "content": "DeerFlow native memory state update"},
                    {"role": "assistant", "content": _memory_to_text(memory_data)},
                ],
            )
        except TdaiGatewayError as exc:
            logger.warning("TencentDB Agent Memory storage save failed: %s", exc)
            return False
        return True
