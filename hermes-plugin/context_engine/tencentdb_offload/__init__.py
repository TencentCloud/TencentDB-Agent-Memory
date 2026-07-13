"""TencentDB Offload ContextEngine plugin for Hermes.

This plugin is intentionally HTTP-only: it does not import the TypeScript
runtime or the memory provider. Hermes can use it as a standalone context
engine, while the existing ``memory_tencentdb`` provider continues to own
long-term memory capture/recall.

Configuration is environment based so the plugin remains portable when copied
into a Hermes checkout:

  TENCENTDB_OFFLOAD_GATEWAY_URL      default: http://127.0.0.1:8420
  TENCENTDB_OFFLOAD_API_KEY          optional Bearer token
  TENCENTDB_OFFLOAD_THRESHOLD_RATIO  default: 0.4
  TENCENTDB_OFFLOAD_TIMEOUT_SECS     default: 10
  TENCENTDB_OFFLOAD_CONTEXT_LENGTH   default: 200000
  TENCENTDB_OFFLOAD_FALLBACK_KEEP    default: 12

The remote API is deliberately narrow. ``compress()`` posts to
``/v2/offload/compact`` and accepts either ``{"messages": [...]}`` or
``{"compacted_messages": [...]}``. If the Gateway is down or returns an
unexpected shape, Hermes receives a local tail-truncation fallback instead of
deadlocking the session.
"""

from __future__ import annotations

import logging
import os
import threading
from typing import Any, Dict, List, Optional

from .client import TencentdbOffloadClient
from .fallback import fallback_compress_messages

logger = logging.getLogger(__name__)

PLUGIN_NAME = "tencentdb-offload"


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = float(raw.strip())
    except ValueError:
        logger.warning("Invalid %s=%r; using default %s", name, raw, default)
        return default
    return value


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw.strip())
    except ValueError:
        logger.warning("Invalid %s=%r; using default %s", name, raw, default)
        return default
    return value


class TencentdbOffloadContextEngine:
    """Hermes ContextEngine backed by a TencentDB offload HTTP service."""

    def __init__(
        self,
        *,
        client: Optional[TencentdbOffloadClient] = None,
        threshold_ratio: Optional[float] = None,
        context_length: Optional[int] = None,
        fallback_keep: Optional[int] = None,
    ) -> None:
        self.client = client or TencentdbOffloadClient.from_env()
        self.threshold_ratio = threshold_ratio if threshold_ratio is not None else _env_float(
            "TENCENTDB_OFFLOAD_THRESHOLD_RATIO",
            0.4,
        )
        if self.threshold_ratio <= 0:
            self.threshold_ratio = 0.4
        self.context_length = context_length if context_length is not None else _env_int(
            "TENCENTDB_OFFLOAD_CONTEXT_LENGTH",
            200_000,
        )
        self.fallback_keep = fallback_keep if fallback_keep is not None else _env_int(
            "TENCENTDB_OFFLOAD_FALLBACK_KEEP",
            12,
        )

    def name(self) -> str:
        return PLUGIN_NAME

    def should_compress(
        self,
        prompt_tokens: Optional[int] = None,
        context_length: Optional[int] = None,
        **kwargs: Any,
    ) -> bool:
        """Return True when prompt size crosses the configured threshold."""
        tokens = prompt_tokens
        if tokens is None:
            tokens = kwargs.get("token_count") or kwargs.get("tokens")
        if tokens is None:
            return False
        try:
            token_count = int(tokens)
        except (TypeError, ValueError):
            return False
        length = context_length or kwargs.get("context_window") or self.context_length
        try:
            window = int(length)
        except (TypeError, ValueError):
            window = self.context_length
        threshold = max(1, int(window * self.threshold_ratio))
        return token_count >= threshold

    def compress(
        self,
        messages: List[Dict[str, Any]],
        **kwargs: Any,
    ) -> List[Dict[str, Any]]:
        """Compact messages remotely, falling back locally on any failure."""
        payload = {
            "messages": messages,
            "session_key": kwargs.get("session_key") or kwargs.get("sessionKey") or "",
            "context_length": kwargs.get("context_length") or kwargs.get("contextWindow") or self.context_length,
            "target_tokens": kwargs.get("target_tokens") or kwargs.get("targetTokens"),
        }
        try:
            result = self.client.compact(payload)
            compacted = _extract_messages(result)
            if compacted is not None:
                return compacted
            logger.warning("TencentDB offload compact returned unsupported shape; using fallback")
        except Exception as exc:
            logger.warning("TencentDB offload compact failed: %s; using fallback", exc)
        return fallback_compress_messages(messages, keep_tail=self.fallback_keep)

    def update_from_response(self, response: Any = None, **kwargs: Any) -> None:
        """Send response metadata for async ingest when available.

        Hermes calls this after the model responds. Ingest must not block the
        user path, so this method schedules a daemon thread and returns.
        """
        payload = {
            "response": response,
            "session_key": kwargs.get("session_key") or kwargs.get("sessionKey") or "",
            "messages": kwargs.get("messages"),
        }
        thread = threading.Thread(target=self._safe_ingest, args=(payload,), daemon=True)
        thread.start()

    def _safe_ingest(self, payload: Dict[str, Any]) -> None:
        try:
            self.client.ingest(payload)
        except Exception as exc:
            logger.debug("TencentDB offload ingest failed: %s", exc)


def _extract_messages(result: Dict[str, Any]) -> Optional[List[Dict[str, Any]]]:
    for key in ("messages", "compacted_messages"):
        value = result.get(key)
        if isinstance(value, list) and all(isinstance(item, dict) for item in value):
            return value
    return None


def create_context_engine() -> TencentdbOffloadContextEngine:
    """Factory used by plugin loaders that prefer factory functions."""
    return TencentdbOffloadContextEngine()


def register_context_engine(api: Any) -> Any:
    """Best-effort registration hook for Hermes-style plugin APIs."""
    engine = create_context_engine()
    register = getattr(api, "register_context_engine", None)
    if callable(register):
        return register(PLUGIN_NAME, engine)
    return engine


__all__ = [
    "PLUGIN_NAME",
    "TencentdbOffloadContextEngine",
    "create_context_engine",
    "register_context_engine",
]
