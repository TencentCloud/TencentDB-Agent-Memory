"""Unit tests for TencentdbContextEngine.

Pure stdlib tests (no Hermes import required) that exercise:

* Heartbeat message filtering in ``before_prompt_build``.
* Fast-path skipping for small conversations.
* Graceful fallback when Gateway is unreachable.
* ``post_json`` / ``get_json`` generic API passthrough on the client.
* Fallback counting (WARN on 1st + every 5th, DEBUG otherwise).
"""

from __future__ import annotations

import json
import logging
import unittest
from typing import Any, Dict, List, Optional
from unittest.mock import MagicMock

from memory_tencentdb.client import MemoryTencentdbSdkClient
from memory_tencentdb.context_engine import (
    TencentdbContextEngine,
    _FALLBACK_WARN_INTERVAL,
    _MAX_INPUT_CHARS_EST,
    _MAX_MESSAGES_BEFORE_SKIP,
    _msg_is_heartbeat,
)


class HeartbeatDetectionTests(unittest.TestCase):
    def test_plain_message_not_heartbeat(self) -> None:
        self.assertFalse(_msg_is_heartbeat({"role": "user", "content": "hello"}))

    def test_heartbeat_tool_result_detected(self) -> None:
        msg = {
            "role": "user",
            "content": [{"type": "text", "text": "contents of /workspace/HEARTBEAT.md"}],
        }
        self.assertTrue(_msg_is_heartbeat(msg))

    def test_empty_object_safe(self) -> None:
        self.assertFalse(_msg_is_heartbeat({}))


class _FakeClient:
    """Stand-in for MemoryTencentdbSdkClient with call record + error toggle."""

    def __init__(
        self,
        *,
        compact_response: Optional[Dict[str, Any]] = None,
        ingest_response: Optional[Dict[str, Any]] = None,
        raise_on_compact: Optional[Exception] = None,
        raise_on_ingest: Optional[Exception] = None,
    ) -> None:
        self.calls: List[Dict[str, Any]] = []
        self.compact_response = compact_response or {"modified_messages": []}
        self.ingest_response = ingest_response or {"code": 0}
        self.raise_on_compact = raise_on_compact
        self.raise_on_ingest = raise_on_ingest

    def post_json(self, path: str, body: Dict[str, Any], timeout: Any = None) -> Dict[str, Any]:
        self.calls.append({"path": path, "body": dict(body), "timeout": timeout})
        if "/compact" in path and self.raise_on_compact:
            raise self.raise_on_compact
        if "/ingest" in path and self.raise_on_ingest:
            raise self.raise_on_ingest
        if "/compact" in path:
            return dict(self.compact_response)
        return dict(self.ingest_response)


class ContextEngineTests(unittest.TestCase):
    def _msgs(self, n: int, size: int = 500) -> List[Dict[str, Any]]:
        return [
            {"role": "user" if i % 2 == 0 else "assistant", "content": "x" * size}
            for i in range(n)
        ]

    # ── constructors / defaults ─────────────────────────────────────

    def test_default_context_window_floor(self) -> None:
        eng = TencentdbContextEngine(client=_FakeClient(), context_window=1)
        self.assertEqual(eng.context_window, 1_000)

    def test_default_gateway_base_url_via_client(self) -> None:
        client = MemoryTencentdbSdkClient(
            base_url="http://127.0.0.1:9000",
        )
        eng = TencentdbContextEngine(client=client)
        self.assertIs(eng._client, client)

    # ── fast-path skipping ───────────────────────────────────────────

    def test_empty_messages_passthrough(self) -> None:
        eng = TencentdbContextEngine(client=_FakeClient())
        self.assertEqual(eng.before_prompt_build([]), [])

    def test_short_conversation_skips_rpc(self) -> None:
        fake = _FakeClient()
        eng = TencentdbContextEngine(client=fake)
        msgs = self._msgs(_MAX_MESSAGES_BEFORE_SKIP - 1)
        out = eng.before_prompt_build(msgs)
        self.assertEqual(len(out), len(msgs))
        self.assertEqual(fake.calls, [])

    def test_small_char_count_skips_rpc(self) -> None:
        fake = _FakeClient()
        eng = TencentdbContextEngine(client=fake)
        msgs = self._msgs(10, size=10)  # 10 messages but only ~100 chars
        out = eng.before_prompt_build(msgs, session_key="s1")
        self.assertEqual(len(out), len(msgs))
        self.assertEqual(fake.calls, [])

    # ── heartbeat filtering ──────────────────────────────────────────

    def test_heartbeat_filtered_locally_without_rpc(self) -> None:
        fake = _FakeClient()
        eng = TencentdbContextEngine(client=fake)
        # Make conversation large enough to trigger RPC if heartbeats were
        # counted. With heartbeats stripped it shrinks below the threshold.
        hb_msgs = [
            {"role": "user", "content": f"HEARTBEAT.md check {i}"}
            for i in range(12)
        ]
        short_msgs = self._msgs(3, size=10)
        msgs = hb_msgs + short_msgs
        out = eng.before_prompt_build(msgs, session_key="hb-test")
        # Heartbeats removed locally; after removal len=3 < threshold so
        # no RPC is made.
        self.assertEqual(len(out), 3)
        self.assertEqual(fake.calls, [])

    # ── compact RPC delegation ───────────────────────────────────────

    def test_compact_modified_messages_returned(self) -> None:
        orig = self._msgs(20, size=3000)  # clearly exceeds 20k char limit
        modified = self._msgs(8, size=3000)
        fake = _FakeClient(compact_response={"modified_messages": modified, "decision": "mild"})
        eng = TencentdbContextEngine(client=fake)
        out = eng.before_prompt_build(orig, context_window=200_000, session_key="s2")
        self.assertEqual(len(fake.calls), 1)
        self.assertEqual(fake.calls[0]["path"], "/v2/offload/compact")
        self.assertEqual(fake.calls[0]["body"]["session_key"], "s2")
        self.assertEqual(fake.calls[0]["body"]["context_window"], 200_000)
        self.assertIs(out, modified)

    def test_compact_empty_modified_fallbacks_to_original(self) -> None:
        orig = self._msgs(20, size=3000)
        fake = _FakeClient(compact_response={"modified_messages": [], "decision": "below_mild"})
        eng = TencentdbContextEngine(client=fake)
        out = eng.before_prompt_build(list(orig), session_key="s3")
        # Empty modified is falsy; original list preserved.
        self.assertEqual(len(out), len(orig))
        self.assertEqual(eng.fallback_counts, {})

    # ── fallback behaviour ───────────────────────────────────────────

    def test_gateway_down_returns_original_messages(self) -> None:
        orig = self._msgs(20, size=3000)
        fake = _FakeClient(raise_on_compact=ConnectionError("refused"))
        eng = TencentdbContextEngine(client=fake)
        out = eng.before_prompt_build(list(orig), session_key="s-fallback")
        self.assertEqual(len(out), len(orig))
        self.assertEqual(eng.fallback_counts.get("s-fallback"), 1)

    def test_fallback_warn_every_fifth_failure(self) -> None:
        fake = _FakeClient(raise_on_compact=TimeoutError("timeout"))
        eng = TencentdbContextEngine(client=fake)
        seen_levels: List[int] = []
        handler = logging.Handler()
        def _emit(rec: logging.LogRecord) -> None:
            if "tdai-context" in rec.getMessage() and "FALLBACK" in rec.getMessage():
                seen_levels.append(rec.levelno)
        handler.emit = _emit  # type: ignore[assignment]
        logger = logging.getLogger("memory_tencentdb.context_engine")
        logger.addHandler(handler)
        logger.setLevel(logging.DEBUG)
        try:
            msgs = self._msgs(20, size=3000)
            for i in range(1, 12):
                eng.before_prompt_build(list(msgs), session_key="s-fb")
            # Expected WARN levels at count 1, 5, 10 (1st + every _FALLBACK_WARN_INTERVAL).
            expected_warns = sum(
                1
                for count in range(1, 12)
                if count == 1 or count % _FALLBACK_WARN_INTERVAL == 0
            )
            actual_warns = sum(1 for lvl in seen_levels if lvl == logging.WARNING)
            self.assertEqual(actual_warns, expected_warns, f"seen={seen_levels}")
            self.assertEqual(eng.fallback_counts.get("s-fb"), 11)
        finally:
            logger.removeHandler(handler)

    def test_first_successful_rpc_clears_fallback_counter(self) -> None:
        fake = _FakeClient(raise_on_compact=RuntimeError("x"))
        eng = TencentdbContextEngine(client=fake)
        msgs = self._msgs(20, size=3000)
        for _ in range(3):
            eng.before_prompt_build(list(msgs), session_key="s-rec")
        self.assertEqual(eng.fallback_counts.get("s-rec"), 3)
        # Next call succeeds
        fake.raise_on_compact = None
        fake.compact_response = {"modified_messages": msgs[0:5], "decision": "mild"}
        eng.before_prompt_build(list(msgs), session_key="s-rec")
        self.assertEqual(eng.fallback_counts.get("s-rec"), None)

    # ── after_tool_call ingest ───────────────────────────────────────

    def test_after_tool_call_skips_heartbeats(self) -> None:
        fake = _FakeClient()
        eng = TencentdbContextEngine(client=fake)
        eng.after_tool_call(
            tool_name="read_file",
            tool_call_id="toolu_1",
            params={"path": "HEARTBEAT.md"},
            result="...",
            session_key="s-ingest",
        )
        self.assertEqual(fake.calls, [])

    def test_after_tool_call_no_id_is_noop(self) -> None:
        fake = _FakeClient()
        eng = TencentdbContextEngine(client=fake)
        eng.after_tool_call(
            tool_name="noop",
            tool_call_id="",  # empty → skip
            params={},
            result=None,
            session_key="s-ingest",
        )
        self.assertEqual(fake.calls, [])

    def test_after_tool_call_ingest_body(self) -> None:
        fake = _FakeClient()
        eng = TencentdbContextEngine(client=fake)
        eng.after_tool_call(
            tool_name="search",
            tool_call_id="toolu_abc",
            params={"q": "find x"},
            result={"hits": 1},
            error=None,
            session_key="s-ingest2",
            duration_ms=123,
        )
        self.assertEqual(len(fake.calls), 1)
        call = fake.calls[0]
        self.assertEqual(call["path"], "/v2/offload/ingest")
        self.assertEqual(call["body"]["tool_name"], "search")
        self.assertEqual(call["body"]["tool_call_id"], "toolu_abc")
        self.assertEqual(call["body"]["params"], {"q": "find x"})
        self.assertEqual(call["body"]["result"], {"hits": 1})
        self.assertIsNone(call["body"]["error"])
        self.assertEqual(call["body"]["session_key"], "s-ingest2")
        self.assertEqual(call["body"]["duration_ms"], 123)

    def test_after_tool_call_fallback_counter(self) -> None:
        fake = _FakeClient(raise_on_ingest=RuntimeError("boom"))
        eng = TencentdbContextEngine(client=fake)
        eng.after_tool_call(
            tool_name="a",
            tool_call_id="id1",
            result="r",
            session_key="s-ing-fb",
        )
        self.assertEqual(eng.fallback_counts.get("s-ing-fb"), 1)


class ClientPassthroughTests(unittest.TestCase):
    def test_post_json_passes_path_with_and_without_leading_slash(self) -> None:
        recorded: List[Dict[str, Any]] = []

        class _CaptureClient(MemoryTencentdbSdkClient):
            def _post(self, path, body, timeout=None):
                recorded.append({"path": path, "body": body, "timeout": timeout})
                return {"ok": True}

            def _get(self, path, timeout=None):  # pragma: no cover - unused
                return {}

        c = _CaptureClient()
        c.post_json("foo/bar", {"a": 1}, timeout=7)
        c.post_json("/baz", {"b": 2})
        self.assertEqual(recorded[0]["path"], "/foo/bar")
        self.assertEqual(recorded[0]["body"], {"a": 1})
        self.assertEqual(recorded[0]["timeout"], 7)
        self.assertEqual(recorded[1]["path"], "/baz")

    def test_get_json_normalizes_leading_slash(self) -> None:
        recorded: List[Dict[str, Any]] = []

        class _CaptureClient(MemoryTencentdbSdkClient):
            def _post(self, path, body, timeout=None):  # pragma: no cover - unused
                return {}

            def _get(self, path, timeout=None):
                recorded.append({"path": path, "timeout": timeout})
                return {"ok": True}

        c = _CaptureClient()
        c.get_json("health", timeout=2)
        c.get_json("/health")
        self.assertEqual(recorded[0]["path"], "/health")
        self.assertEqual(recorded[0]["timeout"], 2)
        self.assertEqual(recorded[1]["path"], "/health")


if __name__ == "__main__":
    unittest.main()
