"""Tests for Hermes startup observability diagnostics."""

from __future__ import annotations

import logging
import pathlib
import sys
import types
import unittest

_THIS_FILE = pathlib.Path(__file__).resolve()
_HERE = _THIS_FILE.parent
for candidate in (
    _HERE.parents[2] if len(_HERE.parents) >= 3 else None,
    _HERE.parents[3] if len(_HERE.parents) >= 4 else None,
    _HERE.parents[4] if len(_HERE.parents) >= 5 else None,
):
    if candidate is not None and ((candidate / "plugins").is_dir() or (candidate / "memory").is_dir()):
        if str(candidate) not in sys.path:
            sys.path.insert(0, str(candidate))

if "agent.memory_provider" not in sys.modules:
    agent_module = types.ModuleType("agent")
    memory_provider_module = types.ModuleType("agent.memory_provider")

    class MemoryProvider:  # minimal Hermes test stub
        pass

    memory_provider_module.MemoryProvider = MemoryProvider
    sys.modules.setdefault("agent", agent_module)
    sys.modules["agent.memory_provider"] = memory_provider_module

try:
    try:
        import plugins.memory.memory_tencentdb as mod
    except ImportError:
        import memory.memory_tencentdb as mod
except ImportError as e:  # pragma: no cover - env-dependent
    raise unittest.SkipTest(
        f"memory_tencentdb provider not importable ({e}); set HERMES_AGENT_ROOT "
        "to a hermes-agent checkout if running from the plugin repo."
    )


class StartupObservabilityTest(unittest.TestCase):
    def test_startup_banner_explains_provider_reason(self):
        with self.assertLogs(mod.logger.name, level="INFO") as logs:
            mod._log_startup_observability(
                session_id="s1",
                user_id="u1",
                host="127.0.0.1",
                port=8420,
                gateway_cmd="node gateway",
                api_key=None,
                kwargs={},
            )

        text = "\n".join(logs.output)
        self.assertIn("memory.provider selected memory_tencentdb", text)
        self.assertIn("gateway=http://127.0.0.1:8420", text)
        self.assertIn("capture turns for L0-L3 memory", text)

    def test_startup_warns_when_hermes_prompt_flags_are_false(self):
        with self.assertLogs(mod.logger.name, level="WARNING") as logs:
            mod._log_startup_observability(
                session_id="s1",
                user_id="u1",
                host="127.0.0.1",
                port=8420,
                gateway_cmd=None,
                api_key="secret",
                kwargs={"memory": {"memory_enabled": False, "user_profile_enabled": "false"}},
            )

        text = "\n".join(logs.output)
        self.assertIn("memory_enabled and user_profile_enabled false", text)
        self.assertIn("do not disable this provider", text)


if __name__ == "__main__":
    unittest.main()
