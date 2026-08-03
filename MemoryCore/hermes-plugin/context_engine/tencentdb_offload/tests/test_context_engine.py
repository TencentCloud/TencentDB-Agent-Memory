from __future__ import annotations

import copy
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


THIS_FILE = pathlib.Path(__file__).resolve()
PLUGIN_DIR = THIS_FILE.parents[1]
CONTEXT_ENGINE_ROOT = PLUGIN_DIR.parent
MEMORY_CORE_ROOT = THIS_FILE.parents[4]

hermes_root = os.environ.get("HERMES_AGENT_ROOT")
if hermes_root:
    sys.path.insert(0, hermes_root)
sys.path.insert(0, str(CONTEXT_ENGINE_ROOT))

from tencentdb_offload import (  # noqa: E402
    ENGINE_NAME,
    OffloadV2Client,
    TencentdbOffloadContextEngine,
    register,
)


class FakeClient:
    def __init__(self, response=None, error: Exception | None = None):
        self.response = response or {"messages": []}
        self.error = error
        self.payloads = []

    def compact(self, payload):
        self.payloads.append(payload)
        if self.error:
            raise self.error
        return self.response


class ContextEngineTests(unittest.TestCase):
    def test_registers_real_context_engine_contract(self):
        captured = []

        class Ctx:
            def register_context_engine(self, engine):
                captured.append(engine)

        register(Ctx())
        self.assertEqual(len(captured), 1)
        self.assertEqual(captured[0].name, ENGINE_NAME)

        if hermes_root:
            from agent.context_engine import ContextEngine

            self.assertIsInstance(captured[0], ContextEngine)

    def test_usage_updates_threshold_decision(self):
        engine = TencentdbOffloadContextEngine(
            client=FakeClient(),
            context_length=1_000,
            threshold_percent=0.5,
        )
        engine.update_from_response(
            {
                "prompt_tokens": 499,
                "completion_tokens": 20,
                "total_tokens": 519,
            }
        )
        self.assertFalse(engine.should_compress())
        self.assertTrue(engine.should_compress(500))
        self.assertEqual(engine.last_completion_tokens, 20)
        self.assertEqual(engine.last_total_tokens, 519)

    def test_compact_uses_exact_v2_contract_and_envelope_data(self):
        compacted = [{"role": "user", "content": "compact"}]
        client = FakeClient({"messages": compacted, "report": {"resolvedLevel": "mild"}})
        engine = TencentdbOffloadContextEngine(
            client=client,
            context_length=2_000,
            threshold_percent=0.5,
        )
        engine.on_session_start("team/a session")

        messages = [{"role": "user", "content": "x" * 100}]
        result = engine.compress(messages, current_tokens=1_200)

        self.assertIs(result, compacted)
        self.assertEqual(
            client.payloads,
            [
                {
                    "session_id": "team_a_session",
                    "messages": messages,
                    "ratio": 0.6,
                    "context_window": 2_000,
                    "total_tokens": 1_200,
                }
            ],
        )
        self.assertEqual(engine.compression_count, 1)

    def test_compact_is_fail_open_on_transport_error(self):
        messages = [{"role": "user", "content": "keep me"}]
        engine = TencentdbOffloadContextEngine(
            client=FakeClient(error=ConnectionError("down"))
        )
        self.assertIs(engine.compress(messages, current_tokens=90_000), messages)
        self.assertEqual(engine.compression_count, 0)

    def test_compact_is_fail_open_on_bad_message_shape(self):
        messages = [{"role": "user", "content": "keep me"}]
        engine = TencentdbOffloadContextEngine(
            client=FakeClient({"messages": ["not-a-message"]})
        )
        self.assertIs(engine.compress(messages, current_tokens=90_000), messages)

    def test_engine_can_be_deep_copied_for_hermes_agent_isolation(self):
        engine = TencentdbOffloadContextEngine(client=FakeClient())
        cloned = copy.deepcopy(engine)
        self.assertIsNot(cloned, engine)
        self.assertEqual(cloned.name, engine.name)


class ClientTests(unittest.TestCase):
    def test_client_sends_auth_service_and_v2_payload(self):
        captured = {}

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return json.dumps(
                    {"code": 0, "message": "ok", "data": {"messages": []}}
                ).encode()

        def fake_urlopen(request, timeout):
            captured["request"] = request
            captured["timeout"] = timeout
            return Response()

        client = OffloadV2Client(
            "http://memory.example/",
            api_key="secret",
            service_id="tenant-a",
            timeout=7,
        )
        payload = {
            "session_id": "s",
            "messages": [],
            "ratio": 0.5,
            "context_window": 1_000,
            "total_tokens": 500,
        }
        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            data = client.compact(payload)

        request = captured["request"]
        self.assertEqual(request.full_url, "http://memory.example/v2/offload/compact")
        self.assertEqual(request.get_header("Authorization"), "Bearer secret")
        self.assertEqual(request.get_header("X-tdai-service-id"), "tenant-a")
        self.assertEqual(json.loads(request.data.decode()), payload)
        self.assertEqual(captured["timeout"], 7)
        self.assertEqual(data, {"messages": []})


class InstallerTests(unittest.TestCase):
    def test_installer_links_both_plugins_and_updates_config(self):
        script = MEMORY_CORE_ROOT / "scripts" / "install-hermes-plugin.sh"
        provider_source = (
            MEMORY_CORE_ROOT / "hermes-plugin" / "memory" / "memory_tencentdb"
        )

        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            hermes_home = root / ".hermes"
            agent_dir = hermes_home / "hermes-agent"
            (agent_dir / "plugins" / "memory").mkdir(parents=True)
            hermes_home.mkdir(exist_ok=True)
            config = hermes_home / "config.yaml"
            config.write_text("model: test-model\n", encoding="utf-8")

            env = os.environ.copy()
            env.update(
                {
                    "HERMES_HOME": str(hermes_home),
                    "HERMES_AGENT_DIR": str(agent_dir),
                    "HERMES_CONFIG": str(config),
                    "HERMES_ENV": str(hermes_home / ".env"),
                    "HERMES_PROVIDER_SRC": str(provider_source),
                    "HERMES_CONTEXT_ENGINE_SRC": str(PLUGIN_DIR),
                    "WRITE_HERMES_ENV": "0",
                    "WRITE_HERMES_CONFIG": "1",
                    "FORCE": "1",
                }
            )

            subprocess.run(
                ["bash", str(script)],
                env=env,
                check=True,
                capture_output=True,
                text=True,
            )

            provider_target = (
                agent_dir / "plugins" / "memory" / "memory_tencentdb"
            )
            engine_target = (
                agent_dir / "plugins" / "context_engine" / ENGINE_NAME
            )
            self.assertTrue(provider_target.is_symlink())
            self.assertEqual(provider_target.resolve(), provider_source.resolve())
            self.assertTrue(engine_target.is_symlink())
            self.assertEqual(engine_target.resolve(), PLUGIN_DIR.resolve())

            rendered = config.read_text(encoding="utf-8")
            self.assertIn("provider: memory_tencentdb", rendered)
            self.assertIn(f"engine: {ENGINE_NAME}", rendered)


if __name__ == "__main__":
    unittest.main()
