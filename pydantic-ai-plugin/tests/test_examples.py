from __future__ import annotations

import os
import subprocess
import sys
import unittest
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = PLUGIN_ROOT / "src"
EXAMPLES_ROOT = PLUGIN_ROOT / "examples"


def _example_environment(*, include_deepseek_key: bool) -> dict[str, str]:
    environment = os.environ.copy()
    existing_path = environment.get("PYTHONPATH")
    environment["PYTHONPATH"] = str(SOURCE_ROOT) + (
        os.pathsep + existing_path if existing_path else ""
    )
    environment["PYDANTIC_AI_ALLOW_MODEL_REQUESTS"] = "false"
    if not include_deepseek_key:
        environment.pop("DEEPSEEK_API_KEY", None)
    return environment


class ExampleTests(unittest.TestCase):
    def test_offline_demo_proves_complete_lifecycle(self) -> None:
        completed = subprocess.run(
            [
                sys.executable,
                str(EXAMPLES_ROOT / "offline_memory_demo.py"),
            ],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=_example_environment(include_deepseek_key=False),
            timeout=30,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn(
            "recall -> agent -> capture -> session_end",
            completed.stdout,
        )
        self.assertIn("I remembered your preference.", completed.stdout)

    def test_deepseek_module_import_has_no_side_effect(self) -> None:
        code = (
            "import runpy; "
            f"runpy.run_path({str(EXAMPLES_ROOT / 'deepseek_memory_demo.py')!r}, "
            "run_name='import_test'); "
            "print('imported')"
        )

        completed = subprocess.run(
            [sys.executable, "-c", code],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=_example_environment(include_deepseek_key=False),
            timeout=30,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout.strip(), "imported")

    def test_deepseek_demo_requires_local_key_before_network(self) -> None:
        completed = subprocess.run(
            [
                sys.executable,
                str(EXAMPLES_ROOT / "deepseek_memory_demo.py"),
            ],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=_example_environment(include_deepseek_key=False),
            timeout=30,
        )

        self.assertNotEqual(completed.returncode, 0)
        self.assertIn(
            "Set DEEPSEEK_API_KEY in your local environment",
            completed.stderr,
        )
        self.assertNotIn("Traceback", completed.stdout)


if __name__ == "__main__":
    unittest.main()
