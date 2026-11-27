"""Regression tests for v3 search envelope unwrapping (#1380)."""

from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path


def _ensure_hermes_stub() -> None:
    """Hermes host deps are not required to exercise envelope helpers."""
    if "agent.memory_provider" in sys.modules:
        return
    agent_mod = types.ModuleType("agent")
    mp_mod = types.ModuleType("agent.memory_provider")

    class MemoryProvider:  # pragma: no cover - import stub only
        pass

    mp_mod.MemoryProvider = MemoryProvider
    agent_mod.memory_provider = mp_mod
    sys.modules["agent"] = agent_mod
    sys.modules["agent.memory_provider"] = mp_mod


_ensure_hermes_stub()

_PLUGIN_ROOT = Path(__file__).resolve().parents[1]
if str(_PLUGIN_ROOT.parent) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_ROOT.parent))

from memory.memory_tencentdb import _unwrap_search_hits  # noqa: E402


class UnwrapSearchHitsTest(unittest.TestCase):
    def test_conversation_search_prefers_messages(self) -> None:
        result = {
            "code": 0,
            "data": {
                "messages": [
                    {"role": "user", "content": "MARKER", "score": 1.0},
                ],
            },
        }
        hits = _unwrap_search_hits(result, "messages", "items")
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["content"], "MARKER")

    def test_conversation_search_empty_messages_is_empty_not_fallback(self) -> None:
        # An empty messages list is a valid "no hits" result; do not invent hits.
        result = {
            "code": 0,
            "data": {
                "messages": [],
                "items": [{"role": "user", "content": "stale"}],
            },
        }
        self.assertEqual(_unwrap_search_hits(result, "messages", "items"), [])

    def test_conversation_search_falls_back_to_items_when_messages_missing(self) -> None:
        result = {
            "code": 0,
            "data": {
                "items": [{"role": "assistant", "content": "legacy"}],
            },
        }
        hits = _unwrap_search_hits(result, "messages", "items")
        self.assertEqual(hits[0]["content"], "legacy")

    def test_memory_search_reads_items(self) -> None:
        result = {
            "code": 0,
            "data": {"items": [{"type": "fact", "content": "likes tea"}]},
        }
        hits = _unwrap_search_hits(result, "items")
        self.assertEqual(hits[0]["type"], "fact")

    def test_malformed_envelope_returns_empty(self) -> None:
        self.assertEqual(_unwrap_search_hits(None, "messages", "items"), [])
        self.assertEqual(_unwrap_search_hits({"data": None}, "messages"), [])
        self.assertEqual(_unwrap_search_hits({"data": "oops"}, "messages"), [])


if __name__ == "__main__":
    unittest.main()
