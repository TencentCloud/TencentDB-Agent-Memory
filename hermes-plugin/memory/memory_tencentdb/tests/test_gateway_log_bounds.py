"""Regression tests for bounded Hermes Gateway stdout/stderr logs.

The tests load ``supervisor.py`` without requiring a Hermes checkout, then use
real files and a real child process so the inherited-descriptor behavior is
covered rather than mocked.
"""

from __future__ import annotations

import importlib.util
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest import mock


_TEST_FILE = pathlib.Path(__file__).resolve()
_PACKAGE_DIR = _TEST_FILE.parents[1]
_SUPERVISOR_PATH = _PACKAGE_DIR / "supervisor.py"
_TEST_PACKAGE = "_tdai_gateway_log_guard_test_package"


def _load_supervisor_module():
    """Load the supervisor and its relative ``client`` import in isolation."""
    package = types.ModuleType(_TEST_PACKAGE)
    package.__path__ = [str(_PACKAGE_DIR)]
    sys.modules.setdefault(_TEST_PACKAGE, package)

    module_name = f"{_TEST_PACKAGE}.supervisor"
    existing = sys.modules.get(module_name)
    if existing is not None:
        return existing

    spec = importlib.util.spec_from_file_location(module_name, _SUPERVISOR_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {_SUPERVISOR_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


supervisor_module = _load_supervisor_module()


class GatewayLogBoundsTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = pathlib.Path(tempfile.mkdtemp(prefix="tdai-log-bounds-"))
        self._supervisors = []

    def tearDown(self) -> None:
        for supervisor in self._supervisors:
            supervisor._close_log_handles()
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def _new_supervisor(self):
        supervisor = supervisor_module.GatewaySupervisor(gateway_cmd="")
        self._supervisors.append(supervisor)
        return supervisor

    @staticmethod
    def _attach_log(supervisor, attr: str, path: pathlib.Path) -> None:
        setattr(supervisor, f"_{attr}_log_path", str(path))
        setattr(supervisor, f"_{attr}_log", open(path, "ab", buffering=0))

    @staticmethod
    def _file_identity(path: pathlib.Path):
        stat = path.stat()
        return stat.st_dev, stat.st_ino

    def test_rotation_preserves_tail_inode_and_open_descriptor(self) -> None:
        path = self._tmpdir / "gateway.stdout.log"
        original = b"old-prefix-" + bytes(range(128))
        path.write_bytes(original)

        supervisor = self._new_supervisor()
        self._attach_log(supervisor, "stdout", path)
        identity_before = self._file_identity(path)

        with (
            mock.patch.object(supervisor_module, "LOG_FILE_MAX_BYTES", 64),
            mock.patch.object(supervisor_module, "LOG_FILE_RETAIN_BYTES", 32),
        ):
            supervisor._enforce_log_limits()

        rotated = pathlib.Path(f"{path}.1")
        self.assertEqual(rotated.read_bytes(), original[-32:])
        self.assertEqual(path.read_bytes(), b"")
        self.assertEqual(self._file_identity(path), identity_before)
        self.assertEqual(list(path.parent.glob(f"{path.name}.1.*.tmp")), [])

        # The same handle that existed before truncation remains writable.
        supervisor._stdout_log.write(b"after-truncate")
        self.assertEqual(path.read_bytes(), b"after-truncate")

    def test_guard_bounds_real_child_output_while_control_grows(self) -> None:
        max_bytes = 32 * 1024
        retain_bytes = 8 * 1024
        child_code = (
            "import os,time\n"
            "chunk=b'x'*4096\n"
            "for _ in range(256):\n"
            " os.write(1,chunk)\n"
            " time.sleep(0.001)\n"
            "time.sleep(0.2)\n"
            "os.write(1,b'CHILD_DONE\\n')\n"
        )

        control_path = self._tmpdir / "control.log"
        with open(control_path, "ab", buffering=0) as control:
            result = subprocess.run(
                [sys.executable, "-c", child_code],
                stdout=control,
                stderr=subprocess.PIPE,
                check=False,
                timeout=10,
            )
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
        self.assertGreater(control_path.stat().st_size, max_bytes * 10)

        experiment_path = self._tmpdir / "experiment.log"
        supervisor = self._new_supervisor()
        self._attach_log(supervisor, "stdout", experiment_path)
        identity_before = self._file_identity(experiment_path)

        with (
            mock.patch.object(supervisor_module, "LOG_FILE_MAX_BYTES", max_bytes),
            mock.patch.object(supervisor_module, "LOG_FILE_RETAIN_BYTES", retain_bytes),
            mock.patch.object(supervisor_module, "LOG_GUARD_INTERVAL_SECS", 0.005),
            mock.patch.object(supervisor_module, "LOG_GUARD_SHUTDOWN_TIMEOUT_SECS", 1.0),
        ):
            supervisor._start_log_guard()
            thread = supervisor._log_guard_thread
            self.assertIsNotNone(thread)

            child = subprocess.Popen(
                [sys.executable, "-c", child_code],
                stdout=supervisor._stdout_log,
                stderr=subprocess.PIPE,
            )
            rotated_path = pathlib.Path(f"{experiment_path}.1")
            deadline = time.monotonic() + 5
            rotated_while_alive = False
            while time.monotonic() < deadline:
                if rotated_path.exists() and child.poll() is None:
                    rotated_while_alive = True
                    break
                if child.poll() is not None:
                    break
                time.sleep(0.005)

            _, child_stderr = child.communicate(timeout=10)
            self.assertEqual(child.returncode, 0, child_stderr.decode(errors="replace"))
            self.assertTrue(rotated_while_alive, "guard never rotated while child was still writing")

            # Let the guard process the final chunk, then freeze it for stable
            # assertions and run one final synchronous pass.
            time.sleep(0.05)
            supervisor._stop_log_guard()
            supervisor._enforce_log_limits()

        rotated_path = pathlib.Path(f"{experiment_path}.1")
        self.assertLessEqual(experiment_path.stat().st_size, max_bytes)
        self.assertEqual(rotated_path.stat().st_size, retain_bytes)
        self.assertEqual(self._file_identity(experiment_path), identity_before)
        self.assertFalse(thread.is_alive())

        bounded_output = experiment_path.read_bytes() + rotated_path.read_bytes()
        self.assertIn(b"CHILD_DONE\n", bounded_output)

    def test_guard_failure_is_fail_open_and_warns_once(self) -> None:
        path = self._tmpdir / "gateway.stderr.log"
        path.write_bytes(b"existing")
        supervisor = self._new_supervisor()
        self._attach_log(supervisor, "stderr", path)

        with (
            mock.patch.object(
                supervisor_module.os.path,
                "getsize",
                side_effect=PermissionError("denied"),
            ),
            self.assertLogs(supervisor_module.logger, level="WARNING") as captured,
        ):
            supervisor._enforce_log_limits()
            supervisor._enforce_log_limits()

        failure_logs = [
            line for line in captured.output
            if "failed to bound log file" in line
        ]
        self.assertEqual(len(failure_logs), 1)
        self.assertIn(str(path), supervisor._log_guard_failed_paths)

        # Guard errors do not close or replace the child's logging target.
        supervisor._stderr_log.write(b"-still-writable")
        self.assertEqual(path.read_bytes(), b"existing-still-writable")

    def test_close_stops_guard_before_closing_handles(self) -> None:
        path = self._tmpdir / "gateway.stdout.log"
        supervisor = self._new_supervisor()
        self._attach_log(supervisor, "stdout", path)

        with (
            mock.patch.object(supervisor_module, "LOG_GUARD_INTERVAL_SECS", 0.01),
            mock.patch.object(supervisor_module, "LOG_GUARD_SHUTDOWN_TIMEOUT_SECS", 1.0),
        ):
            supervisor._start_log_guard()
            thread = supervisor._log_guard_thread
            self.assertIsNotNone(thread)
            self.assertTrue(thread.is_alive())
            supervisor._close_log_handles()

        self.assertFalse(thread.is_alive())
        self.assertIsNone(supervisor._log_guard_thread)
        self.assertIsNone(supervisor._stdout_log)


if __name__ == "__main__":
    unittest.main(verbosity=2)
