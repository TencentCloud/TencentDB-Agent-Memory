"""Hermes ContextEngine skeleton backed by the memory-tencentdb Gateway.

This module exposes a **short-term-memory / context-compression** adapter
for Hermes agents that uses the TencentDB Gateway's offload V2 API
(``POST /v2/offload/ingest`` and ``POST /v2/offload/compact``).

It implements the ContextEngine contract that Hermes agent loop expects,
mirroring the short-memory behaviour provided by the bundled OpenClaw
offload plugin:

* ``on_before_prompt_build(messages)`` — heartbeat filtering, MMD context
  injection, then a four-level cascade:
  ``fastpath -> mild -> aggressive -> emergency`` via the Gateway compact
  endpoint. Returns a compacted (or unmodified) messages list.
* ``on_after_tool_call(tool_name, tool_call_id, params, result, error)``
  — ships the (tool_call, tool_result) pair to the Gateway for L1
  extraction pipeline processing via ``/v2/offload/ingest``.

Design goals:

1. **Zero third-party dependencies** — stdlib ``urllib`` only, same as
   :class:`MemoryTencentdbSdkClient`. Keeps Hermes install-time footprint
   trivial and avoids version conflicts with the Hermes host.
2. **Graceful local fallback** — if the Gateway is unreachable (process
   not started, host/port changed, etc.) the adapter logs a single
   warning per incident and returns the original messages intact, so
   Hermes never crashes on memory-stack transient failures. A
   per-session counter is kept for operator triage.
3. **Fully opt-in** — users register it as ``context_engine:
   memory_tencentdb`` alongside the memory provider. Existing
   installations without that config key are not touched.
4. **Gateway-agnostic** — reuses the same
   :class:`MemoryTencentdbSdkClient` used by the memory provider,
   inheriting its circuit-breaker, timeouts, and health checks.

Configuration (``~/.hermes/hermes.yaml`` or the ``plugins.entries``
section)::

    agents:
      defaults:
        context_engine: memory_tencentdb

    plugins:
      entries:
        memory_tencentdb:
          enabled: true
          slots:
            context_engine: memory_tencentdb
          config:
            gateway:
              host: 127.0.0.1
              port: 8420
              api_key: ""
            context_window: 200000   # used to derive mild/aggressive ratios
            fallback_threshold: 5    # in-flight fallback events before WARN

"""

from __future__ import annotations

import json
import logging
import threading
import time
from typing import Any, Dict, List, Optional

from .client import MemoryTencentdbSdkClient

logger = logging.getLogger("memory_tencentdb.context_engine")

# Gateway offload endpoints — keep as consts so a future V3 URL revision is
# a one-line change and not a grep exercise.
_OFFLOAD_V2_INGEST = "/v2/offload/ingest"
_OFFLOAD_V2_COMPACT = "/v2/offload/compact"

# When Gateway is unreachable we fall back to returning messages unmodified.
# Once this many consecutive in-loop failures have been observed for a single
# session we bump the next log to WARN level (instead of DEBUG) so operators
# can see that short-memory is *not* operating without having to grep DEBUG.
_FALLBACK_WARN_INTERVAL = 5
_MAX_MESSAGES_BEFORE_SKIP = 6
_MAX_INPUT_CHARS_EST = 20_000


def _msg_is_heartbeat(msg: Dict[str, Any]) -> bool:
    """Filter heartbeat / keepalive pseudo-messages.

    These are injected by Hermes itself to probe an idle session and should
    never contribute to memory accounting, L1 extraction, or context-window
    math. A heartbeat is identified by content that contains the literal
    string ``HEARTBEAT.md`` (the path used by Hermes's alive-detect tool),
    or a ``tool_use`` / ``tool_result`` block with that marker.
    """
    if not msg:
        return False
    try:
        raw = json.dumps(msg, ensure_ascii=False, default=str)
    except Exception:
        return False
    return "HEARTBEAT.md" in raw


class TencentdbContextEngine:
    """Hermes ContextEngine adapter backed by the memory-tencentdb Gateway.

    Implements the minimal surface area that the Hermes agent loop
    expects from a ContextEngine:

    - ``before_prompt_build(messages, context_window)``
    - ``after_tool_call(tool_name, tool_call_id, params, result, error, session_id)``

    When the Gateway is unavailable both methods degrade to a local
    no-op that returns / preserves the original conversation.
    """

    def __init__(
        self,
        *,
        gateway_host: str = "127.0.0.1",
        gateway_port: int = 8420,
        gateway_api_key: Optional[str] = None,
        context_window: int = 200_000,
        client: Optional[MemoryTencentdbSdkClient] = None,
    ) -> None:
        self.context_window = max(int(context_window), 1_000)
        if client is not None:
            self._client = client
        else:
            self._client = MemoryTencentdbSdkClient(
                base_url=f"http://{gateway_host}:{gateway_port}",
                api_key=gateway_api_key,
            )
        self._fallback_counts: Dict[str, int] = {}
        self._fallback_lock = threading.Lock()

    # ── public API (Hermes ContextEngine contract) ─────────────────────

    def before_prompt_build(
        self,
        messages: List[Dict[str, Any]],
        *,
        context_window: Optional[int] = None,
        session_key: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Potentially compact *messages* before Hermes calls the LLM.

        Steps performed when the Gateway is reachable:

        1. Drop heartbeat pseudo-messages in place.
        2. Ask the Gateway's offload V2 compact endpoint for a 4-level
           cascade decision. Pass the configured context_window so the
           Gateway applies its built-in mild/aggressive/emergency ratios.
        3. If the Gateway returns ``modified_messages`` we return those;
           otherwise return the original list.

        Fail-open behaviour: any transient error leaves messages exactly
        as they were. No exception propagates into the Hermes loop.
        """
        if not messages or not isinstance(messages, list):
            return messages

        # 1. Heartbeat filtering. Run locally so a Gateway restart can't
        #    cause heartbeats to leak through and inflate the bill.
        try:
            before_len = len(messages)
            messages = [m for m in messages if not _msg_is_heartbeat(m)]
            if len(messages) != before_len:
                logger.debug(
                    f"[tdai-context] heartbeat drop: {before_len} -> {len(messages)} msgs"
                )
        except Exception as exc:  # pragma: no cover — defensive
            logger.debug(f"[tdai-context] heartbeat filter skipped: {exc}")

        # Fast-path: nothing compactable.
        if len(messages) < _MAX_MESSAGES_BEFORE_SKIP:
            return messages
        # Fast-path: clearly small message list, skip the RPC to avoid
        # paying round-trip cost for trivially small context.
        try:
            total_chars = sum(
                len(m.get("content", "") or "") if isinstance(m, dict) else 0
                for m in messages
            )
        except Exception:
            total_chars = _MAX_INPUT_CHARS_EST + 1
        if total_chars < _MAX_INPUT_CHARS_EST:
            return messages

        eff_window = int(context_window or self.context_window)
        sess_key = session_key or "__global__"
        try:
            payload: Dict[str, Any] = {
                "messages": messages,
                "context_window": eff_window,
                "mild_ratio": 0.75,
                "aggressive_ratio": 0.9,
                "emergency_ratio": 0.97,
            }
            if session_key:
                payload["session_key"] = session_key
            resp = self._client.post_json(_OFFLOAD_V2_COMPACT, payload)
            self._clear_fallback(sess_key)
            modified = resp.get("modified_messages") or resp.get("messages")
            if isinstance(modified, list) and modified:
                if logger.isEnabledFor(logging.DEBUG):
                    saved = len(messages) - len(modified)
                    logger.debug(
                        f"[tdai-context] compact applied: {len(messages)} msgs -> "
                        f"{len(modified)} (saved≈{saved}). reason={resp.get('decision')}"
                    )
                return modified
            return messages
        except Exception as exc:
            self._record_fallback(
                sess_key,
                f"before_prompt_build: compact RPC failed ({exc.__class__.__name__})",
            )
            return messages

    def after_tool_call(
        self,
        *,
        tool_name: str,
        tool_call_id: str,
        params: Optional[Dict[str, Any]] = None,
        result: Any = None,
        error: Optional[str] = None,
        session_key: Optional[str] = None,
        duration_ms: Optional[int] = None,
    ) -> None:
        """Send a (tool_call, tool_result) pair to the Gateway for L1 ingest.

        Non-blocking, best-effort. Any Gateway-side issue is swallowed and
        counted toward the fallback tally.
        """
        if not tool_call_id:
            return
        sess_key = session_key or "__global__"
        body: Dict[str, Any] = {
            "tool_name": tool_name,
            "tool_call_id": tool_call_id,
            "params": params or {},
            "result": result,
            "error": error,
        }
        if session_key:
            body["session_key"] = session_key
        if duration_ms is not None:
            body["duration_ms"] = int(duration_ms)
        # The heartbeat filter at compact time would eat this pair, but
        # still skip sending it to the Gateway to keep traffic sane.
        try:
            probe = json.dumps(body, ensure_ascii=False, default=str)
            if "HEARTBEAT.md" in probe:
                return
        except Exception:
            pass
        try:
            self._client.post_json(_OFFLOAD_V2_INGEST, body)
            self._clear_fallback(sess_key)
        except Exception as exc:
            self._record_fallback(
                sess_key,
                f"after_tool_call: ingest RPC failed ({exc.__class__.__name__})",
            )

    # ── internals (fallback accounting) ────────────────────────────────

    def _record_fallback(self, session_key: str, reason: str) -> None:
        with self._fallback_lock:
            count = self._fallback_counts.get(session_key, 0) + 1
            self._fallback_counts[session_key] = count
        level = (
            logging.WARN
            if count == 1 or count % _FALLBACK_WARN_INTERVAL == 0
            else logging.DEBUG
        )
        logger.log(
            level,
            f"[tdai-context] FALLBACK (session={session_key}, count={count}): "
            f"{reason}. Short-memory disabled for this turn; returning messages "
            f"unmodified. Start the memory-tencentdb Gateway to enable context "
            f"compression (see memory_tencentdb plugin README).",
        )

    def _clear_fallback(self, session_key: str) -> None:
        with self._fallback_lock:
            if session_key in self._fallback_counts:
                del self._fallback_counts[session_key]

    # ── introspection helpers (test / docs) ────────────────────────────

    @property
    def fallback_counts(self) -> Dict[str, int]:
        with self._fallback_lock:
            return dict(self._fallback_counts)
