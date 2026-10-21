"""Minimal hermes-agent stub used when no real checkout is available.

The memory_tencentdb provider imports ``agent.memory_provider.MemoryProvider``
at module level. On machines without a hermes-agent checkout (the canonical
sibling layout is ``<repo>/../hermes-agent``), this stub keeps the test suite
importable. The provider only uses the base class for subclassing — every
method is overridden and no ``super()`` calls are made — so behaviour under
test is identical with the real base class.

This directory is NOT packaged with the plugin; it exists purely for pytest.
Point ``HERMES_AGENT_ROOT`` at a real hermes-agent checkout to run the suite
against the genuine base class instead.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional


class MemoryProvider:
    """Stand-in for hermes-agent's abstract ``MemoryProvider`` base class."""

    name = "stub"

    def is_available(self) -> bool:
        return False

    def initialize(self, session_id: str, **kwargs) -> None:
        pass

    def system_prompt_block(self) -> str:
        return ""

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        return ""

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        pass

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
        **kwargs,
    ) -> None:
        pass

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return []

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        return ""

    def shutdown(self) -> None:
        pass

    def on_turn_start(self, turn_number: int, message: str, **kwargs) -> None:
        pass

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        pass

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return []

    def on_memory_write(
        self, action: str, target: str, content: str, metadata: Optional[Dict[str, Any]] = None
    ) -> None:
        pass
