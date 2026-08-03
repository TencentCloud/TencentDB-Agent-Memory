"""Hermes ContextEngine backed by MemoryCore's Offload V2 API."""

from __future__ import annotations

import json
import logging
import os
import re
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

try:
    from agent.context_engine import ContextEngine
except ModuleNotFoundError as exc:
    if exc.name not in {"agent", "agent.context_engine"}:
        raise
    # Keep the module self-testable outside a Hermes checkout. Hermes itself
    # always provides the real ABC before loading user plugins.
    class ContextEngine:  # type: ignore[no-redef]
        pass


logger = logging.getLogger(__name__)

ENGINE_NAME = "tencentdb_offload"
_SAFE_SESSION_CHARS = re.compile(r"[^a-zA-Z0-9_.:-]+")


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default


def _normalize_session_id(value: str) -> str:
    normalized = _SAFE_SESSION_CHARS.sub("_", (value or "").strip()).strip("_")
    return (normalized or "hermes")[:500]


def _estimate_tokens(messages: List[Dict[str, Any]]) -> int:
    """Return a conservative fallback when Hermes has no usage count yet."""
    try:
        serialized = json.dumps(messages, ensure_ascii=False, default=str)
    except Exception:
        serialized = str(messages)
    return max(1, (len(serialized) + 3) // 4)


class OffloadV2Client:
    """Minimal stdlib client for ``POST /v2/offload/compact``."""

    def __init__(
        self,
        base_url: str,
        *,
        api_key: str = "local",
        service_id: str = "default",
        timeout: float = 30.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key or "local"
        self.service_id = service_id or "default"
        self.timeout = timeout

    @classmethod
    def from_env(cls) -> "OffloadV2Client":
        return cls(
            os.environ.get("TDAI_MEMORY_ENDPOINT", "http://127.0.0.1:8420"),
            api_key=os.environ.get("TDAI_MEMORY_API_KEY", "local"),
            service_id=os.environ.get("TDAI_MEMORY_SERVICE_ID", "default"),
            timeout=_env_float("TDAI_OFFLOAD_COMPACTION_TIMEOUT_SECONDS", 30.0),
        )

    def compact(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        request = urllib.request.Request(
            f"{self.base_url}/v2/offload/compact",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
                "X-TDAI-Service-Id": self.service_id,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(
                f"Offload compact returned HTTP {exc.code}: {detail[:300]}"
            ) from exc

        if not isinstance(raw, dict) or raw.get("code") != 0:
            raise RuntimeError(
                f"Offload compact returned an error envelope: {raw!r}"
            )
        data = raw.get("data")
        if not isinstance(data, dict):
            raise RuntimeError("Offload compact response is missing data")
        return data


class TencentdbOffloadContextEngine(ContextEngine):
    """Hermes context engine that delegates compaction to MemoryCore."""

    emit_automatic_compaction_status = False

    def __init__(
        self,
        *,
        client: Optional[OffloadV2Client] = None,
        context_length: Optional[int] = None,
        threshold_percent: Optional[float] = None,
    ) -> None:
        self.client = client or OffloadV2Client.from_env()
        self.context_length = max(
            1_000,
            context_length
            if context_length is not None
            else _env_int("TDAI_OFFLOAD_CONTEXT_LENGTH", 128_000),
        )
        configured_threshold = (
            threshold_percent
            if threshold_percent is not None
            else _env_float("TDAI_OFFLOAD_COMPACTION_RATIO", 0.5)
        )
        self.threshold_percent = min(0.99, max(0.05, configured_threshold))
        self.threshold_tokens = int(
            self.context_length * self.threshold_percent
        )
        self.last_prompt_tokens = 0
        self.last_completion_tokens = 0
        self.last_total_tokens = 0
        self.compression_count = 0
        self._session_id = "hermes"

    @property
    def name(self) -> str:
        return ENGINE_NAME

    def update_from_response(self, usage: Dict[str, Any]) -> None:
        usage = usage or {}
        self.last_prompt_tokens = int(
            usage.get("prompt_tokens") or usage.get("input_tokens") or 0
        )
        self.last_completion_tokens = int(
            usage.get("completion_tokens") or usage.get("output_tokens") or 0
        )
        self.last_total_tokens = int(
            usage.get("total_tokens")
            or self.last_prompt_tokens + self.last_completion_tokens
        )

    def should_compress(self, prompt_tokens: int = None) -> bool:
        tokens = (
            self.last_prompt_tokens
            if prompt_tokens is None
            else max(0, int(prompt_tokens))
        )
        return tokens >= self.threshold_tokens

    def compress(
        self,
        messages: List[Dict[str, Any]],
        current_tokens: Optional[int] = None,
        focus_topic: Optional[str] = None,
        force: bool = False,
        memory_context: str = "",
    ) -> List[Dict[str, Any]]:
        del focus_topic, force, memory_context
        if not messages:
            return messages

        total_tokens = int(
            current_tokens
            or self.last_prompt_tokens
            or _estimate_tokens(messages)
        )
        ratio = min(
            2.0,
            max(0.0, total_tokens / max(1, self.context_length)),
        )
        payload = {
            "session_id": self._session_id,
            "messages": messages,
            "ratio": ratio,
            "context_window": self.context_length,
            "total_tokens": max(0, total_tokens),
        }

        try:
            data = self.client.compact(payload)
        except Exception as exc:
            logger.warning(
                "TencentDB offload compaction failed; preserving original "
                "messages: %s",
                exc,
            )
            return messages

        compacted = data.get("messages")
        if not isinstance(compacted, list) or not all(
            isinstance(message, dict) for message in compacted
        ):
            logger.warning(
                "TencentDB offload compaction returned invalid messages; "
                "preserving original messages"
            )
            return messages

        self.compression_count += 1
        self.last_prompt_tokens = 0
        self.last_total_tokens = 0
        return compacted

    def on_session_start(self, session_id: str, **kwargs: Any) -> None:
        del kwargs
        self._session_id = _normalize_session_id(session_id)

    def on_session_end(
        self,
        session_id: str,
        messages: List[Dict[str, Any]],
    ) -> None:
        del session_id, messages
        self._session_id = "hermes"


def register(ctx: Any) -> None:
    """Register the engine through Hermes's ordinary user-plugin loader."""
    ctx.register_context_engine(TencentdbOffloadContextEngine())


__all__ = [
    "ENGINE_NAME",
    "OffloadV2Client",
    "TencentdbOffloadContextEngine",
    "register",
]
