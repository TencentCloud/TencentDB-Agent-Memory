"""Tests for TdaiMemoryService (skipped when google-adk is not installed).

Run from the repository root::

    pip install google-adk
    python -m unittest discover -s adk-plugin -t adk-plugin -v
"""

from __future__ import annotations

import asyncio
import pathlib
import sys
import unittest

_PLUGIN_ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(_PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_ROOT))

try:  # pragma: no cover - environment probe
    from google.adk.events.event import Event
    from google.adk.sessions.session import Session
    from google.genai import types

    _HAS_ADK = True
except ImportError:  # pragma: no cover
    _HAS_ADK = False

from memory_tencentdb_adk.client import TdaiGatewayClient, TdaiGatewayError  # noqa: E402
from memory_tencentdb_adk.tests.fake_gateway import FakeGateway  # noqa: E402


def _run(coro):
    return asyncio.run(coro)


@unittest.skipUnless(_HAS_ADK, "google-adk is not installed")
class TdaiMemoryServiceTest(unittest.TestCase):
    def setUp(self) -> None:
        from memory_tencentdb_adk.service import TdaiMemoryService

        self.gateway = FakeGateway().start()
        self.addCleanup(self.gateway.stop)
        self.service = TdaiMemoryService(self.gateway.base_url)
        self._event_seq = 0

    # -- fixtures -------------------------------------------------------------

    def _event(self, author: str, text: str) -> "Event":
        self._event_seq += 1
        return Event(
            id=f"e{self._event_seq}",
            invocation_id=f"inv{self._event_seq}",
            author=author,
            content=types.Content(
                role="user" if author == "user" else "model",
                parts=[types.Part(text=text)],
            ),
        )

    def _session(self, events) -> "Session":
        return Session(
            id="s1",
            app_name="demo-app",
            user_id="alice",
            events=list(events),
        )

    # -- ingestion -------------------------------------------------------------

    def test_add_session_captures_each_turn(self) -> None:
        session = self._session(
            [
                self._event("user", "I prefer window seats"),
                self._event("travel-agent", "Noted — window seats it is."),
                self._event("user", "Book Tokyo for March"),
                self._event("travel-agent", "Booked!"),
            ]
        )
        _run(self.service.add_session_to_memory(session))

        bodies = self.gateway.bodies("/capture")
        self.assertEqual(len(bodies), 2)
        self.assertEqual(bodies[0]["user_content"], "I prefer window seats")
        self.assertEqual(bodies[0]["session_key"], "adk:demo-app:alice:s1")
        self.assertEqual(bodies[0]["session_id"], "s1")
        self.assertEqual(bodies[0]["user_id"], "alice")
        self.assertEqual(bodies[1]["assistant_content"], "Booked!")

    def test_repeated_ingestion_is_idempotent(self) -> None:
        events = [
            self._event("user", "hello"),
            self._event("agent", "hi there"),
        ]
        session = self._session(events)
        _run(self.service.add_session_to_memory(session))
        _run(self.service.add_session_to_memory(session))
        self.assertEqual(len(self.gateway.bodies("/capture")), 1)

        # A grown session only captures the new turn.
        session.events.extend(
            [
                self._event("user", "one more thing"),
                self._event("agent", "sure"),
            ]
        )
        _run(self.service.add_session_to_memory(session))
        bodies = self.gateway.bodies("/capture")
        self.assertEqual(len(bodies), 2)
        self.assertEqual(bodies[1]["user_content"], "one more thing")

    def test_add_events_delta(self) -> None:
        events = [
            self._event("user", "delta question"),
            self._event("agent", "delta answer"),
        ]
        _run(
            self.service.add_events_to_memory(
                app_name="demo-app",
                user_id="alice",
                events=events,
                session_id="s9",
            )
        )
        [body] = self.gateway.bodies("/capture")
        self.assertEqual(body["session_key"], "adk:demo-app:alice:s9")

    def test_capture_failure_is_swallowed_and_retried_next_time(self) -> None:
        self.gateway.status_overrides["/capture"] = 500
        session = self._session(
            [self._event("user", "q"), self._event("agent", "a")]
        )
        _run(self.service.add_session_to_memory(session))  # fail-open: no raise
        self.assertEqual(len(self.gateway.bodies("/capture")), 1)

        # Gateway recovers — the same turn is captured on the next ingestion
        # because the dedup marks were rolled back.
        del self.gateway.status_overrides["/capture"]
        _run(self.service.add_session_to_memory(session))
        self.assertEqual(len(self.gateway.bodies("/capture")), 2)

    def test_capture_failure_raises_in_strict_mode(self) -> None:
        from memory_tencentdb_adk.service import TdaiMemoryService

        strict = TdaiMemoryService(self.gateway.base_url, strict=True)
        self.gateway.status_overrides["/capture"] = 500
        session = self._session(
            [self._event("user", "q"), self._event("agent", "a")]
        )
        with self.assertRaises(TdaiGatewayError):
            _run(strict.add_session_to_memory(session))

    # -- search ----------------------------------------------------------------

    def test_search_memory_maps_result_blobs_to_entries(self) -> None:
        self.gateway.responses["/search/memories"] = {
            "results": "- user prefers window seats",
            "total": 1,
            "strategy": "vector",
        }
        self.gateway.responses["/search/conversations"] = {
            "results": "[2026-07-20] user: Book Tokyo for March",
            "total": 1,
        }
        response = _run(
            self.service.search_memory(app_name="demo-app", user_id="alice", query="seats")
        )
        self.assertEqual(len(response.memories), 2)

        first, second = response.memories
        self.assertEqual(first.author, "memory-tencentdb")
        self.assertIn("window seats", first.content.parts[0].text)
        self.assertEqual(first.custom_metadata["tdai.source"], "memories")
        self.assertEqual(first.custom_metadata["tdai.strategy"], "vector")
        self.assertEqual(second.custom_metadata["tdai.source"], "conversations")

        [memories_body] = self.gateway.bodies("/search/memories")
        self.assertEqual(memories_body["query"], "seats")
        self.assertEqual(memories_body["limit"], 5)

    def test_search_memory_empty_results_produce_no_entries(self) -> None:
        response = _run(
            self.service.search_memory(app_name="demo-app", user_id="alice", query="anything")
        )
        self.assertEqual(response.memories, [])

    def test_search_memory_fail_open_on_dead_gateway(self) -> None:
        from memory_tencentdb_adk.service import TdaiMemoryService

        service = TdaiMemoryService(
            client=TdaiGatewayClient("http://127.0.0.1:1", timeout=0.5)
        )
        response = _run(
            service.search_memory(app_name="demo-app", user_id="alice", query="q")
        )
        self.assertEqual(response.memories, [])

    def test_search_memory_strict_raises_on_dead_gateway(self) -> None:
        from memory_tencentdb_adk.service import TdaiMemoryService

        service = TdaiMemoryService(
            strict=True,
            client=TdaiGatewayClient("http://127.0.0.1:1", timeout=0.5),
        )
        with self.assertRaises(TdaiGatewayError):
            _run(service.search_memory(app_name="demo-app", user_id="alice", query="q"))

    def test_search_memory_conversations_can_be_disabled(self) -> None:
        from memory_tencentdb_adk.service import TdaiMemoryService

        service = TdaiMemoryService(self.gateway.base_url, include_conversations=False)
        _run(service.search_memory(app_name="demo-app", user_id="alice", query="q"))
        self.assertEqual(self.gateway.bodies("/search/conversations"), [])

    # -- session lifecycle -------------------------------------------------------

    def test_end_session_flushes(self) -> None:
        _run(
            self.service.end_session(app_name="demo-app", user_id="alice", session_id="s1")
        )
        [body] = self.gateway.bodies("/session/end")
        self.assertEqual(body["session_key"], "adk:demo-app:alice:s1")
        self.assertEqual(body["user_id"], "alice")


if __name__ == "__main__":
    unittest.main()
