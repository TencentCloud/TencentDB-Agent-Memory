"""
bridge_adapter — Bridge (ZTHL) platform adapter for TencentDB Agent Memory v2 API.

Bridge is a zero-trust agent runtime for supply-chain security auditing,
part of the **Zero-Trust Heuristic Learning (ZTHL)** research system.

ZTHL addresses governance in Heuristic Learning — autonomous coding agents
that modify their own source code. The framework uses a Dual-Loop Governance
Protocol with structured review (F1-F7), three runtime gates (guard-edit,
advance, monitor), and self-referential validation.

Unlike the existing OpenClaw plugin (TypeScript, in-process) or Codex/Claude
Code adapters (MCP stdio), Bridge uses a Python async event loop with
function_tool + AgentHooks. This adapter communicates with the TDAI Gateway
via HTTP (httpx), providing recall/capture/search primitives.

Core capabilities:
  - recall(query)      → L1 atomic search + L3 core → prepend_context
  - capture(turn)      → L0 conversation write
  - search(query)      → explicit MCP-compatible tool endpoints
  - sync_profile(data) → PrefProfile ↔ L3 alignment
  - mcp_health()       → Gateway connectivity check

ZTHL is under double-blind review at a top computer science conference;
preprint pending approval on arXiv.

Environment variables:
  TDAI_ENDPOINT       — Gateway URL (default: http://127.0.0.1:8420)
  TDAI_API_KEY        — API key for authentication (optional for local)
  TDAI_SERVICE_ID     — Service/Space ID (default: mem-rkgqhd5z)
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from typing import Any, Dict, List, Optional

from .client import TdaiHttpClient
from .base import TdaiAdapter, TdaiAdapterRegistry, BufferedAdapter

logger = logging.getLogger("bridge_adapter")

# Circuit breaker defaults
_BREAKER_THRESHOLD = 5
_BREAKER_COOLDOWN = 60.0


class BridgeAdapter(TdaiAdapter):
    """Bridge (ZTHL) adapter for TDAI Gateway v2 API.

    Implements the TdaiAdapter interface. Register via TdaiAdapterRegistry
    so new platforms can discover and reuse the same contract.

    Three memory primitives:
      - recall: L1 atomic + L3 core → prepend_context for prompt injection
      - capture: L0 conversation write (user-assistant turn)
      - search: explicit memory/conversation search (MCP-compatible)

    Circuit breaker: 5 consecutive failures → 60s cooldown.
    Graceful degradation: Gateway unreachable → safe empty defaults.
    """

    NAME = "bridge_adapter"

    def __init__(self):
        super().__init__()
        self._client: Optional[TdaiHttpClient] = None
        self._available: bool = False
        self._lock = threading.Lock()

        # Circuit breaker
        self._consecutive_failures: int = 0
        self._circuit_open_until: float = 0

    @property
    def name(self) -> str:
        return self.NAME

    def is_available(self) -> bool:
        return self._available

    # ── Lifecycle ──────────────────────────────────────────────

    def initialize(
        self,
        endpoint: Optional[str] = None,
        api_key: Optional[str] = None,
        service_id: Optional[str] = None,
        **kwargs,
    ) -> None:
        """Initialize Gateway client with health check."""
        try:
            from .base import TdaiConfig
            self._config = TdaiConfig(
                endpoint=endpoint or os.environ.get("TDAI_ENDPOINT", "http://127.0.0.1:8420"),
                api_key=api_key or os.environ.get("TDAI_API_KEY", ""),
                service_id=service_id or os.environ.get("TDAI_SERVICE_ID", "mem-rkgqhd5z"),
            )
            self._client = TdaiHttpClient(
                endpoint=endpoint,
                api_key=api_key,
                service_id=service_id,
            )
            health = self._client.health()
            if health.get("status") == "ok":
                self._available = True
                logger.info(
                    f"BridgeAdapter initialized: "
                    f"endpoint={self._client._base_url}, "
                    f"service_id={self._client._service_id}, "
                    f"uptime={health.get('uptime', '?')}s"
                )
            else:
                logger.warning(f"Gateway health check returned non-ok: {health}")
        except Exception as e:
            logger.error(f"BridgeAdapter initialization failed: {e}")
            self._available = False

    def shutdown(self) -> None:
        """Release client."""
        self._client = None
        self._available = False
        logger.info("BridgeAdapter shut down")

    # ── Recall ─────────────────────────────────────────────────

    def _recall_impl(self, query: str, limit: int = 5) -> Dict[str, Any]:
        """Recall relevant memories for prompt injection.

        Combines L1 atomic search + L3 core profile into structured context.
        """
        if not self._available or not self._client:
            return {"prepend_context": "", "append_system_context": ""}

        def _do() -> Dict[str, Any]:
            memories_result = self._client.search_atomic(query=query, limit=limit)
            memories = memories_result.get("results", [])

            core_text = ""
            try:
                core_result = self._client.read_core()
                core_text = core_result.get("content", "")
            except Exception:
                pass

            scene_nav = ""
            try:
                scenarios = self._client.list_scenarios()
                entries = scenarios.get("entries", [])
                if entries:
                    lines = []
                    for s in entries:
                        name = s.get("path", "").replace("scene_blocks/", "").replace(".md", "")
                        lines.append(f"- Scene: {name} ({s.get('size', 0)} bytes)")
                    scene_nav = "Available scenes:\n" + "\n".join(lines)
            except Exception:
                pass

            prepend = ""
            if memories:
                memory_lines = []
                for m in memories:
                    content = m.get("content", "")
                    mtype = m.get("type", "observation")
                    memory_lines.append(f"- [{mtype}] {content}")
                prepend = (
                    "<relevant-memories>\n"
                    "以下是当前会话召回的相关记忆，仅作为参考：\n\n"
                    + "\n".join(memory_lines)
                    + "\n</relevant-memories>"
                )

            append_parts = []
            if core_text:
                append_parts.append(f"<user-core>\n{core_text}\n</user-core>")
            if scene_nav:
                append_parts.append(f"<scene-navigation>\n{scene_nav}\n</scene-navigation>")

            return {
                "prepend_context": prepend,
                "append_system_context": "\n\n".join(append_parts) if append_parts else "",
            }

        return self._safe_call("recall", _do) or {"prepend_context": "", "append_system_context": ""}

    # ── Capture ────────────────────────────────────────────────

    def _capture_impl(self, user_content: str, assistant_content: str, session_id: str = "") -> bool:
        """Write a conversation turn to L0.

        Returns True on success, False on graceful degradation.
        """
        if not self._available or not self._client:
            return False

        from datetime import datetime, timezone
        now = datetime.now(timezone.utc)
        user_ts = now.replace(microsecond=max(0, now.microsecond - 1000)).isoformat().replace("+00:00", "Z")
        assistant_ts = now.isoformat().replace("+00:00", "Z")

        def _do() -> bool:
            messages = [
                {"role": "user", "content": user_content, "timestamp": user_ts},
                {"role": "assistant", "content": assistant_content, "timestamp": assistant_ts},
            ]
            result = self._client.add_conversation(session_id=session_id, messages=messages)
            return result.get("code") == 0

        return self._safe_call("capture", _do) or False

    # ── Search (MCP-compatible) ────────────────────────────────

    def _search_memory_impl(self, query: str, limit: int = 5) -> List[Dict[str, Any]]:
        """Search L1 atomic memories."""
        if not self._available or not self._client:
            return []

        def _do() -> List[Dict[str, Any]]:
            result = self._client.search_atomic(query=query, limit=limit)
            return result.get("results", [])

        return self._safe_call("memory_search", _do) or []

    # Alias for external callers (test_bridge_provider, mcp_health)
    def memory_search(self, query: str, limit: int = 5) -> List[Dict[str, Any]]:
        return self._search_memory_impl(query, limit)

    # TdaiAdapter ABC requirement: search_memory
    def search_memory(self, query: str, limit: int = 5) -> List[Dict[str, Any]]:
        return self._search_memory_impl(query, limit)

    def _search_conversation_impl(self, query: str, limit: int = 5) -> List[Dict[str, Any]]:
        """Search L0 conversation history."""
        if not self._available or not self._client:
            return []

        def _do() -> List[Dict[str, Any]]:
            result = self._client.search_conversation(query=query, limit=limit)
            return result.get("results", [])

        return self._safe_call("conversation_search", _do) or []

    # Alias for external callers
    def conversation_search(self, query: str, limit: int = 5) -> List[Dict[str, Any]]:
        return self._search_conversation_impl(query, limit)

    # TdaiAdapter ABC requirement: search_conversation
    def search_conversation(self, query: str, limit: int = 5) -> List[Dict[str, Any]]:
        return self._search_conversation_impl(query, limit)

    # ── MCP Health ─────────────────────────────────────────────

    def mcp_health(self) -> Dict[str, Any]:
        """Gateway connectivity status for MCP health check."""
        if not self._client:
            return {"available": False, "reason": "client not initialized"}
        try:
            health = self._client.health()
            return {
                "available": health.get("status") == "ok",
                "gateway_uptime": health.get("uptime", 0),
                "stores": health.get("stores", {}),
            }
        except Exception as e:
            return {"available": False, "reason": str(e)}

    # ── Profile sync ───────────────────────────────────────────

    def sync_profile(self, profile_data: Dict[str, Any]) -> bool:
        """Sync Bridge's PrefProfile to TDAI L3 core."""
        if not self._available or not self._client:
            return False

        def _do() -> bool:
            result = self._client.write_profile(profile_data)
            return result.get("code") == 0

        return self._safe_call("sync_profile", _do) or False

    # ── Circuit breaker ────────────────────────────────────────

    def _safe_call(self, label: str, fn):
        """Execute fn with circuit breaker protection."""
        if self._consecutive_failures >= _BREAKER_THRESHOLD:
            if time.time() < self._circuit_open_until:
                logger.warning(f"[{label}] Circuit breaker open, skipping")
                return None
            else:
                logger.info(f"[{label}] Circuit half-open, retrying")

        try:
            result = fn()
            with self._lock:
                self._consecutive_failures = 0
            return result
        except Exception as e:
            with self._lock:
                self._consecutive_failures += 1
                if self._consecutive_failures >= _BREAKER_THRESHOLD:
                    self._circuit_open_until = time.time() + _BREAKER_COOLDOWN
                    logger.error(
                        f"[{label}] Circuit OPEN after {self._consecutive_failures} failures "
                        f"(cooldown={_BREAKER_COOLDOWN}s): {e}"
                    )
                else:
                    logger.warning(
                        f"[{label}] Failed ({self._consecutive_failures}/{_BREAKER_THRESHOLD}): {e}"
                    )
            return None


# Auto-register BridgeAdapter as the reference implementation
TdaiAdapterRegistry.register("bridge", BridgeAdapter)
