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
