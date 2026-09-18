"""Regression tests for #583 — Gateway stdout/stderr logs must be bounded.

Run: python3 -m unittest tests.test_log_rotation
  or python3 tests/test_log_rotation.py
"""

import os
import sys
import tempfile
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# The plugin package imports the Hermes `agent` module which is not present in
# a standalone test environment — stub it so the supervisor can be imported.
_agent = types.ModuleType("agent")
_mp = types.ModuleType("agent.memory_provider")
class _MemoryProvider:  # noqa: N801
    def __init__(self, *args, **kwargs):
        pass
_mp.MemoryProvider = _MemoryProvider
sys.modules.setdefault("agent", _agent)
sys.modules.setdefault("agent.memory_provider", _mp)

import memory.memory_tencentdb.supervisor as supervisor_mod
from memory.memory_tencentdb.supervisor import GatewaySupervisor


class LogRotationTest(unittest.TestCase):
    def setUp(self):
        self.sv = GatewaySupervisor(gateway_cmd="true")
        # Small thresholds so the test doesn't write MiB of data.
        self._orig_max = supervisor_mod.LOG_ACTIVE_MAX_BYTES
        self._orig_tail = supervisor_mod.LOG_TAIL_KEEP_BYTES
        supervisor_mod.LOG_ACTIVE_MAX_BYTES = 1024  # 1 KiB
        supervisor_mod.LOG_TAIL_KEEP_BYTES = 64     # 64 B tail

    def tearDown(self):
        supervisor_mod.LOG_ACTIVE_MAX_BYTES = self._orig_max
        supervisor_mod.LOG_TAIL_KEEP_BYTES = self._orig_tail

    def test_rotate_preserves_tail_and_truncates_in_place(self):
        tmp = tempfile.mkdtemp()
        path = os.path.join(tmp, "gateway.stdout.log")
        content = b"".join(
            b"line %d: payload-payload-payload-payload\n" % i for i in range(200)
        )
        self.assertGreater(len(content), supervisor_mod.LOG_ACTIVE_MAX_BYTES)

        with open(path, "ab") as handle:
            handle.write(content)
            handle.flush()
            # Simulate the supervisor's long-lived descriptor.
            self.sv._stdout_log_path = path
            self.sv._stdout_log = handle

            self.sv._rotate_if_oversized(path, handle)

            # Active file truncated in place (child descriptor stays valid).
            self.assertLessEqual(os.path.getsize(path), supervisor_mod.LOG_ACTIVE_MAX_BYTES)
            # Diagnostic tail preserved in .1.
            tail_path = path + ".1"
            self.assertTrue(os.path.exists(tail_path))
            with open(tail_path, "rb") as f:
                tail = f.read()
            self.assertEqual(len(tail), supervisor_mod.LOG_TAIL_KEEP_BYTES)
            self.assertEqual(tail, content[-supervisor_mod.LOG_TAIL_KEEP_BYTES:])

    def test_undersized_file_is_untouched(self):
        tmp = tempfile.mkdtemp()
        path = os.path.join(tmp, "gateway.stderr.log")
        small = b"small log line\n"
        with open(path, "ab") as handle:
            handle.write(small)
            handle.flush()
            self.sv._stderr_log_path = path
            self.sv._stderr_log = handle
            self.sv._rotate_if_oversized(path, handle)
            self.assertEqual(os.path.getsize(path), len(small))
            self.assertFalse(os.path.exists(path + ".1"))


if __name__ == "__main__":
    unittest.main()
