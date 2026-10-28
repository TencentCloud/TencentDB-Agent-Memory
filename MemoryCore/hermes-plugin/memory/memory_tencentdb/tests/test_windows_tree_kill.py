"""Regression tests for #1381: on Windows, the plugin-managed Gateway survived
session exit because the shutdown path relied on POSIX-only os.killpg (absent
on Windows) with a proc.terminate() fallback that only kills the outermost
sh/cmd wrapper — the node.exe listener survived and kept the port.

Contract after the fix:
  - Windows: the tree is killed via `taskkill /PID <pid> /T` (with /F on the
    SIGKILL-equivalent escalation), which walks the real parent-child tree;
  - POSIX: killpg(SIGTERM) then killpg(SIGKILL) behaviour is unchanged;
  - a hard-kill escalation happens when the process does not exit within the
    grace window.

Run with the standard library only:
    python -m unittest discover -s tests -v
"""

import os
import subprocess
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

pkg_root = Path(__file__).resolve().parents[2]
agent_pkg = types.ModuleType("agent")
mp_mod = types.ModuleType("agent.memory_provider")


class MemoryProvider:
    pass


mp_mod.MemoryProvider = MemoryProvider
agent_pkg.memory_provider = mp_mod
sys.modules.setdefault("agent", agent_pkg)
sys.modules["agent.memory_provider"] = mp_mod
sys.path.insert(0, str(pkg_root))

from memory_tencentdb import GatewaySupervisor  # noqa: E402


class _Proc:
    """Popen stand-in that records kill calls."""

    def __init__(self, pid=424242, running=True):
        self.pid = pid
        self._running = running
        self.terminated = False
        self.killed = False

    def poll(self):
        return None if self._running else 0

    def wait(self, timeout=None):
        self._running = False
        return 0

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.killed = True


class TestWindowsTreeKill(unittest.TestCase):
    def setUp(self):
        # 本机 Windows 上 os.killpg 本就不存在——这正是 #1381 的前提
        self._had_killpg = hasattr(os, "killpg")
        if self._had_killpg:
            self._orig_killpg = os.killpg
            del os.killpg

    def tearDown(self):
        if self._had_killpg:
            os.killpg = self._orig_killpg

    @unittest.skipUnless(os.name == "nt", "Windows-specific branch")
    def test_windows_uses_taskkill_tree(self):
        proc = _Proc()
        with mock.patch.object(subprocess, "run", wraps=subprocess.run) as spy:
            GatewaySupervisor._terminate_process_tree(proc, grace=0.1)
            taskkill_calls = [c for c in spy.call_args_list if c.args and c.args[0] == ["taskkill", "/PID", str(proc.pid), "/T"]]
        self.assertTrue(taskkill_calls, "Windows 必须用 taskkill /T 清理进程树")
        self.assertFalse(proc.terminated, "Windows 上不应依赖 proc.terminate()（只杀包装层）")

    @unittest.skipUnless(os.name != "nt", "POSIX branch")
    def test_posix_uses_killpg(self):
        proc = _Proc()
        calls = []
        import signal

        with mock.patch.object(os, "killpg", lambda pgid, sig: calls.append(sig)), mock.patch.object(
            os, "getpgid", lambda pid: pid
        ):
            GatewaySupervisor._terminate_process_tree(proc, grace=0.1)
        self.assertIn(signal.SIGTERM, calls)
        self.assertFalse(proc.terminated or proc.killed)


if __name__ == "__main__":
    unittest.main()
