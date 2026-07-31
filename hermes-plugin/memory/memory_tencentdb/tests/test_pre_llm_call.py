"""Tests for the Hermes v0.18.0+ ``pre_llm_call`` hook.

Covers the full chain introduced by the fix for #550:

  * Plugin contract (provider  ××××:
  1. ``MemoryTencentdbProvider`` exposes a ``pre_llm_call`` method whose
     whose (shape matches the Hermes hook signature and that Hermes will dispatch by
     after plugin.yaml registers the hook.
  2. Fail-open semantics: Gateway unreachable / timeout / malformed response all
     return ``None`` (keep original messages unchanged) so the LLM hot path never
     stalls.
  3. Success path: Gateway returns ``{messages, stats}`` → provider forwards the
     returned message list.
  4. Response-shape guards: non-dict / missing-``messages`` / non-list
     ``messages`` all fall back to fail-open.
  5. Empty input list short-circuits and does not touch the client at all.
  6. ``_ensure_alive_for_request`` returning False → silent skip.

  * Client (``MemoryTencentdbSdkClient.before_prompt_build``:
  7. Issues ``POST /before_prompt_build`` with the correct URL.
  8. Body contains ``messages``, ``session_key`` and optional ``user_id``.
  9. Effective timeout is capped at 8 seconds (the hot-path safety bound, clamped to
     the provider timeout or the caller value, whichever is smaller.
 10. 4xx / 5xx / network errors propagate as exceptions (so the provider's
     fail-open catches them).

All tests mock all tests use mocks; no real Node process or real socket.
"""

from __future__ import annotations

import json
import pathlib
import sys
from typing import Any, Dict, List
from unittest.mock import MagicMock, patch

import pytest

# Inject plugin roots so we match the layout pattern used by
# ``test_memory_tencentdb_recovery.py`` next door.
_THIS_FILE = pathlib.Path(__file__).resolve()
_HERE = _THIS_FILE.parent
for candidate in (
    _HERE.parents[3] if len(_HERE.parents) >= 4 else None,
    _HERE.parents[4] if len(_HERE.parents) >= 5 else None,
    _HERE.parents[2] if len(_HERE.parents) >= 3 else None,
):
    if candidate is not None and (candidate / "plugins").is_dir():
        if str(candidate) not in sys.path:
            sys.path.insert(0, str(candidate))

try:
    from plugins.memory.memory_tencentdb import MemoryTencentdbProvider
    from plugins.memory.memory_tencentdb.client import MemoryTencentdbSdkClient
except ImportError as e:  # pragma: no cover
    pytest.skip(
        f"memory_tencentdb provider not importable ({e})",
        allow_module_level=True,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class FakeSupervisor:
    """Minimal supervisor stand-in (mirrors the one in test_memory_tencentdb_recovery.py).

    We only expose what ``pre_llm_call`` actually inspects: ``client`` + ensure_running()
    + is_running().
    """

    def __init__(self) -> None:
        self.alive = True
        self.client = MagicMock(name="MemoryTencentdbSdkClient")

    def is_running(self) -> bool:
        return self.alive

    def is_process_alive(self) -> bool:
        return self.alive

    def ensure_running(self) -> bool:
        self.alive = True
        return True

    def shutdown(self) -> None:
        self.alive = False


def _make_provider(monkeypatch, supervisor: FakeSupervisor) -> MemoryTencentdbProvider:
    """Build a provider wired to the given FakeSupervisor.

    Replicates the wiring from the recovery tests, stripped down to the hooks
    actually exercised in this file.
    """
    import plugins.memory.memory_tencentdb as mod

    # Collapse recovery)  cooldowns and disable the watchdog (not under test here.
    monkeypatch.setattr(mod, "_WATCHDOG_INTERVAL_SECS", 9999)
    monkeypatch.setattr(mod, "_RECOVER_COOLDOWN_SECS", 0)
    monkeypatch.setattr(
        mod, "GatewaySupervisor", lambda *a, **kw: supervisor)

    provider = MemoryTencentdbProvider()
    provider._user_id = "u-test"
    provider._session_id = "sess-123"

    # Mark the gateway up so _ensure_alive_for_request does not early-return
    # unless a test explicitly flips it.
    provider._gateway_available = True
    provider._supervisor = supervisor
    provider._client = supervisor.client
    return provider


# ---------------------------------------------------------------------------
# Provider tests
# ---------------------------------------------------------------------------


class TestPreLlmCallProvider:
    """Contract + fail-open tests for MemoryTencentdbProvider.pre_llm_call."""

    # -- contract ------------------------------------------------------------

    def test_method_exists_and_signature(self) -> None:
        """The provider exposes a ``pre_llm_call`` attribute (plugin.yaml
        registration matches the implementation)."""
        assert hasattr(MemoryTencentdbProvider, "pre_llm_call")
        import inspect
        sig = inspect.signature(MemoryTencentdbProvider.pre_llm_call)
        assert "messages" in sig.parameters
        assert "session_id" in sig.parameters

    def test_empty_messages_short_circuits(self, monkeypatch) -> None:
        """Empty message lists must not touch the network (no client call at all)."""
        supervisor = FakeSupervisor()
        provider = _make_provider(monkeypatch, supervisor)

        result = provider.pre_llm_call([], session_id="sess-x")
        assert result is None
        # client.before_prompt_build must never be called for empty input
        supervisor.client.before_prompt_build.assert_not_called()

    def test_ensure_alive_returns_false_skips(self, monkeypatch) -> None:
        """When _ensure_alive_for_request False → fail-open silently skip."""
        supervisor = FakeSupervisor()
        provider = _make_provider(monkeypatch, supervisor)
        provider._gateway_available = False
        # Force _ensure_alive_for_request short-circuits False when the
        # gateway is down and the supervisor cannot respawn.
        supervisor.alive = False
        supervisor.ensure_running = MagicMock(return_value=False)

        msgs = [{"role": "user", "content": "hi"}]
        result = provider.pre_llm_call(msgs)

        assert result is None
        supervisor.client.before_prompt_build.assert_not_called()

    # -- Fail-open: every error modes -----------------------------------------

    def test_client_raises_returns_none(self, monkeypatch) -> None:
        """Client call raises (Gateway down, timeout, DNS) → fail-open."""
        supervisor = FakeSupervisor()
        provider = _make_provider(monkeypatch, supervisor)

        def boom(*a, **kw):
            raise ConnectionError("refused")

        supervisor.client.before_prompt_build.side_effect = boom

        msgs = [{"role": "user", "content": "hello"}]
        # Must not raise.
        result = provider.pre_llm_call(msgs, session_id="s1")
        assert result is None  # fail-open: keep original
        # Failure was recorded + recovery attempted.
        assert provider._breaker_failures >= 1

    def test_non_dict_response_returns_none(self, monkeypatch) -> None:
        """Non-dict response → fail-open."""
        supervisor = FakeSupervisor()
        provider = _make_provider(monkeypatch, supervisor)
        supervisor.client.before_prompt_build.return_value = ["not", "a", "dict"]

        msgs = [{"role": "user", "content": "ping"}]
        assert provider.pre_llm_call(msgs) is None

    def test_missing_messages_key_returns_none(self, monkeypatch) -> None:
        """Response dict without 'messages' key → fail-open."""
        supervisor = FakeSupervisor()
        provider = _make_provider(monkeypatch, supervisor)
        supervisor.client.before_prompt_build.return_value = {"stats": {}}

        msgs = [{"role": "user", "content": "ping"}]
        assert provider.pre_llm_call(msgs) is None

    def test_messages_not_a_list_returns_none(self, monkeypatch) -> None:
        """Response 'messages' not a list → fail-open."""
        supervisor = FakeSupervisor()
        provider = _make_provider(monkeypatch, supervisor)
        supervisor.client.before_prompt_build.return_value = {"messages": "oops"}

        msgs = [{"role": "user", "content": "ping"}]
        assert provider.pre_llm_call(msgs) is None

    # -- Success path ---------------------------------------------------

    def test_success_returns_modified_messages(self, monkeypatch) -> None:
        """Valid response → returned list is forwarded verbatim."""
        supervisor = FakeSupervisor()
        provider = _make_provider(monkeypatch, supervisor)

        modified = [
            {"role": "system", "content": "L3 compressed"},
            {"role": "user", "content": "actual"},
        ]
        supervisor.client.before_prompt_build.return_value = {
            "messages": modified,
            "stats": {"compression_rounds": 1},
        }

        msgs = [{"role": "user", "content": "original"}]
        out = provider.pre_llm_call(msgs, session_id="s42")

        assert out is modified
        # Arguments forwarded with the right session + user.
        args, kwargs = supervisor.client.before_prompt_build.call_args
        assert args[0] is msgs
        assert kwargs["session_key"] == "s42"
        assert kwargs["user_id"] == "u-test"

    def test_session_id_falls_back_to_provider_session(self, monkeypatch) -> None:
        """Hook-level ``session_id`` kwarg is missing → use provider._session_id."""
        supervisor = FakeSupervisor()
        provider = _make_provider(monkeypatch, supervisor)
        supervisor.client.before_prompt_build.return_value = {"messages": []}

        provider.pre_llm_call([{"role": "user", "content": "x"}])

        _args, kwargs = supervisor.client.before_prompt_build.call_args
        assert kwargs["session_key"] == "sess-123"


# ---------------------------------------------------------------------------
# Client tests
# ---------------------------------------------------------------------------


class TestClientBeforePromptBuild:
    """HTTP-shape tests for MemoryTencentdbSdkClient.before_prompt_build."""

    def _make_client(self, timeout: float = 30.0) -> MemoryTencentdbSdkClient:
        return MemoryTencentdbSdkClient(
            host="127.0.0.1",
            port=18420,
            timeout=timeout,
        )

    def test_url_and_body(self) -> None:
        """Correct URL path + body fields match the contract."""
        client = self._make_client()
        captured: Dict[str, Any] = {}

        def fake_request(method, url, *, json=None, timeout=None, headers=None):
            captured["method"] = method
            captured["url"] = url
            captured["json"] = json
            captured["timeout"] = timeout
            captured["headers"] = headers
            resp = MagicMock()
            resp.status_code = 200
            resp.text = json.dumps({"messages": [1, 2, 3], "stats": {}})
            resp.json.return_value = {"messages": [1, 2, 3], "stats": {}}
            return resp

        with patch("plugins.memory.memory_tencentdb.client.requests.Session") as mock_session_cls:
            mock_sess = MagicMock()
            mock_sess.request.side_effect = fake_request
            mock_session_cls.return_value = mock_sess

            msgs = [{"role": "user", "content": "q"}]
            result = client.before_prompt_build(msgs, session_key="sk-9", user_id="u")

            assert captured["method"] == "POST"
            assert captured["url"].endswith("/before_prompt_build")
            assert captured["json"]["messages"] == msgs
            assert captured["json"]["session_key"] == "sk-9"
            assert captured["json"]["user_id"] == "u"
            # messages field is present in the response.
            assert result["messages"] == [1, 2, 3]

    def test_timeout_capped_at_8_seconds(self) -> None:
        """Regardless of client default/configured timeout >8s → 8s hot-path cap."""
        client = self._make_client(timeout=120.0)
        captured_timeout = {"t": None}

        def fake_request(method, url, *, timeout=None, **_):
            captured_timeout["t"] = timeout
            resp = MagicMock()
            resp.status_code = 200
            resp.json.return_value = {"messages": [], "stats": {}}
            return resp

        with patch("plugins.memory.memory_tencentdb.client.requests.Session") as mock_session_cls:
            mock_sess = MagicMock()
            mock_sess.request.side_effect = fake_request
            mock_session_cls.return_value = mock_sess

            client.before_prompt_build([], session_key="s")
            assert captured_timeout["t"] == 8.0

    def test_timeout_below_cap_preserved(self) -> None:
        """Client timeout already <8s → caller value preserved (no expansion)."""
        client = self._make_client(timeout=3.5)
        captured_timeout = {"t": None}

        def fake_request(method, url, *, timeout=None, **_):
            captured_timeout["t"] = timeout
            resp = MagicMock()
            resp.status_code = 200
            resp.json.return_value = {"messages": [], "stats": {}}
            return resp

        with patch("plugins.memory.memory_tencentdb.client.requests.Session") as mock_session_cls:
            mock_sess = MagicMock()
            mock_sess.request.side_effect = fake_request
            mock_session_cls.return_value = mock_sess

            client.before_prompt_build([], session_key="s")
            assert captured_timeout["t"] == 3.5

    def test_http_errors_propagate(self) -> None:
        """5xx / 4xx / non-2xx → raise (so provider fail-open catches it)."""
        client = self._make_client()

        def fake_request(*a, **kw):
            resp = MagicMock()
            resp.status_code = 502
            resp.raise_for_status.side_effect = RuntimeError("bad gateway")
            return resp

        with patch("plugins.memory.memory_tencentdb.client.requests.Session") as mock_session_cls:
            mock_sess = MagicMock()
            mock_sess.request.side_effect = fake_request
            mock_session_cls.return_value = mock_sess

            with pytest.raises(RuntimeError):
                client.before_prompt_build([], session_key="s")
