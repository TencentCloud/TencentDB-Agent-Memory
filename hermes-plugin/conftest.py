"""Pytest bootstrap for standalone Hermes plugin tests.

The provider subclasses Hermes' ``agent.memory_provider.MemoryProvider``.
When these tests run from this repository without a sibling hermes-agent
checkout, pytest imports the package before test-level skip logic can run.
Install a tiny compatible stub in that narrow case so collection succeeds.
"""

from __future__ import annotations

import sys
import types


try:
    from agent.memory_provider import MemoryProvider as _MemoryProvider  # noqa: F401
except ModuleNotFoundError as exc:
    if exc.name not in {"agent", "agent.memory_provider"}:
        raise

    agent_module = sys.modules.setdefault("agent", types.ModuleType("agent"))
    memory_provider_module = types.ModuleType("agent.memory_provider")

    class MemoryProvider:
        """Minimal test-only stand-in for Hermes' provider base class."""

    memory_provider_module.MemoryProvider = MemoryProvider
    agent_module.memory_provider = memory_provider_module
    sys.modules["agent.memory_provider"] = memory_provider_module
