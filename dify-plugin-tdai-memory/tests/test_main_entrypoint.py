from __future__ import annotations

import importlib
import os
import sys
import types
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
PLUGIN_ROOT_TEXT = str(PLUGIN_ROOT)
if PLUGIN_ROOT_TEXT not in sys.path:
    sys.path.insert(0, PLUGIN_ROOT_TEXT)


class _StubDifyPluginEnv:
    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs


class _StubPlugin:
    def __init__(self, env: _StubDifyPluginEnv) -> None:
        self.env = env

    def run(self) -> None:
        return None


def _install_dify_entrypoint_stubs() -> None:
    dify_plugin = sys.modules.get("dify_plugin") or types.ModuleType("dify_plugin")
    if not hasattr(dify_plugin, "DifyPluginEnv"):
        dify_plugin.DifyPluginEnv = _StubDifyPluginEnv
    if not hasattr(dify_plugin, "Plugin"):
        dify_plugin.Plugin = _StubPlugin
    sys.modules["dify_plugin"] = dify_plugin


class MainEntrypointTest(unittest.TestCase):
    def tearDown(self) -> None:
        sys.modules.pop("main", None)
        sys.modules.pop("dify_plugin", None)

    @patch.dict(os.environ, {}, clear=True)
    def test_main_module_imports_plugin(self) -> None:
        _install_dify_entrypoint_stubs()

        module = importlib.import_module("main")

        self.assertIsNotNone(module.plugin)
        self.assertEqual(module.plugin.env.kwargs["MAX_REQUEST_TIMEOUT"], 120)

    @patch.dict(os.environ, {"MAX_REQUEST_TIMEOUT": "240"}, clear=False)
    def test_main_module_respects_timeout_env_override(self) -> None:
        _install_dify_entrypoint_stubs()
        module = importlib.import_module("main")
        module = importlib.reload(module)
        self.assertEqual(module.plugin.env.kwargs["MAX_REQUEST_TIMEOUT"], 240)

    @patch.dict(os.environ, {"MAX_REQUEST_TIMEOUT": "0"}, clear=False)
    def test_main_module_falls_back_on_non_positive_timeout(self) -> None:
        _install_dify_entrypoint_stubs()
        module = importlib.import_module("main")
        module = importlib.reload(module)
        self.assertEqual(module.plugin.env.kwargs["MAX_REQUEST_TIMEOUT"], 120)

    @patch.dict(os.environ, {"MAX_REQUEST_TIMEOUT": "invalid"}, clear=False)
    def test_main_module_falls_back_on_invalid_timeout(self) -> None:
        _install_dify_entrypoint_stubs()
        module = importlib.import_module("main")
        module = importlib.reload(module)
        self.assertEqual(module.plugin.env.kwargs["MAX_REQUEST_TIMEOUT"], 120)
