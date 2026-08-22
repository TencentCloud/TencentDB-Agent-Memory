from __future__ import annotations

import importlib
import os
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


PLUGIN_ROOT = Path(__file__).resolve().parents[1] / "memory"


def _load_provider_module() -> types.ModuleType:
    agent_package = types.ModuleType("agent")
    memory_provider = types.ModuleType("agent.memory_provider")

    class MemoryProvider:
        pass

    memory_provider.MemoryProvider = MemoryProvider
    agent_package.memory_provider = memory_provider
    sys.modules.setdefault("agent", agent_package)
    sys.modules.setdefault("agent.memory_provider", memory_provider)
    sys.path.insert(0, str(PLUGIN_ROOT))
    try:
        return importlib.import_module("memory_tencentdb")
    finally:
        sys.path.remove(str(PLUGIN_ROOT))


provider_module = _load_provider_module()


class TenancyEnvironmentResolutionTest(unittest.TestCase):
    def test_explicit_value_precedes_environment(self) -> None:
        with patch.dict(
            os.environ,
            {"MEMORY_TENCENTDB_TEAM_ID": "team-from-environment"},
            clear=False,
        ):
            resolved = provider_module._resolve_tenancy_id(
                "team-from-hermes",
                env_var="MEMORY_TENCENTDB_TEAM_ID",
                default="default",
            )

        self.assertEqual(resolved, "team-from-hermes")

    def test_environment_value_is_used_when_hermes_omits_scope(self) -> None:
        with patch.dict(
            os.environ,
            {"MEMORY_TENCENTDB_AGENT_ID": "  agent-from-environment  "},
            clear=False,
        ):
            resolved = provider_module._resolve_tenancy_id(
                None,
                env_var="MEMORY_TENCENTDB_AGENT_ID",
                default="default",
            )

        self.assertEqual(resolved, "agent-from-environment")

    def test_default_is_retained_when_both_sources_are_empty(self) -> None:
        with patch.dict(
            os.environ,
            {
                "MEMORY_TENCENTDB_TEAM_ID": "   ",
                "MEMORY_TENCENTDB_AGENT_ID": "",
            },
            clear=False,
        ):
            self.assertEqual(
                provider_module._resolve_tenancy_id(
                    None,
                    env_var="MEMORY_TENCENTDB_TEAM_ID",
                    default="default",
                ),
                "default",
            )
            self.assertEqual(
                provider_module._resolve_tenancy_id(
                    "",
                    env_var="MEMORY_TENCENTDB_AGENT_ID",
                    default="default",
                ),
                "default",
            )

    def test_user_key_is_trimmed_from_principal_environment(self) -> None:
        with patch.dict(
            os.environ,
            {"MEMORY_TENCENTDB_USER_KEY": "  sk-mem-principal  "},
            clear=False,
        ):
            self.assertEqual(
                provider_module._resolve_user_key(),
                "sk-mem-principal",
            )

    def test_user_key_authenticates_gateway_requests(self) -> None:
        client = provider_module.MemoryTencentdbSdkClient(
            base_url="http://memory.example",
            user_key="sk-mem-principal",
        )

        headers = client._build_headers(content_type=True)

        self.assertEqual(headers["Authorization"], "Bearer sk-mem-principal")
        self.assertEqual(headers["x-tdai-user-key"], "sk-mem-principal")
        self.assertEqual(headers["x-tdai-service-id"], "default")

    def test_service_key_compatibility_is_retained(self) -> None:
        client = provider_module.MemoryTencentdbSdkClient(
            base_url="http://memory.example",
            api_key="gateway-service-key",
            user_key="sk-mem-principal",
        )

        headers = client._build_headers(content_type=False)

        self.assertEqual(headers["Authorization"], "Bearer gateway-service-key")
        self.assertEqual(headers["x-tdai-user-key"], "sk-mem-principal")


if __name__ == "__main__":
    unittest.main()
