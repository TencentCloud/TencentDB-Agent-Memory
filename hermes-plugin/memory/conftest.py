"""Import bootstrap for the memory_tencentdb pytest suite.

The plugin is developed in this monorepo under ``hermes-plugin/`` but is
*installed* into a hermes-agent checkout as
``plugins/memory/memory_tencentdb`` (see the plugin's README.md, Install B).
The test modules import the provider through that installed name
(``plugins.memory.memory_tencentdb``) and the provider module imports
``agent.memory_provider`` (hermes-agent core) at module level — both must be
importable before pytest collects the first test module.

This conftest therefore lives at ``hermes-plugin/memory/`` — one level ABOVE
the ``memory_tencentdb`` package — because a conftest inside ``tests/`` is
itself imported as ``memory_tencentdb.tests.conftest``, which would trigger
the failing package import before the bootstrap could run.

It bridges the two requirements so the suite runs with a plain::

    python -m pytest hermes-plugin/memory/memory_tencentdb/tests/ -q

1. ``plugins`` alias — a lightweight package module whose ``__path__`` points
   at this repo's ``hermes-plugin/`` directory, pre-registered in
   ``sys.modules`` so ``plugins.memory.memory_tencentdb`` always resolves to
   THIS checkout (never to a copy installed inside a hermes-agent tree).
2. ``agent`` package — a real hermes-agent checkout wins when one can be
   located (``HERMES_AGENT_ROOT``, or the canonical sibling layouts); the
   location is also exported as ``HERMES_AGENT_ROOT`` because
   ``test_gateway_shutdown_leak`` requires the variable to be set. When no
   checkout exists, the minimal stub tree under
   ``memory_tencentdb/tests/hermes_agent_stub/`` is used instead — the
   provider only subclasses the base class, so behaviour under test is
   identical.
"""

from __future__ import annotations

import os
import pathlib
import sys
import types

_THIS_FILE = pathlib.Path(__file__).resolve()
# hermes-plugin/memory/conftest.py → parent = hermes-plugin/memory/
_MEMORY_DIR = _THIS_FILE.parent
# parents[1] = hermes-plugin/, parents[2] = repo root (TencentDB-Agent-Memory)
_HERMES_PLUGIN_DIR = _THIS_FILE.parents[1]
_REPO_ROOT = _THIS_FILE.parents[2]
_TESTS_DIR = _MEMORY_DIR / "memory_tencentdb" / "tests"
_HERMES_AGENT_STUB_ROOT = _TESTS_DIR / "hermes_agent_stub"


def _install_plugins_alias() -> None:
    """Make ``plugins.memory.memory_tencentdb`` resolve to this repo."""
    if "plugins" in sys.modules:
        return
    alias = types.ModuleType("plugins")
    alias.__path__ = [str(_HERMES_PLUGIN_DIR)]
    alias.__doc__ = "Alias package → <repo>/hermes-plugin/ (see conftest docstring)."
    sys.modules["plugins"] = alias


def _locate_hermes_agent():
    """Return a real hermes-agent checkout root, or None when none exists."""
    candidates = []
    env_root = os.environ.get("HERMES_AGENT_ROOT")
    if env_root:
        candidates.append(pathlib.Path(env_root))
    # Canonical sibling layouts used by the existing test modules.
    candidates.append(_REPO_ROOT.parent / "hermes-agent")
    candidates.append(pathlib.Path.home() / "hermes-agent")
    for candidate in candidates:
        if (candidate / "agent" / "memory_provider.py").is_file():
            return candidate
    return None


def _install_agent_package() -> None:
    """Put an ``agent`` package on sys.path (real checkout, else stub)."""
    if "agent" in sys.modules:
        return
    root = _locate_hermes_agent() or _HERMES_AGENT_STUB_ROOT
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    # test_gateway_shutdown_leak refuses to run without this variable set.
    os.environ.setdefault("HERMES_AGENT_ROOT", str(root))


_install_plugins_alias()
_install_agent_package()
