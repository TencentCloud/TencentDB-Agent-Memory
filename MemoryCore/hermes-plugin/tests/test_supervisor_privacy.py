"""Real child-process/log-file checks; synthetic bytes and no network calls."""
import importlib.util
import logging
import os
from pathlib import Path
import shlex
import stat
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1] / "memory/memory_tencentdb"
package = types.ModuleType("privacy_supervisor_package")
package.__path__ = [str(ROOT)]
sys.modules[package.__name__] = package

def load(name, file):
    spec = importlib.util.spec_from_file_location(package.__name__ + "." + name, ROOT / file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module

load("client", "client.py")
supervisor = load("supervisor", "supervisor.py")
SECRET = "synthetic-command-and-child-stderr-secret"

class PrivacyTests(unittest.TestCase):
    def launch(self, directory):
        code = "import sys;sys.stderr.write(" + repr(SECRET) + ");sys.exit(23)"
        command = shlex.join([sys.executable, "-c", code])
        instance = supervisor.GatewaySupervisor(port=54321, gateway_cmd=command)
        instance.is_running = lambda: False
        instance._resolve_log_dir = lambda: str(directory)
        instance._client.health = lambda **kwargs: (_ for _ in ()).throw(ConnectionError())
        with self.assertLogs(supervisor.logger, level=logging.INFO) as captured:
            self.assertFalse(instance.ensure_running())
        instance.shutdown()
        return captured.output

    def test_child_crash_does_not_copy_command_or_stderr_to_plugin_logs(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root) / "logs"
            logs = self.launch(directory)
            self.assertIn(SECRET, (directory / "gateway.stderr.log").read_text())
            self.assertNotIn(SECRET, "\n".join(logs))

    def test_created_logs_are_private_even_under_permissive_umask(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root) / "logs"
            old = os.umask(0o022)
            try:
                self.launch(directory)
            finally:
                os.umask(old)
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
            for name in ("gateway.stdout.log", "gateway.stderr.log"):
                self.assertEqual(stat.S_IMODE((directory / name).stat().st_mode), 0o600)

    def test_existing_regular_log_is_tightened_without_truncating_it(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            output = directory / "gateway.stderr.log"
            output.write_text("previous-synthetic-entry\n")
            output.chmod(0o666)
            self.launch(directory)
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            self.assertTrue(output.read_text().startswith("previous-synthetic-entry\n"))

    def test_symlink_log_does_not_write_or_chmod_its_target(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root) / "logs"
            directory.mkdir()
            target = Path(root) / "outside.txt"
            target.write_text("synthetic sentinel")
            target.chmod(0o644)
            (directory / "gateway.stderr.log").symlink_to(target)
            logs = self.launch(directory)
            self.assertEqual(target.read_text(), "synthetic sentinel")
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o644)
            self.assertNotIn(SECRET, "\n".join(logs))

    def test_spawn_failure_logs_exception_class_without_its_contents(self):
        with tempfile.TemporaryDirectory() as root, patch.object(supervisor.subprocess, "Popen", side_effect=RuntimeError(SECRET)):
            logs = self.launch(Path(root))
            self.assertNotIn(SECRET, "\n".join(logs))
            self.assertIn("RuntimeError", "\n".join(logs))

    def test_unsafe_log_fallback_still_starts_and_shuts_down_the_actual_child(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            target = directory / "outside.txt"
            target.write_text("synthetic sentinel")
            (directory / "gateway.stderr.log").symlink_to(target)
            command = shlex.join([sys.executable, "-c", "import time;time.sleep(30)"])
            instance = supervisor.GatewaySupervisor(port=54322, gateway_cmd=command)
            instance.is_running = lambda: False
            instance._resolve_log_dir = lambda: str(directory)
            instance._client.health = lambda **kwargs: {"status": "ok"}
            try:
                with self.assertLogs(supervisor.logger, level=logging.INFO):
                    self.assertTrue(instance.ensure_running())
                self.assertIsNone(instance._stdout_log)
                self.assertIsNone(instance._stderr_log)
                self.assertIsNotNone(instance._process)
            finally:
                instance.shutdown()
            self.assertIsNone(instance._process)
            self.assertEqual(target.read_text(), "synthetic sentinel")

    def test_hardlinked_log_is_rejected_without_chmod_or_writes(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "outside.txt"
            target.write_text("synthetic sentinel")
            target.chmod(0o644)
            link = Path(root) / "log.txt"
            os.link(target, link)
            with self.assertRaises(OSError):
                supervisor._open_private_log(str(link))
            self.assertEqual(target.read_text(), "synthetic sentinel")
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o644)

    def test_fifo_log_refuses_without_waiting_for_a_reader(self):
        with tempfile.TemporaryDirectory() as root:
            fifo = Path(root) / "log.pipe"
            os.mkfifo(fifo)
            code = "import sys;sys.path.insert(0,sys.argv[1]);import test_supervisor_privacy as t\ntry:t.supervisor._open_private_log(sys.argv[2])\nexcept OSError:sys.exit(0)\nsys.exit(1)"
            result = subprocess.run([sys.executable, "-c", code, str(Path(__file__).parent), str(fifo)], timeout=2, capture_output=True)
            self.assertEqual(result.returncode, 0)

if __name__ == "__main__":
    unittest.main()
