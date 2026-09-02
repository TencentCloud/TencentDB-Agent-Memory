"""Regression tests for Hermes capture/session-end ordering."""

from __future__ import annotations

import pathlib
import sys
import threading
import time
import types
import unittest
from unittest.mock import patch

_PLUGIN_ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_PLUGIN_ROOT))

# The provider only needs the MemoryProvider base type for these unit tests.
if "agent.memory_provider" not in sys.modules:
    agent_module = types.ModuleType("agent")
    memory_provider_module = types.ModuleType("agent.memory_provider")
    memory_provider_module.MemoryProvider = type("MemoryProvider", (), {})
    agent_module.memory_provider = memory_provider_module
    sys.modules["agent"] = agent_module
    sys.modules["agent.memory_provider"] = memory_provider_module

import memory.memory_tencentdb as provider_module
from memory.memory_tencentdb import MemoryTencentdbProvider


class BlockingClient:
    def __init__(self) -> None:
        self.capture_started = threading.Event()
        self.capture_release = threading.Event()
        self.end_called = threading.Event()
        self.order: list[str] = []

    def capture(self, **_kwargs) -> dict:
        self.capture_started.set()
        self.capture_release.wait(timeout=2)
        self.order.append("capture")
        return {}

    def end_session(self, **_kwargs) -> dict:
        self.order.append("end")
        self.end_called.set()
        return {"flushed": True}


def provider_with(client: BlockingClient) -> MemoryTencentdbProvider:
    provider = MemoryTencentdbProvider()
    provider._client = client
    provider._gateway_available = True
    provider._session_id = "session-1"
    provider._user_id = "user-1"
    return provider


class SessionEndOrderingTest(unittest.TestCase):
    def test_session_end_waits_for_inflight_capture(self) -> None:
        client = BlockingClient()
        provider = provider_with(client)
        provider.sync_turn("user", "assistant")
        self.assertTrue(client.capture_started.wait(timeout=1))

        finished = threading.Event()
        end_thread = threading.Thread(
            target=lambda: (provider.on_session_end([]), finished.set()),
        )
        end_thread.start()
        self.assertFalse(client.end_called.wait(timeout=0.05))

        client.capture_release.set()
        self.assertTrue(finished.wait(timeout=1))
        end_thread.join(timeout=1)
        self.assertEqual(client.order, ["capture", "end"])
        self.assertEqual(provider._active_syncs, [])

    def test_timeout_defers_flush_without_reversing_order(self) -> None:
        client = BlockingClient()
        provider = provider_with(client)
        provider.sync_turn("user", "assistant")
        self.assertTrue(client.capture_started.wait(timeout=1))

        started = time.monotonic()
        with patch.object(provider_module, "_SESSION_END_JOIN_TIMEOUT_SECS", 0.01):
            provider.on_session_end([])
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertFalse(client.end_called.is_set())

        client.capture_release.set()
        self.assertTrue(client.end_called.wait(timeout=1))
        self.assertEqual(client.order, ["capture", "end"])

    def test_session_end_flushes_immediately_without_pending_capture(self) -> None:
        client = BlockingClient()
        provider = provider_with(client)
        provider.on_session_end([])
        self.assertEqual(client.order, ["end"])

    def test_sync_thread_starts_while_registration_lock_is_held(self) -> None:
        client = BlockingClient()
        client.capture_release.set()
        provider = provider_with(client)
        lock_states: list[bool] = []

        class InlineThread:
            def __init__(self, *, target, **_kwargs) -> None:
                self._target = target
                self._alive = False

            def is_alive(self) -> bool:
                return self._alive

            def start(self) -> None:
                lock_states.append(provider._sync_lock.locked())
                self._alive = True
                self._target()
                self._alive = False

        with patch.object(provider_module.threading, "Thread", InlineThread):
            provider.sync_turn("user", "assistant")

        self.assertEqual(lock_states, [True])
        self.assertEqual(client.order, ["capture"])


if __name__ == "__main__":
    unittest.main()
