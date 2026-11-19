"""Agent id resolution for the memory-tencentdb Hermes provider (#1545).

Run from ``MemoryCore/hermes-plugin``::

    python -m unittest discover -s __tests__ -v

Hermes is not required: if ``agent.memory_provider`` is not importable, a
minimal stub is installed before the provider package is imported.
"""

from __future__ import annotations

import os
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

try:
    import agent.memory_provider  # noqa: F401  (real Hermes, if available)
except ImportError:
    _agent = types.ModuleType("agent")
    _agent.__path__ = []
    _provider = types.ModuleType("agent.memory_provider")
    _provider.MemoryProvider = type("MemoryProvider", (), {})
    _agent.memory_provider = _provider
    sys.modules.update({"agent": _agent, "agent.memory_provider": _provider})

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "memory"))

import memory_tencentdb as provider_pkg  # noqa: E402

ENV = "MEMORY_TENCENTDB_AGENT_ID"


class AgentIdTest(unittest.TestCase):
    def setUp(self):
        self.supervisor = mock.MagicMock(name="GatewaySupervisor")
        self.supervisor.return_value.is_running.return_value = True
        cls = provider_pkg.MemoryTencentdbProvider
        for p in (
            mock.patch.object(provider_pkg, "GatewaySupervisor", self.supervisor),
            mock.patch.object(provider_pkg, "_discover_gateway_cmd", return_value=None),
            mock.patch.object(cls, "_start_watchdog"),
            mock.patch.dict(os.environ),
        ):
            p.start()
            self.addCleanup(p.stop)
        os.environ.pop(ENV, None)
        self.provider = cls()

    def init_like_hermes(self, profile, **extra):
        # Hermes sends the profile name as agent_identity and never agent_id.
        self.provider.initialize(
            "s", hermes_home="/tmp/h", platform="cli", agent_identity=profile, **extra
        )
        return self.provider._agent_id

    def test_profile_mapped_via_env(self):
        os.environ[ENV] = " agt-abc123 "
        self.assertEqual(self.init_like_hermes("coder"), "agt-abc123")

    def test_profile_name_is_never_the_agent_id(self):
        with self.assertLogs(provider_pkg.logger, "WARNING") as logs:
            self.assertEqual(self.init_like_hermes("coder"), "default")
        self.assertIn("'coder'", logs.output[0])
        self.assertIn(ENV, logs.output[0])

    def test_default_profile_does_not_warn(self):
        with mock.patch.object(provider_pkg.logger, "warning") as warn:
            self.assertEqual(self.init_like_hermes("default"), "default")
        warn.assert_not_called()

    def test_explicit_agent_id_wins_over_env(self):
        os.environ[ENV] = "agt-env"
        self.assertEqual(self.init_like_hermes("coder", agent_id="agt-x"), "agt-x")

    def test_blank_or_non_str_agent_id_falls_back(self):
        os.environ[ENV] = "agt-env"
        self.assertEqual(provider_pkg._resolve_agent_id("  "), "agt-env")
        self.assertEqual(provider_pkg._resolve_agent_id(123), "agt-env")
        os.environ[ENV] = "  "
        self.assertEqual(provider_pkg._resolve_agent_id(None), "default")

    def test_setup_schema_writes_env_var(self):
        fields = {f["key"]: f for f in self.provider.get_config_schema()}
        self.assertEqual(fields["agent_id"]["env_var"], ENV)
        self.assertFalse(fields["agent_id"].get("secret", False))


if __name__ == "__main__":
    unittest.main()
