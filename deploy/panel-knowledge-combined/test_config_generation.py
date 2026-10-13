#!/usr/bin/env python3
"""
Portable test suite for start-combined.sh configuration generation.

Verifies:
1. Exact JSON generation with synthetic strings containing quotes, backslashes,
   Unicode, newlines, and code-like payload strings.
2. Proves that code-like payloads are NEVER executed (no shell or python injection).
3. Verifies optional proxy endpoint handling (included when provided, omitted when empty).
4. Verifies default values for INSTANCE_ID and INSTANCE_NAME.
5. Verifies mounted configuration files remain completely untouched.
6. Does not access /app, production, SSH, credentials, or remote Docker.
"""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


class TestStartCombinedConfigGeneration(unittest.TestCase):
    def setUp(self):
        self.script_path = Path(__file__).resolve().parent / "start-combined.sh"
        self.assertTrue(self.script_path.is_file(), f"Script not found at {self.script_path}")

    def run_script(self, env_vars, instances_file):
        """Run start-combined.sh in CONFIG_ONLY mode with a clean test environment."""
        test_env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin:/usr/local/bin"),
            "CONFIG_ONLY": "1",
            "INSTANCES_FILE": str(instances_file),
        }
        test_env.update(env_vars)

        result = subprocess.run(
            ["bash", str(self.script_path)],
            env=test_env,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return result

    def test_synthetic_characters_and_no_code_execution(self):
        """Test with synthetic quotes, backslashes, Unicode, newlines, and code payloads."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            instances_file = tmp_path / "metadata-instances.json"
            canary_file = tmp_path / "canary_pwned.txt"

            synthetic_id = "mem-test-'quoted'-\"double\"-\\backslash\\"
            # Code-like payload designed to execute touch if bash or python evaluates it as code
            code_payload = f"$(touch '{canary_file}') && __import__('os').system('touch {canary_file}')"
            synthetic_name = f"Instance\nWith\nNewlines and Unicode 🚀 中文 and payload: {code_payload}"
            synthetic_gateway = "http://gateway.internal:8420/v1/path?filter='test'&param=\"val\"\\esc"
            synthetic_key = "key-'single'-\"double\"-\\slash\\\nnewline\tend;"
            synthetic_proxy = "http://proxy.internal:8096/prefix?tag=🌟&opt='1'"

            env_vars = {
                "REMOTE_INSTANCE_ID": synthetic_id,
                "REMOTE_INSTANCE_NAME": synthetic_name,
                "REMOTE_INSTANCE_URL": synthetic_gateway,
                "REMOTE_INSTANCE_KEY": synthetic_key,
                "REMOTE_INSTANCE_PROXY_URL": synthetic_proxy,
            }

            res = self.run_script(env_vars, instances_file)
            self.assertEqual(res.returncode, 0, f"Script failed with stderr: {res.stderr}")

            # 1. Prove no code execution occurred
            self.assertFalse(canary_file.exists(), "Code execution detected! Canary file was created.")

            # 2. Verify file was written and is valid JSON
            self.assertTrue(instances_file.is_file(), "instances file was not created")
            self.assertEqual(instances_file.stat().st_mode & 0o777, 0o600)
            content = instances_file.read_text(encoding="utf-8")
            data = json.loads(content)

            # 3. Prove exact JSON values match input strings byte-for-byte
            instances = data.get("instances", [])
            self.assertEqual(len(instances), 1)
            inst = instances[0]

            self.assertEqual(inst["id"], synthetic_id)
            self.assertEqual(inst["name"], synthetic_name)
            self.assertEqual(inst["gateway_endpoint"], synthetic_gateway)
            self.assertEqual(inst["api_key"], synthetic_key)
            self.assertEqual(inst["proxy_endpoint"], synthetic_proxy)

    def test_optional_proxy_endpoint_omitted_when_unset_or_empty(self):
        """Test that proxy_endpoint is omitted when REMOTE_INSTANCE_PROXY_URL is empty."""
        with tempfile.TemporaryDirectory() as tmpdir:
            instances_file = Path(tmpdir) / "metadata-instances.json"

            env_vars = {
                "REMOTE_INSTANCE_ID": "instance-no-proxy",
                "REMOTE_INSTANCE_NAME": "Instance No Proxy",
                "REMOTE_INSTANCE_URL": "http://gateway.test:8420",
                "REMOTE_INSTANCE_KEY": "test-key-123",
                "REMOTE_INSTANCE_PROXY_URL": "",
            }

            res = self.run_script(env_vars, instances_file)
            self.assertEqual(res.returncode, 0, f"Script failed with stderr: {res.stderr}")

            data = json.loads(instances_file.read_text(encoding="utf-8"))
            inst = data["instances"][0]
            self.assertNotIn("proxy_endpoint", inst, "proxy_endpoint must be omitted when empty")
            self.assertEqual(inst["id"], "instance-no-proxy")
            self.assertEqual(inst["gateway_endpoint"], "http://gateway.test:8420")
            self.assertEqual(inst["api_key"], "test-key-123")

    def test_default_values_when_id_and_name_unset(self):
        """Test default values when REMOTE_INSTANCE_ID and REMOTE_INSTANCE_NAME are omitted."""
        with tempfile.TemporaryDirectory() as tmpdir:
            instances_file = Path(tmpdir) / "metadata-instances.json"

            env_vars = {
                "REMOTE_INSTANCE_URL": "http://gateway.test:8420",
                "REMOTE_INSTANCE_KEY": "default-test-key",
            }

            res = self.run_script(env_vars, instances_file)
            self.assertEqual(res.returncode, 0, f"Script failed with stderr: {res.stderr}")

            data = json.loads(instances_file.read_text(encoding="utf-8"))
            inst = data["instances"][0]
            # Default ID should be 'default', and name should default to ID ('default')
            self.assertEqual(inst["id"], "default")
            self.assertEqual(inst["name"], "default")
            self.assertEqual(inst["gateway_endpoint"], "http://gateway.test:8420")
            self.assertEqual(inst["api_key"], "default-test-key")

    def test_mounted_files_remain_untouched(self):
        """Test that user-provided/mounted files are detected and remain completely untouched."""
        with tempfile.TemporaryDirectory() as tmpdir:
            instances_file = Path(tmpdir) / "metadata-instances.json"

            # Pre-create a user-mounted config file with custom formatting and structure
            mounted_content = (
                '{\n'
                '  "instances": [\n'
                '    {\n'
                '      "id": "mounted-custom-instance-01",\n'
                '      "name": "Mounted Custom Instance",\n'
                '      "gateway_endpoint": "https://mounted.domain.com:8420",\n'
                '      "api_key": "user-pre-mounted-secret-key"\n'
                '    }\n'
                '  ],\n'
                '  "_user_custom_marker": 42\n'
                '}\n'
            )
            instances_file.write_text(mounted_content, encoding="utf-8")
            mtime_before = instances_file.stat().st_mtime_ns

            # Run script with competing environment variables
            env_vars = {
                "REMOTE_INSTANCE_ID": "should-not-override",
                "REMOTE_INSTANCE_NAME": "Should Not Override",
                "REMOTE_INSTANCE_URL": "http://override.invalid:8420",
                "REMOTE_INSTANCE_KEY": "override-key",
            }

            res = self.run_script(env_vars, instances_file)
            self.assertEqual(res.returncode, 0, f"Script failed with stderr: {res.stderr}")
            self.assertIn("detected user-provided", res.stdout)

            # Ensure file was not overwritten or touched
            mtime_after = instances_file.stat().st_mtime_ns
            self.assertEqual(mtime_before, mtime_after, "File mtime changed; mounted file was modified!")
            current_content = instances_file.read_text(encoding="utf-8")
            self.assertEqual(current_content, mounted_content, "Mounted content was altered!")


if __name__ == "__main__":
    unittest.main()
