"""Tests for memory-tencentdb tool-schema routing.

Regression test for the "search tools silently unroutable" failure class:

``MemoryManager.add_provider()`` indexes ``get_tool_schemas()`` into the
tool routing table BEFORE ``initialize()`` runs. Older builds returned
``[]`` from ``get_tool_schemas()`` until the Gateway was reachable or
Gateway env vars were set, so the routing table stayed empty forever and
every tool call failed with "Unknown tool" — even though initialize()
later succeeded.

The provider must therefore always advertise both static schemas; Gateway
health is enforced at call time, not by hiding the tools.

These tests construct the provider without initialize() and without any
Gateway env, so they neither spawn Node processes nor open sockets.
"""

from __future__ import annotations

import os
import pathlib
import sys
from unittest.mock import MagicMock

import pytest

# Inject plugin + hermes-agent roots into sys.path so the provider module
# can be imported regardless of whether tests are invoked from the plugin
# tree (hermes-plugin/memory/memory_tencentdb/tests/) or from a hermes-agent
# checkout. Mirrors the layout used by ``test_memory_tencentdb_recovery.py``
# next door.
_THIS_FILE = pathlib.Path(__file__).resolve()
_HERE = _THIS_FILE.parent
for candidate in (
    _HERE.parents[3] if len(_HERE.parents) >= 4 else None,    # plugin repo: hermes-plugin/
    _HERE.parents[4] if len(_HERE.parents) >= 5 else None,    # hermes-agent root
    _HERE.parents[2] if len(_HERE.parents) >= 3 else None,    # fallback
):
    if candidate is not None and (candidate / "plugins").is_dir():
        if str(candidate) not in sys.path:
            sys.path.insert(0, str(candidate))

# Optional: hermes-agent provides ``agent.memory_provider``. Tests can set
# HERMES_AGENT_ROOT to point at a sibling checkout if needed.
_hermes_root = os.environ.get("HERMES_AGENT_ROOT")
if not _hermes_root:
    sibling = _HERE.parents[4] / "hermes-agent" if len(_HERE.parents) >= 5 else None
    if sibling is not None and (sibling / "agent").is_dir():
        _hermes_root = str(sibling)
if _hermes_root and _hermes_root not in sys.path:
    sys.path.insert(0, _hermes_root)

try:
    from plugins.memory.memory_tencentdb import (
        CONVERSATION_SEARCH_SCHEMA,
        MEMORY_SEARCH_SCHEMA,
        MemoryTencentdbProvider,
    )
except ImportError as e:  # pragma: no cover — env-dependent
    pytest.skip(
        f"memory_tencentdb provider not importable ({e}); set HERMES_AGENT_ROOT "
        "to a hermes-agent checkout if running from the plugin repo.",
        allow_module_level=True,
    )


@pytest.fixture()
def no_gateway_env(monkeypatch):
    """Ensure no Gateway reachability hints leak in from the environment."""
    monkeypatch.delenv("MEMORY_TENCENTDB_GATEWAY_CMD", raising=False)
    monkeypatch.delenv("MEMORY_TENCENTDB_GATEWAY_PORT", raising=False)
    yield


class TestToolSchemaRouting:
    def test_schemas_advertised_before_initialize(self, no_gateway_env):
        """Fresh (uninitialized) provider must advertise both tools.

        MemoryManager indexes get_tool_schemas() before initialize(); an
        empty result here leaves the tools unroutable forever.
        """
        provider = MemoryTencentdbProvider()
        assert provider._initialized is False
        assert provider._gateway_available is False

        schemas = provider.get_tool_schemas()
        names = [s.get("name") for s in schemas]
        assert names == [
            "memory_tencentdb_memory_search",
            "memory_tencentdb_conversation_search",
        ]

    def test_schemas_are_the_static_canonical_objects(self, no_gateway_env):
        provider = MemoryTencentdbProvider()
        assert provider.get_tool_schemas() == [
            MEMORY_SEARCH_SCHEMA,
            CONVERSATION_SEARCH_SCHEMA,
        ]

    def test_advertised_names_are_dispatchable(self, no_gateway_env):
        """Every advertised name must be accepted by handle_tool_call's
        dispatch (i.e. not fall through to 'Unknown tool'). We only check
        the routing decision, not execution: the client is replaced with a
        stub so no Gateway call happens."""
        provider = MemoryTencentdbProvider()
        provider._gateway_available = True
        provider._initialized = True
        # Skip the lazy Gateway probe — no real Gateway is running.
        provider._ensure_alive_for_request = lambda: None

        class _StubClient:
            def search_memories(self, **kwargs):
                return {"memories": []}

            def search_conversations(self, **kwargs):
                return {"conversations": []}

        provider._client = _StubClient()

        for name in ("memory_tencentdb_memory_search",
                     "memory_tencentdb_conversation_search"):
            result = provider.handle_tool_call(name, {"query": "q"})
            assert "Unknown tool" not in result

    def test_unknown_tool_still_rejected(self, no_gateway_env):
        provider = MemoryTencentdbProvider()
        provider._gateway_available = True
        provider._initialized = True
        provider._ensure_alive_for_request = lambda: None
        provider._client = MagicMock()
        result = provider.handle_tool_call("totally_unknown_tool", {"query": "q"})
        assert "Unknown tool" in result
