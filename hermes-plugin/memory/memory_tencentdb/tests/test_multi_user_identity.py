"""Tests for the per-turn user identity chain (multi-user stores).

The Gateway routes every request to a per-user store based on the ``user_id``
field, so the provider must send the identity of the user who is actually
talking THIS turn. Locks in:

  1. ``on_turn_start`` records the normalized turn author and CLEARS the
     recorded identity on bot turns / missing / invalid author ids
     (fail-closed).
  2. ``sync_turn`` snapshots ``turn_author.id`` at call time — the background
     capture thread must not re-read ``_current_user``, which the next turn
     may already have overwritten.
  3. Capture/recall/search/end_session resolve user_id through one
     authoritative chain: turn_author snapshot → ``_current_user`` →
     ``_user_id`` → omit the field entirely (Gateway default pool).
  4. ``_normalize_user_id`` has the exact same semantics as the Gateway's
     ``normalizeUserId`` (src/utils/user-id.ts): lowercase(trim(raw)) fully
     matched against ``^[a-z0-9_-]{1,64}$``, never character-stripped.
  5. ``search_memories`` / ``search_conversations`` include ``user_id`` in
     the JSON body only when a value exists.

These tests use mocks for the supervisor / client so they neither spawn real
Node processes nor open network sockets (same style as the recovery suite).
"""

from __future__ import annotations

import inspect
import json
import threading
import time
from unittest.mock import MagicMock

import pytest

# The plugins alias + agent package (real checkout or the stub tree next to
# this file) are wired up by hermes-plugin/memory/conftest.py; see it for why
# the bootstrap must run before this import.
from plugins.memory.memory_tencentdb import MemoryTencentdbProvider, _normalize_user_id
from plugins.memory.memory_tencentdb.client import MemoryTencentdbSdkClient


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class FakeSupervisor:
    """In-memory stand-in for GatewaySupervisor (mirrors the recovery suite)."""

    def __init__(self) -> None:
        self.alive = True
        self.healthy = True
        self.respawn_succeeds = True
        self.client = MagicMock(name="MemoryTencentdbSdkClient")
        self.ensure_running_calls = 0
        self.is_running_calls = 0
        self.is_process_alive_calls = 0
        self.shutdown_calls = 0

    def is_running(self) -> bool:
        self.is_running_calls += 1
        return self.healthy

    def is_process_alive(self) -> bool:
        self.is_process_alive_calls += 1
        return self.alive

    def ensure_running(self) -> bool:
        self.ensure_running_calls += 1
        if self.respawn_succeeds:
            self.alive = True
            self.healthy = True
            return True
        return False

    def shutdown(self) -> None:
        self.shutdown_calls += 1
        self.alive = False
        self.healthy = False


def _wait_until(predicate, *, timeout: float = 3.0, interval: float = 0.02) -> bool:
    """Poll ``predicate`` until it returns truthy or ``timeout`` elapses."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


@pytest.fixture()
def fast_watchdog(monkeypatch):
    """Collapse watchdog cadence so teardown joins are snappy."""
    import plugins.memory.memory_tencentdb as mod

    monkeypatch.setattr(mod, "_WATCHDOG_INTERVAL_SECS", 0.05)
    monkeypatch.setattr(mod, "_WATCHDOG_SHUTDOWN_TIMEOUT_SECS", 0.5)
    monkeypatch.setattr(mod, "_RECOVER_COOLDOWN_SECS", 0)
    yield


@pytest.fixture()
def provider_with_fake_supervisor(monkeypatch, fast_watchdog):
    """Yield a provider wired to a FakeSupervisor with a MagicMock client."""
    import plugins.memory.memory_tencentdb as mod

    fake = FakeSupervisor()

    def _factory(*args, **kwargs):
        return fake

    monkeypatch.setattr(mod, "GatewaySupervisor", _factory)
    monkeypatch.setenv("MEMORY_TENCENTDB_GATEWAY_CMD", "fake-cmd")

    provider = MemoryTencentdbProvider()
    provider.initialize(session_id="identity-session", user_id="test-user")
    provider._fake = fake  # attach for test access

    assert _wait_until(lambda: provider._gateway_available, timeout=2.0)

    try:
        yield provider
    finally:
        provider.shutdown()


# ---------------------------------------------------------------------------
# signature probe: Hermes filters hook kwargs by the provider's signature
# ---------------------------------------------------------------------------


def test_on_turn_start_signature_declares_author_trio_explicitly():
    """Hermes' MemoryManager inspects the provider signature and only fans out
    the author kwargs it explicitly declares. If a future refactor renames one
    of these parameters — or swallows them into ``**kwargs`` — the identity
    would silently degrade to the static fallback id (every user mixed into
    one pool) while every behavioural test above stays green. This probe makes
    that rename fail loudly instead."""
    params = inspect.signature(MemoryTencentdbProvider.on_turn_start).parameters
    for name in ("author_id", "author_name", "author_is_bot"):
        assert name in params, (
            f"on_turn_start must explicitly declare '{name}': Hermes passes "
            "author kwargs only when the provider signature names them"
        )
    for name, param in params.items():
        assert param.kind is not inspect.Parameter.VAR_KEYWORD, (
            f"parameter '{name}' must not be **kwargs: Hermes filters by "
            "explicit parameter names, so **kwargs silently receives nothing"
        )


def test_sync_turn_signature_declares_turn_author():
    """``turn_author`` must remain an explicit (keyword-only) sync_turn
    parameter for the same reason: the per-turn capture attribution chain
    starts with Hermes passing this kwarg by name."""
    params = inspect.signature(MemoryTencentdbProvider.sync_turn).parameters
    assert "turn_author" in params, (
        "sync_turn must explicitly declare 'turn_author': Hermes passes it "
        "only when the provider signature names it"
    )
    assert params["turn_author"].kind is inspect.Parameter.KEYWORD_ONLY


# ---------------------------------------------------------------------------
# on_turn_start: record / clear the per-turn identity
# ---------------------------------------------------------------------------


def test_on_turn_start_records_normalized_author(provider_with_fake_supervisor):
    provider = provider_with_fake_supervisor

    provider.on_turn_start(1, "hello", author_id="  Alice ", author_name="Alice")

    assert provider._current_user == "alice"


def test_on_turn_start_bot_turn_clears_identity(provider_with_fake_supervisor):
    """author_is_bot=True must CLEAR the identity, keeping no stale speaker."""
    provider = provider_with_fake_supervisor

    provider.on_turn_start(1, "hello", author_id="Alice")
    assert provider._current_user == "alice"

    provider.on_turn_start(2, "hello", author_id="assistant-bot", author_is_bot=True)

    assert provider._current_user is None


def test_on_turn_start_missing_author_clears_identity(provider_with_fake_supervisor):
    provider = provider_with_fake_supervisor

    provider.on_turn_start(1, "hello", author_id="Alice")
    assert provider._current_user == "alice"

    provider.on_turn_start(2, "hello")  # no author kwargs at all

    assert provider._current_user is None


def test_on_turn_start_invalid_author_clears_identity(provider_with_fake_supervisor):
    """An author id the Gateway would reject must not be sent as-is."""
    provider = provider_with_fake_supervisor

    provider.on_turn_start(1, "hello", author_id="wendy.li")

    assert provider._current_user is None


# ---------------------------------------------------------------------------
# sync_turn: turn_author.id snapshot beats a later-overwritten _current_user
# ---------------------------------------------------------------------------


def test_capture_snapshot_survives_current_user_overwrite(provider_with_fake_supervisor):
    """The core race: turn N's capture must attribute to turn N's author even
    when turn N+1's on_turn_start rewrites _current_user before the capture
    background thread finishes."""
    provider = provider_with_fake_supervisor
    fake = provider._fake
    provider._stop_watchdog()

    capture_started = threading.Event()
    release_capture = threading.Event()

    def _blocking_capture(**kwargs):
        capture_started.set()
        release_capture.wait(timeout=5.0)
        return {"ok": True}

    fake.client.capture.side_effect = _blocking_capture

    # Turn 1: Alice speaks; sync_turn snapshots her id and spawns the capture.
    provider.on_turn_start(1, "question one", author_id="Alice")
    provider.sync_turn("u1", "a1", turn_author={"id": "Alice", "is_bot": False})

    assert capture_started.wait(timeout=2.0), "capture never started"

    # Turn 2 begins BEFORE turn 1's capture callback finished: the recorded
    # identity is overwritten, but the in-flight capture must keep Alice.
    provider.on_turn_start(2, "question two", author_id="Bob")
    assert provider._current_user == "bob", "scenario setup: overwrite must happen"

    release_capture.set()
    assert _wait_until(
        lambda: fake.client.capture.call_args is not None
        and fake.client.capture.call_args.kwargs.get("user_id") == "alice"
    )

    assert fake.client.capture.call_args.kwargs["user_id"] == "alice", (
        "capture was re-attributed to the next turn's author; turn_author.id "
        "must be snapshotted at sync_turn() call time"
    )


def test_capture_uses_turn_author_over_current_user(provider_with_fake_supervisor):
    """A valid turn_author wins even when it differs from _current_user."""
    provider = provider_with_fake_supervisor
    fake = provider._fake
    provider._stop_watchdog()
    capture_called = threading.Event()
    fake.client.capture.side_effect = lambda **kw: capture_called.set()

    provider.on_turn_start(1, "hello", author_id="Alice")
    provider.sync_turn("u", "a", turn_author={"id": "Carol", "is_bot": False})

    assert capture_called.wait(timeout=2.0)
    assert fake.client.capture.call_args.kwargs["user_id"] == "carol"


def test_capture_accepts_turn_author_without_is_bot_key(provider_with_fake_supervisor):
    """Hermes may pass a bare {id, name} dict; absence of is_bot = human."""
    provider = provider_with_fake_supervisor
    fake = provider._fake
    provider._stop_watchdog()
    capture_called = threading.Event()
    fake.client.capture.side_effect = lambda **kw: capture_called.set()

    provider.sync_turn("u", "a", turn_author={"id": "Carol", "name": "Carol"})

    assert capture_called.wait(timeout=2.0)
    assert fake.client.capture.call_args.kwargs["user_id"] == "carol"


def test_capture_uses_current_user_without_turn_author(provider_with_fake_supervisor):
    """Chain step 2: no turn_author → the on_turn_start identity is used."""
    provider = provider_with_fake_supervisor
    fake = provider._fake
    provider._stop_watchdog()
    capture_called = threading.Event()
    fake.client.capture.side_effect = lambda **kw: capture_called.set()

    provider.on_turn_start(1, "hello", author_id="Alice")
    provider.sync_turn("u", "a")

    assert capture_called.wait(timeout=2.0)
    assert fake.client.capture.call_args.kwargs["user_id"] == "alice"


def test_capture_falls_back_to_static_user_id(provider_with_fake_supervisor):
    """Chain step 3: bot turn_author and cleared identity → static fallback."""
    provider = provider_with_fake_supervisor
    fake = provider._fake
    provider._stop_watchdog()
    capture_called = threading.Event()
    fake.client.capture.side_effect = lambda **kw: capture_called.set()

    provider.sync_turn("u", "a", turn_author={"id": "some-bot", "is_bot": True})

    assert capture_called.wait(timeout=2.0)
    assert fake.client.capture.call_args.kwargs["user_id"] == "test-user"


def test_capture_falls_back_when_turn_author_id_invalid(provider_with_fake_supervisor):
    """An invalid turn_author.id must never reach the Gateway as-is."""
    provider = provider_with_fake_supervisor
    fake = provider._fake
    provider._stop_watchdog()
    capture_called = threading.Event()
    fake.client.capture.side_effect = lambda **kw: capture_called.set()

    provider.sync_turn("u", "a", turn_author={"id": "wendy.li", "is_bot": False})

    assert capture_called.wait(timeout=2.0)
    assert fake.client.capture.call_args.kwargs["user_id"] == "test-user"


def test_capture_omits_user_id_when_chain_empty(provider_with_fake_supervisor):
    """Chain step 4: no identity anywhere → empty string (client omits field)."""
    provider = provider_with_fake_supervisor
    fake = provider._fake
    provider._stop_watchdog()
    provider._user_id = ""  # simulate no static fallback injected
    capture_called = threading.Event()
    fake.client.capture.side_effect = lambda **kw: capture_called.set()

    provider.sync_turn("u", "a")

    assert capture_called.wait(timeout=2.0)
    assert fake.client.capture.call_args.kwargs["user_id"] == ""


# ---------------------------------------------------------------------------
# prefetch (recall path) chain
# ---------------------------------------------------------------------------


def test_recall_prefers_current_user(provider_with_fake_supervisor):
    provider = provider_with_fake_supervisor
    fake = provider._fake
    fake.client.recall.return_value = {"context": "ctx"}

    provider.on_turn_start(1, "hello", author_id="Alice")
    provider.prefetch(query="hello")

    assert fake.client.recall.call_args.kwargs["user_id"] == "alice"


def test_recall_falls_back_to_static_user_id_after_bot_turn(provider_with_fake_supervisor):
    provider = provider_with_fake_supervisor
    fake = provider._fake
    fake.client.recall.return_value = {"context": "ctx"}

    provider.on_turn_start(1, "hello", author_id="Alice")
    provider.on_turn_start(2, "hello", author_id="bot", author_is_bot=True)
    provider.prefetch(query="hello")

    assert fake.client.recall.call_args.kwargs["user_id"] == "test-user"


def test_recall_omits_user_id_when_chain_empty(provider_with_fake_supervisor):
    provider = provider_with_fake_supervisor
    fake = provider._fake
    fake.client.recall.return_value = {"context": ""}
    provider._user_id = ""

    provider.prefetch(query="hello")

    assert fake.client.recall.call_args.kwargs["user_id"] == ""


# ---------------------------------------------------------------------------
# tool-call search path chain
# ---------------------------------------------------------------------------


def test_memory_search_tool_passes_user_id(provider_with_fake_supervisor):
    provider = provider_with_fake_supervisor
    fake = provider._fake
    fake.client.search_memories.return_value = {"results": []}

    provider.on_turn_start(1, "hello", author_id="Alice")
    out = provider.handle_tool_call("memory_tencentdb_memory_search", {"query": "q"})

    assert "error" not in json.loads(out)
    assert fake.client.search_memories.call_args.kwargs["user_id"] == "alice"


def test_conversation_search_tool_passes_user_id(provider_with_fake_supervisor):
    provider = provider_with_fake_supervisor
    fake = provider._fake
    fake.client.search_conversations.return_value = {"results": []}

    provider.on_turn_start(1, "hello", author_id="Alice")
    out = provider.handle_tool_call("memory_tencentdb_conversation_search", {"query": "q"})

    assert "error" not in json.loads(out)
    assert fake.client.search_conversations.call_args.kwargs["user_id"] == "alice"


# ---------------------------------------------------------------------------
# end_session chain (both call sites)
# ---------------------------------------------------------------------------


def test_on_session_end_uses_current_user(provider_with_fake_supervisor):
    provider = provider_with_fake_supervisor
    fake = provider._fake

    provider.on_turn_start(1, "hello", author_id="Alice")
    provider.on_session_end([])

    assert fake.client.end_session.call_args.kwargs["user_id"] == "alice"


def test_shutdown_end_session_uses_current_user(provider_with_fake_supervisor):
    provider = provider_with_fake_supervisor
    fake = provider._fake
    # Detach the fixture's teardown shutdown: this test owns the shutdown.
    provider._stop_watchdog()

    provider.on_turn_start(1, "hello", author_id="Alice")
    provider.shutdown()

    assert fake.client.end_session.call_args.kwargs["user_id"] == "alice"


def test_shutdown_end_session_falls_back_without_identity(provider_with_fake_supervisor):
    provider = provider_with_fake_supervisor
    fake = provider._fake
    provider._stop_watchdog()
    provider.on_turn_start(1, "hello", author_id="bot", author_is_bot=True)

    provider.shutdown()

    assert fake.client.end_session.call_args.kwargs["user_id"] == "test-user"


# ---------------------------------------------------------------------------
# _normalize_user_id — parity with the Gateway (src/utils/user-id.test.ts)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        # lowercases and trims valid ids
        ("Wendy", "wendy"),
        ("  Wendy  ", "wendy"),
        ("WENDY_1", "wendy_1"),
        # hyphens, underscores and digits
        ("wendy-li", "wendy-li"),
        ("user_01", "user_01"),
        ("a", "a"),
        # 64-char boundary accepted
        ("a" * 64, "a" * 64),
        # 65 chars rejected
        ("a" * 65, None),
        # dots rejected (wendy.li and wendyli must never collide), no stripping
        ("wendy.li", None),
        ("wendyli", "wendyli"),
        # empty / whitespace-only
        ("", None),
        ("   ", None),
        # Unicode whitespace is NOT trimmed (ASCII-only trim, paired with the
        # Gateway's /^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g): a bare Python
        # strip() would eat U+FEFF and accept an id the Gateway rejects.
        ("\ufeffwendy", None),
        ("wendy\u00a0", None),
        # ASCII whitespace still trims
        ("\t\nwendy\r\n", "wendy"),
        # non-ASCII
        ("王芳", None),
        ("wèndy", None),
        # path-like (fail-closed)
        ("../", None),
        ("..", None),
        ("a/b", None),
        (".", None),
        # non-string input
        (None, None),
        (42, None),
        (True, None),
        ({"id": "wendy"}, None),
        (["wendy"], None),
    ],
)
def test_normalize_user_id_matches_gateway_semantics(raw, expected):
    assert _normalize_user_id(raw) == expected


# ---------------------------------------------------------------------------
# client: search request bodies carry user_id only when a value exists
# ---------------------------------------------------------------------------


@pytest.fixture()
def capture_post(monkeypatch):
    """Intercept MemoryTencentdbSdkClient._post and record (path, body)."""
    client = MemoryTencentdbSdkClient(base_url="http://127.0.0.1:1", timeout=1)
    calls = []

    def _fake_post(path, body, timeout=None):
        calls.append((path, dict(body)))
        return {"ok": True}

    monkeypatch.setattr(client, "_post", _fake_post)
    return client, calls


def test_search_memories_body_includes_user_id(capture_post):
    client, calls = capture_post

    client.search_memories(query="q", limit=3, type_filter="persona", user_id="alice")

    path, body = calls[0]
    assert path == "/search/memories"
    assert body["user_id"] == "alice"
    assert body["type"] == "persona"
    assert body["limit"] == 3


def test_search_memories_body_omits_user_id_when_absent(capture_post):
    client, calls = capture_post

    client.search_memories(query="q")

    _, body = calls[0]
    assert "user_id" not in body


def test_search_conversations_body_includes_user_id(capture_post):
    client, calls = capture_post

    client.search_conversations(query="q", session_key="sess", user_id="bob")

    path, body = calls[0]
    assert path == "/search/conversations"
    assert body["user_id"] == "bob"
    assert body["session_key"] == "sess"


def test_search_conversations_body_omits_user_id_when_absent(capture_post):
    client, calls = capture_post

    client.search_conversations(query="q")

    _, body = calls[0]
    assert "user_id" not in body
