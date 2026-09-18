"""Regression tests for #823 — the Hermes adapter must read the correct
response fields: AtomicSearchData.items for memory search and
ConversationSearchData.messages for conversation search.

Run: python3 -m unittest tests.test_search_field
"""

import os
import sys
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

_agent = types.ModuleType("agent")
_mp = types.ModuleType("agent.memory_provider")


class _MemoryProvider:  # noqa: N801
    def __init__(self, *args, **kwargs):
        pass


_mp.MemoryProvider = _MemoryProvider
sys.modules.setdefault("agent", _agent)
sys.modules.setdefault("agent.memory_provider", _mp)

from memory.memory_tencentdb import MemoryTencentdbProvider  # noqa: E402


class SearchFieldTest(unittest.TestCase):
    def _provider(self):
        p = MemoryTencentdbProvider()
        p._client = mock.MagicMock()
        return p, p._client

    def _call(self, p, tool_name, args):
        with mock.patch.object(p, "_ensure_alive_for_request", return_value=True), \
             mock.patch.object(p, "_is_breaker_open", return_value=False):
            return p.handle_tool_call(tool_name, args)

    def test_conversation_search_reads_messages_field(self):
        p, client = self._provider()
        # Per ConversationSearchData: { data: { messages: [...] } }.
        client.conversation_search.return_value = {
            "code": 0,
            "message": "ok",
            "data": {
                "messages": [
                    {"role": "user", "content": "hello"},
                    {"role": "assistant", "content": "hi there"},
                ]
            },
        }

        result = self._call(p, "memory_tencentdb_conversation_search", {"query": "hello"})

        self.assertIn("[user] hello", result)
        self.assertIn("[assistant] hi there", result)
        self.assertNotIn("No conversations found", result)

    def test_memory_search_reads_items_field(self):
        p, client = self._provider()
        # Per AtomicSearchData: { data: { items: [...] } }.
        client.atomic_search.return_value = {
            "code": 0,
            "message": "ok",
            "data": {"items": [{"type": "episodic", "content": "remembered fact"}]},
        }

        result = self._call(p, "memory_tencentdb_memory_search", {"query": "fact"})

        self.assertIn("remembered fact", result)
        self.assertNotIn("No memories found", result)


if __name__ == "__main__":
    unittest.main()
