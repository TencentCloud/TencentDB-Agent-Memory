"""Regression tests for Hermes provider startup observability."""

from __future__ import annotations

import os
import pathlib
import sys
import types
import unittest
from unittest import mock

_HERMES_PLUGIN_ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_HERMES_PLUGIN_ROOT))

if "agent.memory_provider" not in sys.modules:
    agent_module = types.ModuleType("agent")
    memory_provider_module = types.ModuleType("agent.memory_provider")

    class MemoryProvider:
        pass

    memory_provider_module.MemoryProvider = MemoryProvider
    sys.modules.setdefault("agent", agent_module)
    sys.modules["agent.memory_provider"] = memory_provider_module

from memory import memory_tencentdb as provider_module


class StartupObservabilityTest(unittest.TestCase):
    def test_startup_observability(self):
        for gateway_cmd, policy in (("start-gateway", "managed"), ("", "external")):
            with self.subTest(policy=policy):
                supervisor = mock.Mock()
                supervisor.is_running.return_value = True
                supervisor.client = mock.sentinel.client
                env = {
                    "MEMORY_TENCENTDB_GATEWAY_CMD": gateway_cmd,
                    "MEMORY_TENCENTDB_GATEWAY_API_KEY": "super-secret",
                }
                with mock.patch.dict(os.environ, env), \
                        mock.patch.object(
                            provider_module, "_discover_gateway_cmd", return_value=None
                        ), \
                        mock.patch.object(
                            provider_module, "GatewaySupervisor"
                        ) as supervisor_class, \
                        mock.patch.object(
                            provider_module.MemoryTencentdbProvider,
                            "_start_watchdog",
                        ), \
                        self.assertLogs(
                            provider_module.logger.name, level="INFO"
                        ) as logs:
                    supervisor_class.side_effect = lambda **kwargs: (
                        self.assertTrue(any(
                            "TDBMEM001" in record.getMessage()
                            for record in logs.records
                        )) or supervisor
                    )
                    provider = provider_module.MemoryTencentdbProvider()
                    provider.initialize(
                        session_id="private-session",
                        team_id="private-team",
                        agent_id="private-agent",
                        user_id="private-user",
                        memory_enabled=False,
                    )

                text = "\n".join(logs.output)
                for expected in (
                    "TDBMEM001 memory-tencentdb selected by Hermes",
                    "memory.provider=memory_tencentdb",
                    "state=initializing",
                    f"gateway_policy={policy}",
                    "memory_enabled/user_profile_enabled",
                    "not lifecycle switches",
                    "unset or change memory.provider",
                ):
                    self.assertIn(expected, text)
                for secret_or_false_state in (
                    "private-session", "private-team", "private-agent",
                    "private-user", "super-secret", "state=ready",
                    "state=active", "state=healthy",
                ):
                    self.assertNotIn(secret_or_false_state, text)
                supervisor_class.assert_called_once()


if __name__ == "__main__":
    unittest.main()
