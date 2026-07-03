"""
CodexAdapter 鈥?TdaiAdapter wrapping Codex built-in memories via MCP stdio.

Codex (https://github.com/openai/codex) provides a `memories` extension with
four MCP tools (search/list/read/add_ad_hoc_note) that map directly to the
TdaiAdapter interface.

This adapter calls Codex's MCP server via the `codex mcp call` CLI. It requires
Codex CLI v0.137.0+ to be installed and available on PATH.

Usage:
    from bridge_adapter import TdaiAdapterRegistry
    from bridge_adapter.codex_adapter import CodexAdapter

    TdaiAdapterRegistry.register("codex", CodexAdapter)
    adapter = TdaiAdapterRegistry.create("codex", codex_path="codex")
    ctx = adapter.recall("user preference")
"""

from __future__ import annotations

import json
import logging
import shlex
import subprocess
from typing import Any, Dict, List, Optional

from bridge_adapter.base import TdaiAdapter

logger = logging.getLogger("tdai_adapter_sdk")

_MCP_CALL_TIMEOUT = 30  # seconds


class CodexAdapter(TdaiAdapter):
    """TdaiAdapter for OpenAI Codex built-in memories via MCP stdio.

    Maps TdaiAdapter methods to Codex MCP tools:

        recall / search_memory  鈫?memories__search
        capture                 鈫?memories__add_ad_hoc_note
        search_conversation     鈫?memories__list
    """

    def __init__(self):
        super().__init__()
        self._codex_path: str = "codex"
        self._available: bool = False

    @property
    def name(self) -> str:
        return "codex"

    def initialize(self, **kwargs) -> None:
        self._codex_path = kwargs.get("codex_path", "codex")
        self._available = self._check_codex_available()

    def is_available(self) -> bool:
        return self._available

    # 鈹€鈹€ MCP call helper 鈹€鈹€

    def _mcp_call(self, tool: str, args: Dict[str, Any]) -> Optional[str]:
        """Call a Codex MCP tool via `codex mcp call` CLI."""
        cmd = [self._codex_path, "mcp", "call", tool]
        for key, value in args.items():
            if value is not None:
                cmd.append(f"--{key.replace('_', '-')}")
                cmd.append(str(value))
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=_MCP_CALL_TIMEOUT,
            )
            if result.returncode != 0:
                logger.warning(f"Codex MCP call failed ({tool}): {result.stderr[:200]}")
                return None
            return result.stdout.strip()
        except FileNotFoundError:
            logger.warning(f"Codex CLI not found at '{self._codex_path}'")
            self._available = False
            return None
        except subprocess.TimeoutExpired:
            logger.warning(f"Codex MCP call timed out ({tool})")
            return None
        except Exception as e:
            logger.warning(f"Codex MCP call error ({tool}): {e}")
            return None

    def _check_codex_available(self) -> bool:
        """Check if Codex CLI is installed and responds."""
        try:
            result = subprocess.run(
                [self._codex_path, "--version"],
                capture_output=True, text=True, timeout=10,
            )
            return result.returncode == 0
        except Exception:
            return False

    # 鈹€鈹€ Internal implementations 鈹€鈹€

    def _recall_impl(self, query: str, limit: int) -> Dict[str, Any]:
        """Recall via memories__search."""
        output = self._mcp_call("memories__search", {
            "queries": query,
            "max_results": limit,
        })
        if output is None:
            return {"prepend_context": "", "append_system_context": ""}
        return {
            "prepend_context": output,
            "append_system_context": "",
        }

    def _capture_impl(self, user_content: str, assistant_content: str, session_id: str) -> bool:
        """Capture via memories__add_ad_hoc_note.

        Stores the conversation turn as a named memory note.
        """
        note = json.dumps({
            "user": user_content,
            "assistant": assistant_content,
            "session": session_id or "default",
        }, ensure_ascii=False)
        filename = f"turn_{session_id or 'default'}.json"
        output = self._mcp_call("memories__add_ad_hoc_note", {
            "filename": filename,
            "note": note,
        })
        return output is not None

    def _search_memory_impl(self, query: str, limit: int) -> List[Dict[str, Any]]:
        """Search memory via memories__search."""
        output = self._mcp_call("memories__search", {
            "queries": query,
            "max_results": limit,
        })
        if output is None:
            return []
        # Parse the search results into structured entries
        try:
            # Codex returns JSON lines; parse what we can
            entries = []
            for line in output.split("\n"):
                line = line.strip()
                if line:
                    entries.append({"content": line, "source": "codex"})
            return entries[:limit]
        except Exception:
            return [{"content": output[:500], "source": "codex"}]

    def _search_conversation_impl(self, query: str, limit: int) -> List[Dict[str, Any]]:
        """Search conversation via memories__list + content filter."""
        output = self._mcp_call("memories__list", {
            "path": "turns",
            "max_results": limit,
        })
        if output is None:
            return []
        try:
            entries = []
            for line in output.split("\n"):
                line = line.strip()
                if line and query.lower() in line.lower():
                    entries.append({"content": line, "source": "codex"})
            return entries[:limit]
        except Exception:
            return [{"content": output[:500], "source": "codex"}] if output else []

    def shutdown(self) -> None:
        self._available = False
