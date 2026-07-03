"""
HermesV2Adapter — Hermes v2 Provider - TdaiAdapter ----.

------- SDK -----------。
Hermes v2 --- MemoryProvider --, --------- TdaiAdapter --。
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional

from .base import TdaiAdapter, TdaiAdapterRegistry

logger = logging.getLogger("hermes_v2_adapter")

# Lazy SDK import
_sdk_available = False
try:
    from tencentdb_agent_memory import MemoryClient as _MemoryClient, TDAMError
    _sdk_available = True
except ImportError:
    _MemoryClient = None


class HermesV2Adapter(TdaiAdapter):
    """Hermes v2 MemoryProvider --- TdaiAdapter.

    ---- SDK ------, --:
      - ---- (Bridge / Hermes) -------
      - ------- TdaiAdapter - 6 ---
    """

    NAME = "hermes_v2"

    def __init__(self):
        self._client: Optional[Any] = None
        self._available: bool = False

    @property
    def name(self) -> str:
        return self.NAME

    def initialize(
        self,
        endpoint: Optional[str] = None,
        api_key: Optional[str] = None,
        service_id: Optional[str] = None,
        **kwargs,
    ) -> None:
        if not _sdk_available:
            logger.warning("tencentdb_agent_memory SDK not available")
            return
        ep = endpoint or os.environ.get("TDAI_ENDPOINT", "http://127.0.0.1:8420")
        ak = api_key or os.environ.get("TDAI_API_KEY", "local")
        sid = service_id or os.environ.get("TDAI_SERVICE_ID", "mem-rkgqhd5z")
        try:
            self._client = _MemoryClient(endpoint=ep, api_key=ak, service_id=sid)
            self._available = True
            logger.info(f"HermesV2Adapter initialized: {ep}")
        except Exception as e:
            logger.error(f"HermesV2Adapter init failed: {e}")

    def is_available(self) -> bool:
        return self._available and _sdk_available

    def _recall_impl(self, query: str, limit: int = 5) -> Dict[str, Any]:
        if not self._available or not self._client:
            return {"prepend_context": "", "append_system_context": ""}
        try:
            results = self._client.search_atomic(query=query, limit=limit)
            mems = results.get("results", [])
            if mems:
                lines = [f"- [{m.get('type','?')}] {m.get('content','')}" for m in mems]
                prepend = "<relevant-memories>\n" + "\n".join(lines) + "\n</relevant-memories>"
                return {"prepend_context": prepend, "append_system_context": ""}
            return {"prepend_context": "", "append_system_context": ""}
        except Exception as e:
            logger.warning(f"HermesV2Adapter recall failed: {e}")
            return {"prepend_context": "", "append_system_context": ""}

    def _capture_impl(self, user_content: str, assistant_content: str, session_id: str = "") -> bool:
        if not self._available or not self._client:
            return False
        try:
            from datetime import datetime, timezone
            now = datetime.now(timezone.utc)
            uts = now.replace(microsecond=0).isoformat().replace("+00:00", "Z")
            ats = uts
            msgs = [
                {"role": "user", "content": user_content, "timestamp": uts},
                {"role": "assistant", "content": assistant_content, "timestamp": ats},
            ]
            self._client.add_conversation(session_id=session_id or "hermes-v2-default", messages=msgs)
            return True
        except Exception as e:
            logger.warning(f"HermesV2Adapter capture failed: {e}")
            return False

    def _search_memory_impl(self, query: str, limit: int = 5) -> List[Dict[str, Any]]:
        if not self._available or not self._client:
            return []
        try:
            result = self._client.search_atomic(query=query, limit=limit)
            return result.get("results", [])
        except Exception as e:
            logger.warning(f"HermesV2Adapter search_memory failed: {e}")
            return []

    def _search_conversation_impl(self, query: str, limit: int = 5) -> List[Dict[str, Any]]:
        if not self._available or not self._client:
            return []
        try:
            result = self._client.search_conversation(query=query, limit=limit)
            return result.get("results", [])
        except Exception as e:
            logger.warning(f"HermesV2Adapter search_conversation failed: {e}")
            return []

    def shutdown(self) -> None:
        self._client = None
        self._available = False
        logger.info("HermesV2Adapter shut down")


# Auto-register as second TdaiAdapter implementation
TdaiAdapterRegistry.register("hermes_v2", HermesV2Adapter)
