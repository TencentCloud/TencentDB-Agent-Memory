"""Regression tests for #1380: the conversation_search tool read the response
shape of a different endpoint (data.items, the L1 atomic-search shape) while
the Gateway's /v3/conversation/search returns data.messages — so the tool
always answered "No conversations found" even when the Gateway had hits.

Run with the standard library only:
    python -m unittest discover -s tests -v
"""

import sys
import types
import unittest
from pathlib import Path

pkg_root = Path(__file__).resolve().parents[2]
agent_pkg = types.ModuleType("agent")
mp_mod = types.ModuleType("agent.memory_provider")


class MemoryProvider:
    pass


mp_mod.MemoryProvider = MemoryProvider
agent_pkg.memory_provider = mp_mod
sys.modules.setdefault("agent", agent_pkg)
sys.modules["agent.memory_provider"] = mp_mod
sys.path.insert(0, str(pkg_root))

from memory_tencentdb import GatewaySupervisor, MemoryTencentdbProvider  # noqa: E402


class _FakeSupervisor:
    def __init__(self, **kwargs):
        self.client = object()

    def is_running(self):
        return True

    def ensure_running(self):
        return True


class _FakeClient:
    """Captures calls; returns canned Gateway responses."""

    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def __getattr__(self, name):
        canned = self.responses[name]

        def _call(**kwargs):
            self.calls.append((name, kwargs))
            return canned

        return _call


class TestConversationSearchShape(unittest.TestCase):
    def setUp(self):
        import memory_tencentdb as mod

        self._mod = mod
        self._orig_supervisor = mod.GatewaySupervisor
        mod.GatewaySupervisor = _FakeSupervisor
        MemoryTencentdbProvider._start_watchdog = lambda self: None
        self.p = MemoryTencentdbProvider()
        self.p.initialize("session-1")

    def tearDown(self):
        self._mod.GatewaySupervisor = self._orig_supervisor

    def _install(self, data):
        self.p._client = _FakeClient({"conversation_search": {"code": 0, "data": data}})

    def test_gateway_shape_data_messages_is_read(self):
        # The actual Gateway /v3/conversation/search envelope: data.messages
        self._install({"messages": [
            {"id": "m1", "role": "user", "content": "部署问题排查记录", "timestamp": "2026-10-01T00:00:00Z", "score": 0.9},
        ]})
        out = self.p.handle_tool_call("memory_tencentdb_conversation_search", {"query": "部署"})
        self.assertIn("部署问题排查记录", out)
        self.assertNotIn("No conversations found", out)

    def test_legacy_shape_data_items_still_accepted(self):
        self._install({"items": [
            {"role": "user", "content": "旧形状数据", "timestamp": "x", "score": 0.5},
        ]})
        out = self.p.handle_tool_call("memory_tencentdb_conversation_search", {"query": "任意"})
        self.assertIn("旧形状数据", out)

    def test_empty_messages_reports_no_conversations(self):
        self._install({"messages": []})
        out = self.p.handle_tool_call("memory_tencentdb_conversation_search", {"query": "部署"})
        self.assertIn("No conversations found", out)


if __name__ == "__main__":
    unittest.main()
