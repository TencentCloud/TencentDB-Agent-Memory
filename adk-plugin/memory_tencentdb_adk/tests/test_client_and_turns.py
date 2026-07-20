"""Unit tests for the Gateway client and turn pairing (no google-adk needed).

Run from the repository root::

    python -m unittest discover -s adk-plugin -t adk-plugin -v
"""

from __future__ import annotations

import pathlib
import sys
import unittest
from dataclasses import dataclass, field
from typing import List, Optional

_PLUGIN_ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(_PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_ROOT))

from memory_tencentdb_adk.client import TdaiGatewayClient, TdaiGatewayError  # noqa: E402
from memory_tencentdb_adk.turns import pair_turns, text_of_event  # noqa: E402
from memory_tencentdb_adk.tests.fake_gateway import FakeGateway  # noqa: E402


# ---------------------------------------------------------------------------
# Duck-typed stand-ins for google.adk / google.genai event shapes
# ---------------------------------------------------------------------------


@dataclass
class _Part:
    text: Optional[str] = None


@dataclass
class _Content:
    parts: List[_Part] = field(default_factory=list)


@dataclass
class _Event:
    author: str = ""
    content: Optional[_Content] = None
    id: str = ""


def _ev(author: str, text: Optional[str], event_id: str = "") -> _Event:
    parts = [_Part(text=text)] if text is not None else []
    return _Event(author=author, content=_Content(parts=parts), id=event_id)


# ---------------------------------------------------------------------------
# Turn pairing
# ---------------------------------------------------------------------------


class PairTurnsTest(unittest.TestCase):
    def test_simple_pair(self) -> None:
        turns = pair_turns([_ev("user", "hi", "u1"), _ev("agent", "hello!", "a1")])
        self.assertEqual(len(turns), 1)
        self.assertEqual(turns[0].user_text, "hi")
        self.assertEqual(turns[0].assistant_text, "hello!")
        self.assertEqual(turns[0].event_ids, ["u1", "a1"])
        self.assertEqual(
            turns[0].messages,
            [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "hello!"},
            ],
        )

    def test_multiple_agent_events_merge_into_one_turn(self) -> None:
        turns = pair_turns(
            [
                _ev("user", "plan a trip", "u1"),
                _ev("planner", "step 1", "a1"),
                _ev("booker", "step 2", "a2"),
            ]
        )
        self.assertEqual(len(turns), 1)
        self.assertEqual(turns[0].assistant_text, "step 1\n\nstep 2")
        self.assertEqual(len(turns[0].messages), 3)

    def test_two_turns(self) -> None:
        turns = pair_turns(
            [
                _ev("user", "q1", "u1"),
                _ev("agent", "a1", "e1"),
                _ev("user", "q2", "u2"),
                _ev("agent", "a2", "e2"),
            ]
        )
        self.assertEqual([(t.user_text, t.assistant_text) for t in turns], [("q1", "a1"), ("q2", "a2")])

    def test_unanswered_user_message_is_dropped(self) -> None:
        turns = pair_turns([_ev("user", "q1", "u1"), _ev("user", "q2", "u2"), _ev("agent", "a2", "e2")])
        self.assertEqual(len(turns), 1)
        self.assertEqual(turns[0].user_text, "q2")

    def test_leading_assistant_text_is_skipped(self) -> None:
        turns = pair_turns([_ev("agent", "welcome!", "a0"), _ev("user", "hi", "u1"), _ev("agent", "hello", "a1")])
        self.assertEqual(len(turns), 1)
        self.assertEqual(turns[0].user_text, "hi")

    def test_tool_only_events_are_ignored(self) -> None:
        turns = pair_turns(
            [
                _ev("user", "compute", "u1"),
                _Event(author="agent", content=_Content(parts=[])),  # function call only
                _ev("agent", "42", "a1"),
            ]
        )
        self.assertEqual(len(turns), 1)
        self.assertEqual(turns[0].assistant_text, "42")

    def test_empty_session(self) -> None:
        self.assertEqual(pair_turns([]), [])

    def test_text_of_event_joins_and_strips(self) -> None:
        event = _Event(author="agent", content=_Content(parts=[_Part("  a  "), _Part(None), _Part("b")]))
        self.assertEqual(text_of_event(event), "a\nb")
        self.assertEqual(text_of_event(_Event(author="agent", content=None)), "")


# ---------------------------------------------------------------------------
# Gateway client against the fake gateway
# ---------------------------------------------------------------------------


class ClientTest(unittest.TestCase):
    def setUp(self) -> None:
        self.gateway = FakeGateway().start()
        self.addCleanup(self.gateway.stop)
        self.client = TdaiGatewayClient(self.gateway.base_url)

    def test_health(self) -> None:
        self.assertEqual(self.client.health()["status"], "ok")
        self.assertTrue(self.client.is_healthy())

    def test_capture_payload_shape(self) -> None:
        result = self.client.capture(
            "hi",
            "hello",
            "adk:app:user:s1",
            session_id="s1",
            user_id="user",
            messages=[{"role": "user", "content": "hi"}],
        )
        self.assertEqual(result["l0_recorded"], 2)
        [body] = self.gateway.bodies("/capture")
        self.assertEqual(body["user_content"], "hi")
        self.assertEqual(body["assistant_content"], "hello")
        self.assertEqual(body["session_key"], "adk:app:user:s1")
        self.assertEqual(body["session_id"], "s1")
        self.assertEqual(body["user_id"], "user")
        self.assertEqual(body["messages"], [{"role": "user", "content": "hi"}])

    def test_search_memories_optional_fields_omitted(self) -> None:
        self.client.search_memories("query")
        [body] = self.gateway.bodies("/search/memories")
        self.assertEqual(body, {"query": "query"})

    def test_search_conversations_with_limit(self) -> None:
        self.client.search_conversations("query", limit=3, session_key="k")
        [body] = self.gateway.bodies("/search/conversations")
        self.assertEqual(body, {"query": "query", "limit": 3, "session_key": "k"})

    def test_session_end(self) -> None:
        self.assertEqual(self.client.session_end("k", "u"), {"flushed": True})
        [body] = self.gateway.bodies("/session/end")
        self.assertEqual(body, {"session_key": "k", "user_id": "u"})

    def test_http_error_raises_typed_error_with_status(self) -> None:
        self.gateway.status_overrides["/recall"] = 500
        with self.assertRaises(TdaiGatewayError) as ctx:
            self.client.recall("q", "k")
        self.assertEqual(ctx.exception.status, 500)

    def test_unreachable_gateway_raises_typed_error(self) -> None:
        dead = TdaiGatewayClient("http://127.0.0.1:1", timeout=0.5)
        with self.assertRaises(TdaiGatewayError) as ctx:
            dead.health(timeout=0.5)
        self.assertIsNone(ctx.exception.status)
        self.assertFalse(dead.is_healthy())


class ClientAuthTest(unittest.TestCase):
    def setUp(self) -> None:
        self.gateway = FakeGateway(api_key="secret-key").start()
        self.addCleanup(self.gateway.stop)

    def test_bearer_token_attached(self) -> None:
        client = TdaiGatewayClient(self.gateway.base_url, api_key="secret-key")
        self.assertEqual(client.session_end("k"), {"flushed": True})

    def test_missing_token_rejected(self) -> None:
        client = TdaiGatewayClient(self.gateway.base_url)
        with self.assertRaises(TdaiGatewayError) as ctx:
            client.session_end("k")
        self.assertEqual(ctx.exception.status, 401)

    def test_whitespace_token_treated_as_unset(self) -> None:
        client = TdaiGatewayClient(self.gateway.base_url, api_key="   ")
        with self.assertRaises(TdaiGatewayError):
            client.session_end("k")

    def test_health_never_requires_auth(self) -> None:
        client = TdaiGatewayClient(self.gateway.base_url)
        self.assertEqual(client.health()["status"], "ok")


if __name__ == "__main__":
    unittest.main()
