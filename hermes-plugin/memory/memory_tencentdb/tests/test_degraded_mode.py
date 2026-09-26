"""Tests for degraded-mode visibility (silent-outage regression).

Covers the failure mode behind the "10 days of silent memory loss"
incident: when the Gateway dies, system_prompt_block() returned "" (the
agent never learns memory is down) and dropped sync_turn() calls left
nothing behind but logger.warning lines. After the fix:

  1. system_prompt_block() reports a DEGRADED block while the Gateway is
     unreachable, including when the outage began.
  2. unavailable_reason() returns an actionable hint instead of "".
  3. Conversation turns dropped during an outage are counted, and the
     count is surfaced in the restored prompt block after recovery.

Uses the same FakeSupervisor style as test_memory_tencentdb_recovery.py
so no real Node processes are spawned and no sockets are opened.
"""

from __future__ import annotations

import os
import pathlib
import sys
import threading
import time
from unittest.mock import MagicMock

import pytest

# Same sys.path dance as test_memory_tencentdb_recovery.py next door: make
# the import work both from the plugin repo tree and from a hermes-agent
# checkout.
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

_hermes_root = os.environ.get("HERMES_AGENT_ROOT")
if not _hermes_root:
    sibling = _HERE.parents[4] / "hermes-agent" if len(_HERE.parents) >= 5 else None
    if sibling is not None and (sibling / "agent").is_dir():
        _hermes_root = str(sibling)
if _hermes_root and _hermes_root not in sys.path:
    sys.path.insert(0, _hermes_root)

try:
    import plugins.memory.memory_tencentdb as mod
    from plugins.memory.memory_tencentdb import MemoryTencentdbProvider
except ImportError as e:  # pragma: no cover — env-dependent
    pytest.skip(
        f"memory_tencentdb provider not importable ({e}); set HERMES_AGENT_ROOT "
        "to a hermes-agent checkout if running from the plugin repo.",
        allow_module_level=True,
    )


# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------


class FakeSupervisor:
    def __init__(self) -> None:
        self.alive = True
        self.healthy = True
        self.respawn_succeeds = True
        self.client = MagicMock(name="MemoryTencentdbSdkClient")

    def is_running(self) -> bool:
        return self.healthy

    def is_process_alive(self) -> bool:
        return self.alive

    def ensure_running(self) -> bool:
        if self.respawn_succeeds:
            self.alive = True
            self.healthy = True
            return True
        return False

    def shutdown(self) -> None:
        self.alive = False
        self.healthy = False


def _wait_until(predicate, *, timeout: float = 3.0, interval: float = 0.02) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


@pytest.fixture()
def provider(monkeypatch):
    """Provider wired to a FakeSupervisor with a fast watchdog."""
    fake = FakeSupervisor()
    monkeypatch.setattr(mod, "GatewaySupervisor", lambda *a, **kw: fake)
    monkeypatch.setattr(mod, "_WATCHDOG_INTERVAL_SECS", 0.05)
    monkeypatch.setattr(mod, "_WATCHDOG_SHUTDOWN_TIMEOUT_SECS", 0.5)
    monkeypatch.setattr(mod, "_RECOVER_COOLDOWN_SECS", 0)
    monkeypatch.setenv("MEMORY_TENCENTDB_GATEWAY_CMD", "fake-cmd")

    p = MemoryTencentdbProvider()
    p.initialize(session_id="test-session", user_id="test-user")
    p._fake = fake

    assert _wait_until(lambda: p._gateway_available, timeout=2.0)
    try:
        yield p
    finally:
        p.shutdown()


def _park_in_outage(p) -> None:
    """Stop the watchdog and park the provider in a real outage.

    respawn_succeeds must be False here: with the default harness the lazy
    probe would instantly resurrect the Gateway (the desired production
    behavior), and no turn would ever actually be lost.
    """
    p._stop_watchdog()
    p._gateway_available = False
    p._client = None
    p._fake.alive = False
    p._fake.healthy = False
    p._fake.respawn_succeeds = False


# ---------------------------------------------------------------------------
# system_prompt_block
# ---------------------------------------------------------------------------


def test_prompt_block_degraded_while_gateway_down(provider):
    _park_in_outage(provider)

    block = provider.system_prompt_block()

    assert "DEGRADED" in block, "agent must be told memory is down, got an empty/active block"
    assert "Active" not in block


def test_prompt_block_degraded_mentions_outage_start(provider):
    _park_in_outage(provider)
    provider._note_gateway_down()

    block = provider.system_prompt_block()

    assert "Outage began" in block


def test_prompt_block_active_when_healthy(provider):
    block = provider.system_prompt_block()
    assert "Active" in block
    assert "DEGRADED" not in block


# ---------------------------------------------------------------------------
# unavailable_reason
# ---------------------------------------------------------------------------


def test_unavailable_reason_empty_while_healthy(provider):
    assert provider.unavailable_reason() == ""


def test_unavailable_reason_while_down(provider):
    _park_in_outage(provider)
    assert provider.unavailable_reason() != ""


def test_unavailable_reason_mentions_open_breaker(provider):
    provider._stop_watchdog()
    provider._gateway_available = False
    provider._consecutive_failures = 999
    provider._breaker_open_until = time.monotonic() + 60

    reason = provider.unavailable_reason()

    assert "breaker" in reason


# ---------------------------------------------------------------------------
# Lost-turn accounting
# ---------------------------------------------------------------------------


def test_lost_turns_counted_while_down(provider):
    _park_in_outage(provider)

    provider.sync_turn(user_content="u1", assistant_content="a1")
    provider.sync_turn(user_content="u2", assistant_content="a2")

    assert provider._lost_turn_count == 2


def test_lost_turns_surfaced_after_recovery(provider):
    _park_in_outage(provider)
    provider.sync_turn(user_content="u1", assistant_content="a1")
    provider.sync_turn(user_content="u2", assistant_content="a2")
    assert provider._lost_turn_count == 2

    # The Gateway comes back and the next capture goes through.
    fake = provider._fake
    fake.alive = True
    fake.healthy = True
    fake.respawn_succeeds = True
    captured = threading.Event()
    fake.client.capture.side_effect = lambda **kw: captured.set()
    provider.sync_turn(user_content="u3", assistant_content="a3")
    assert captured.wait(timeout=2.0), "capture never reached the Gateway"

    assert provider._lost_turn_count == 0, "counters must reset after recovery"
    assert provider._gateway_down_since is None
    summary = provider._last_outage_summary
    assert summary is not None, "recovery must publish an outage summary"
    assert "2 conversation turns" in summary
    # The restored (active) prompt block is where the agent learns about it.
    assert summary in provider.system_prompt_block()


def test_capture_failure_counts_as_lost_turn(provider):
    provider._stop_watchdog()
    fake = provider._fake
    fake.client.capture.side_effect = RuntimeError("gateway exploded")

    provider.sync_turn(user_content="u", assistant_content="a")

    assert _wait_until(
        lambda: provider._last_outage_summary is not None, timeout=2.0
    ), "a failed capture must be accounted as a lost turn"
    assert "1 conversation turn" in provider._last_outage_summary


def test_healthy_to_failed_window_shows_degraded(provider):
    """Regression for the review finding on the healthy→failed transition.

    After the first failed capture the outage accounting is already set,
    but _gateway_available only flips later (breaker needs 5 consecutive
    failures, or the watchdog has to notice). In that window the
    diagnostics must not advertise Active — the existing tests missed it
    because _park_in_outage() sets availability to False by hand.
    """
    provider._stop_watchdog()
    fake = provider._fake
    # The Gateway is down for real and cannot be revived, but the
    # provider's availability flag has not been touched yet.
    fake.alive = False
    fake.healthy = False
    fake.respawn_succeeds = False
    fake.client.capture.side_effect = RuntimeError("gateway exploded")

    assert provider._gateway_available, "precondition: provider still healthy"

    provider.sync_turn(user_content="u", assistant_content="a")

    assert _wait_until(
        lambda: provider._gateway_down_since is not None, timeout=2.0
    ), "the failed capture never got accounted"
    assert provider._gateway_available, (
        "precondition drifted: availability flipped, so this no longer "
        "tests the healthy→failed window"
    )

    block = provider.system_prompt_block()
    assert "DEGRADED" in block, (
        "prompt block advertised Active after a failed capture: %r" % block
    )
    assert "Active" not in block
    assert provider.unavailable_reason() != ""


def test_tool_call_failure_degrades_diagnostics(provider):
    """The tool-call path must feed the outage accounting too: a failed
    memory_search with the availability flag still True is the same
    healthy→failed window as a failed capture."""
    provider._stop_watchdog()
    fake = provider._fake
    fake.alive = False
    fake.healthy = False
    fake.respawn_succeeds = False
    fake.client.search_memories.side_effect = RuntimeError("gateway exploded")

    assert provider._gateway_available, "precondition: provider still healthy"

    out = provider.handle_tool_call(
        "memory_tencentdb_memory_search", {"query": "anything"}
    )

    assert "Tool call failed" in out
    assert _wait_until(
        lambda: provider._gateway_down_since is not None, timeout=2.0
    ), "failed tool call never got accounted"
    assert provider._gateway_available, "precondition drifted"
    block = provider.system_prompt_block()
    assert "DEGRADED" in block and "Active" not in block
    assert provider.unavailable_reason() != ""


def test_tool_call_success_marks_gateway_up(provider):
    """A successful tool call proves the Gateway is alive, so it should
    close a tracked outage just like a successful capture does."""
    provider._stop_watchdog()
    fake = provider._fake
    fake.alive = False
    fake.healthy = False
    fake.respawn_succeeds = False
    fake.client.search_memories.side_effect = RuntimeError("gateway exploded")

    provider.handle_tool_call("memory_tencentdb_memory_search", {"query": "x"})
    assert _wait_until(
        lambda: provider._gateway_down_since is not None, timeout=2.0
    )

    # Gateway returns; the next tool call succeeds and must close the outage.
    fake.alive = True
    fake.healthy = True
    fake.respawn_succeeds = True
    fake.client.search_memories.side_effect = None
    fake.client.search_memories.return_value = {"results": []}

    provider.handle_tool_call("memory_tencentdb_memory_search", {"query": "x"})

    assert provider._gateway_down_since is None, "outage stayed open after a successful tool call"
    assert "Active" in provider.system_prompt_block()


def test_watchdog_external_revival_closes_outage(provider):
    """The watchdog's external-restart branch restores availability, so it
    must close the outage accounting too — otherwise the diagnostics keep
    reporting DEGRADED while the Gateway is alive again, the mirror image
    of the healthy→failed window."""
    fake = provider._fake
    provider._stop_watchdog()
    provider._gateway_available = False
    provider._client = None
    fake.alive = False
    fake.healthy = False
    fake.respawn_succeeds = False
    fake.client.capture.side_effect = RuntimeError("gateway exploded")

    provider.sync_turn(user_content="u", assistant_content="a")
    assert _wait_until(
        lambda: provider._gateway_down_since is not None, timeout=2.0
    ), "precondition: outage never got accounted"
    assert provider._lost_turn_count == 1

    # The Gateway comes back on its own (operator restart); the watchdog
    # picks it up via its health probe without re-spawning.
    fake.alive = True
    fake.healthy = True
    provider._start_watchdog()

    assert _wait_until(
        lambda: provider._gateway_available, timeout=3.0
    ), "watchdog never picked up the external restart"
    assert provider._gateway_down_since is None, (
        "watchdog restored availability but left the outage accounting open"
    )
    block = provider.system_prompt_block()
    assert "Active" in block and "DEGRADED" not in block
    assert provider.unavailable_reason() == ""
    assert provider._last_outage_summary is not None
    assert "1 conversation turn" in provider._last_outage_summary


def test_transient_blip_leaves_no_degraded_block(provider):
    """A single failed request that immediately recovers must not leave the
    provider looking degraded — the outage summary is kept, but the block
    goes straight back to Active."""
    provider._stop_watchdog()
    fake = provider._fake
    fake.client.recall.side_effect = RuntimeError("blip")

    provider.prefetch(query="hello")

    assert _wait_until(
        lambda: provider._gateway_available, timeout=2.0
    ), "transient blip should self-heal via the recovery path"
    assert "Active" in provider.system_prompt_block()
    assert "DEGRADED" not in provider.system_prompt_block()
