"""Repo-only regression tests for Hermes stable system-context injection."""

from __future__ import annotations

import pathlib
import sys
import time
import types
import unittest
from unittest.mock import MagicMock


# The production plugin imports Hermes' base class at module import time. Keep
# this test runnable from a standalone repository checkout by installing the
# smallest structural stub before importing the provider package.
agent_module = types.ModuleType("agent")
memory_provider_module = types.ModuleType("agent.memory_provider")


class MemoryProvider:
    pass


memory_provider_module.MemoryProvider = MemoryProvider
agent_module.memory_provider = memory_provider_module
sys.modules.setdefault("agent", agent_module)
sys.modules.setdefault("agent.memory_provider", memory_provider_module)

repo_root = pathlib.Path(__file__).resolve().parents[2]
hermes_plugin_root = repo_root / "hermes-plugin"
sys.path.insert(0, str(hermes_plugin_root))

from memory.memory_tencentdb import (  # noqa: E402
    MemoryTencentdbProvider,
    _SYSTEM_CONTEXT_PROBE_QUERY,
)


def make_provider() -> MemoryTencentdbProvider:
    provider = MemoryTencentdbProvider()
    provider._gateway_available = True
    provider._client = MagicMock()
    provider._session_id = "session-205"
    provider._user_id = "user-205"
    provider._ensure_alive_for_request = MagicMock(return_value=True)
    provider._record_success = MagicMock()
    provider._record_failure = MagicMock()
    provider._try_recover_gateway = MagicMock()
    return provider


class SystemContextInjectionTest(unittest.TestCase):
    def test_injects_only_stable_context_with_non_empty_probe(self) -> None:
        provider = make_provider()
        provider._client.recall.return_value = {
            "system_context": "## L3 Persona\nPrefers concise technical answers.",
            "prepend_context": "DYNAMIC_L1_MUST_NOT_BE_IN_SYSTEM_PROMPT",
            "context": "BACKWARD_COMPATIBLE_COMBINED_CONTEXT",
        }

        block = provider.system_prompt_block()

        self.assertIn("Prefers concise technical answers", block)
        self.assertNotIn("DYNAMIC_L1", block)
        self.assertNotIn("BACKWARD_COMPATIBLE", block)
        provider._client.recall.assert_called_once_with(
            query=_SYSTEM_CONTEXT_PROBE_QUERY,
            session_key="session-205",
            user_id="user-205",
        )
        self.assertTrue(_SYSTEM_CONTEXT_PROBE_QUERY)

    def test_ttl_avoids_recalling_on_each_prompt_build(self) -> None:
        provider = make_provider()
        provider._client.recall.return_value = {"system_context": "stable persona"}

        self.assertIn("stable persona", provider.system_prompt_block())
        self.assertIn("stable persona", provider.system_prompt_block())

        provider._client.recall.assert_called_once()

    def test_prefetch_primes_system_context_cache(self) -> None:
        provider = make_provider()
        provider._client.recall.return_value = {
            "system_context": "persona from actual user query",
            "prepend_context": "dynamic memory for this turn",
            "context": "combined fallback",
        }

        recalled = provider.prefetch("What do I prefer?")
        block = provider.system_prompt_block()

        self.assertEqual(recalled, "## memory-tencentdb Memory\ndynamic memory for this turn")
        self.assertIn("persona from actual user query", block)
        provider._client.recall.assert_called_once_with(
            query="What do I prefer?",
            session_key="session-205",
            user_id="user-205",
        )

    def test_prefetch_for_another_session_does_not_prime_prompt_cache(self) -> None:
        provider = make_provider()
        provider._client.recall.side_effect = [
            {
                "system_context": "persona from another session",
                "prepend_context": "other session recall",
            },
            {"system_context": "persona for session-205"},
        ]

        provider.prefetch("foreign query", session_id="session-other")
        block = provider.system_prompt_block()

        self.assertNotIn("persona from another session", block)
        self.assertIn("persona for session-205", block)
        self.assertEqual(provider._client.recall.call_count, 2)
        self.assertEqual(
            provider._client.recall.call_args_list[1].kwargs["session_key"],
            "session-205",
        )

    def test_failure_keeps_last_known_system_context(self) -> None:
        provider = make_provider()
        provider._latest_system_context = "last known persona"
        provider._system_context_refreshed_at = time.monotonic() - 120.0
        provider._client.recall.side_effect = ConnectionError("Gateway unavailable")

        block = provider.system_prompt_block()

        self.assertIn("last known persona", block)
        provider._record_failure.assert_called_once()
        provider._try_recover_gateway.assert_called_once()
        self.assertLess(provider._system_context_refreshed_at, time.monotonic() - 60.0)

    def test_successful_empty_response_clears_stale_context(self) -> None:
        provider = make_provider()
        provider._latest_system_context = "stale persona"
        provider._client.recall.return_value = {"system_context": ""}

        block = provider.system_prompt_block()

        self.assertNotIn("stale persona", block)
        self.assertGreater(provider._system_context_refreshed_at, 0.0)

    def test_older_gateway_context_is_not_injected_as_system_context(self) -> None:
        provider = make_provider()
        provider._client.recall.return_value = {
            "context": "legacy response may contain dynamic L1",
        }

        block = provider.system_prompt_block()

        self.assertNotIn("legacy response may contain dynamic L1", block)
        provider._record_success.assert_called_once()


if __name__ == "__main__":
    unittest.main()
