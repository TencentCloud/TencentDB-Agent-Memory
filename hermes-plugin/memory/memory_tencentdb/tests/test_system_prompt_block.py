from __future__ import annotations

import pathlib
import sys
import types
import unittest
from unittest.mock import MagicMock


_THIS_FILE = pathlib.Path(__file__).resolve()
_HERMES_PLUGIN_ROOT = _THIS_FILE.parents[3]
if str(_HERMES_PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(_HERMES_PLUGIN_ROOT))

if "agent.memory_provider" not in sys.modules:
    agent_module = types.ModuleType("agent")
    memory_provider_module = types.ModuleType("agent.memory_provider")

    class MemoryProvider:  # Minimal test stub for the Hermes interface.
        pass

    memory_provider_module.MemoryProvider = MemoryProvider
    agent_module.memory_provider = memory_provider_module
    sys.modules.setdefault("agent", agent_module)
    sys.modules["agent.memory_provider"] = memory_provider_module

from memory.memory_tencentdb import MemoryTencentdbProvider


class SystemPromptBlockTest(unittest.TestCase):
    def test_system_prompt_block_includes_recalled_persona_context(self) -> None:
        provider = MemoryTencentdbProvider()
        provider._gateway_available = True
        provider._session_id = "session-1"
        provider._user_id = "user-1"
        provider._client = MagicMock()
        provider._client.recall.return_value = {
            "context": "<user-persona>\nPrefers concise answers.\n</user-persona>",
        }

        block = provider.system_prompt_block()

        self.assertIn("Prefers concise answers.", block)
        provider._client.recall.assert_called_once()
        call_kwargs = provider._client.recall.call_args.kwargs
        self.assertEqual(call_kwargs["session_key"], "session-1")
        self.assertEqual(call_kwargs["user_id"], "user-1")
        self.assertTrue(call_kwargs["query"])


if __name__ == "__main__":
    unittest.main()
