"""Pytest import helpers for the standalone plugin checkout."""

from __future__ import annotations

import importlib
import importlib.util
import os
import pathlib
import sys
import types


_PROJECT_ROOT = pathlib.Path(__file__).resolve().parent
_HERMES_PLUGIN_ROOT = _PROJECT_ROOT / "hermes-plugin"
if str(_HERMES_PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(_HERMES_PLUGIN_ROOT))


def _add_real_hermes_agent_root() -> None:
    candidates = []
    env_root = os.environ.get("HERMES_AGENT_ROOT")
    if env_root:
        candidates.append(pathlib.Path(env_root))
    candidates.append(_PROJECT_ROOT.parent / "hermes-agent")

    for candidate in candidates:
        if (candidate / "agent").is_dir() and str(candidate) not in sys.path:
            sys.path.insert(0, str(candidate))


def _real_memory_provider_available() -> bool:
    if "agent.memory_provider" in sys.modules:
        return True
    _add_real_hermes_agent_root()
    try:
        spec = importlib.util.find_spec("agent.memory_provider")
    except ModuleNotFoundError:
        return False
    if spec is None:
        return False
    importlib.import_module("agent.memory_provider")
    return True


if not _real_memory_provider_available():
    agent_module = types.ModuleType("agent")
    memory_provider_module = types.ModuleType("agent.memory_provider")

    class MemoryProvider:
        pass

    memory_provider_module.MemoryProvider = MemoryProvider
    agent_module.memory_provider = memory_provider_module
    sys.modules.setdefault("agent", agent_module)
    sys.modules["agent.memory_provider"] = memory_provider_module
