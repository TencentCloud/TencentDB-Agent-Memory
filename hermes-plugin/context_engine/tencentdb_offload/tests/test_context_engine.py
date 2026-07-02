from __future__ import annotations

import pathlib
import sys
import time
import unittest

PLUGIN_ROOT = pathlib.Path(__file__).resolve().parents[3]
if str(PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(PLUGIN_ROOT))

from context_engine.tencentdb_offload import TencentdbOffloadContextEngine
from context_engine.tencentdb_offload.client import TencentdbOffloadClient
from context_engine.tencentdb_offload.fallback import FALLBACK_NOTICE, fallback_compress_messages


class FakeClient(TencentdbOffloadClient):
    def __init__(self):
        super().__init__("http://example.invalid")
        self.compact_payloads = []
        self.ingest_payloads = []
        self.compact_response = None
        self.fail_compact = False

    def compact(self, payload):
        self.compact_payloads.append(payload)
        if self.fail_compact:
            raise RuntimeError("down")
        return self.compact_response or {"messages": payload["messages"]}

    def ingest(self, payload):
        self.ingest_payloads.append(payload)
        return {"ok": True}


def sample_messages(count=20):
    messages = [{"role": "system", "content": "system rules"}]
    for i in range(count):
        role = "user" if i % 2 == 0 else "assistant"
        messages.append({"role": role, "content": f"message-{i}"})
    return messages


class ContextEngineTest(unittest.TestCase):
    def test_should_compress_uses_threshold_ratio(self):
        engine = TencentdbOffloadContextEngine(
            client=FakeClient(),
            threshold_ratio=0.5,
            context_length=1000,
        )

        self.assertFalse(engine.should_compress(prompt_tokens=499))
        self.assertTrue(engine.should_compress(prompt_tokens=500))
        self.assertTrue(engine.should_compress(token_count=600, context_window=1000))

    def test_compress_uses_remote_messages_response(self):
        client = FakeClient()
        client.compact_response = {"messages": [{"role": "user", "content": "compact"}]}
        engine = TencentdbOffloadContextEngine(client=client)

        result = engine.compress(sample_messages(4), session_key="s1", context_length=4096)

        self.assertEqual(result, [{"role": "user", "content": "compact"}])
        self.assertEqual(client.compact_payloads[0]["session_key"], "s1")
        self.assertEqual(client.compact_payloads[0]["context_length"], 4096)

    def test_compress_accepts_compacted_messages_response(self):
        client = FakeClient()
        client.compact_response = {"compacted_messages": [{"role": "assistant", "content": "done"}]}
        engine = TencentdbOffloadContextEngine(client=client)

        self.assertEqual(engine.compress(sample_messages(3)), [{"role": "assistant", "content": "done"}])

    def test_compress_falls_back_when_remote_fails(self):
        client = FakeClient()
        client.fail_compact = True
        engine = TencentdbOffloadContextEngine(client=client, fallback_keep=3)

        result = engine.compress(sample_messages(8))

        self.assertEqual(result[0], {"role": "system", "content": "system rules"})
        self.assertEqual(result[1], {"role": "system", "content": FALLBACK_NOTICE})
        self.assertEqual([m["content"] for m in result[-3:]], ["message-5", "message-6", "message-7"])

    def test_update_from_response_schedules_best_effort_ingest(self):
        client = FakeClient()
        engine = TencentdbOffloadContextEngine(client=client)

        engine.update_from_response({"content": "ok"}, session_key="s2", messages=[{"role": "user"}])

        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and not client.ingest_payloads:
            time.sleep(0.01)

        self.assertEqual(client.ingest_payloads[0]["session_key"], "s2")
        self.assertEqual(client.ingest_payloads[0]["response"], {"content": "ok"})


class FallbackTest(unittest.TestCase):
    def test_fallback_returns_original_when_tail_fits(self):
        messages = sample_messages(2)
        self.assertEqual(fallback_compress_messages(messages, keep_tail=5), messages)


if __name__ == "__main__":
    unittest.main()
