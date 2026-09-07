"""Tests for the built-in memory write mirror in on_memory_write().

Regression coverage for #205 sub-bullet 1: the Hermes provider
declared the ``on_memory_write`` hook in ``plugin.yaml`` but the
method was a ``pass`` no-op with a TODO. The intent — feed
``MEMORY.md`` / ``USER.md`` writes into the L1 index so dedup and
L3 persona building can see them — was scaffolded and abandoned.

The fix encodes the builtin write as a synthetic ``/capture`` turn
so the L1 extractor sees it. These tests are mock-only: they assert
that the provider calls ``client.capture`` with the right shape and
that the hook tolerates a missing or failing client without
propagating exceptions to the caller (Hermes's builtin layer is the
authority for these writes; a mirror failure must not look like a
write failure).
"""

from __future__ import annotations

import os
import pathlib
import sys
from unittest.mock import MagicMock

import pytest

# Mirror the sys.path injection used by the sibling test files
# (test_l3_persona_injection.py, test_memory_tencentdb_recovery.py):
# the provider can live either under the plugin repo or under a
# hermes-agent checkout, so try both before skipping.
_THIS_FILE = pathlib.Path(__file__).resolve()
_HERE = _THIS_FILE.parent
for candidate in (
    _HERE.parents[3] if len(_HERE.parents) >= 4 else None,    # plugin repo
    _HERE.parents[4] if len(_HERE.parents) >= 5 else None,    # hermes-agent root
    _HERE.parents[2] if len(_HERE.parents) >= 3 else None,    # fallback
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
    from plugins.memory.memory_tencentdb import MemoryTencentdbProvider
except ImportError as e:  # pragma: no cover — env-dependent
    pytest.skip(
        f"memory_tencentdb provider not importable ({e}); set "
        "HERMES_AGENT_ROOT to a hermes-agent checkout if running from "
        "the plugin repo.",
        allow_module_level=True,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_provider(*, gateway_available: bool = True) -> MemoryTencentdbProvider:
    """Construct a provider with the Gateway stubbed.

    Bypasses ``initialize()`` the same way the L3 test does: the
    on_memory_write hook only touches ``_client``, ``_gateway_available``,
    ``_session_id``, and ``_user_id``, so we set those and skip the
    rest of the lifecycle.
    """
    p = MemoryTencentdbProvider.__new__(MemoryTencentdbProvider)
    p._gateway_available = gateway_available
    p._client = MagicMock()
    p._session_id = "test-session"
    p._user_id = "test-user"
    return p


# ---------------------------------------------------------------------------
# Core behaviour
# ---------------------------------------------------------------------------

class TestOnMemoryWriteMirror:
    def test_writes_are_forwarded_to_capture(self):
        """A builtin memory write must reach client.capture() with the expected shape."""
        p = _make_provider()
        p.on_memory_write(
            action="append",
            target="USER.md",
            content="User prefers concise answers.",
        )
        p._client.capture.assert_called_once()
        kwargs = p._client.capture.call_args.kwargs
        # The user_content must encode action + target so the L1
        # extractor has enough signal to treat this as a memory
        # write (and not a natural conversation turn).
        assert "memory_write" in kwargs["user_content"]
        assert "action=append" in kwargs["user_content"]
        assert "target=USER.md" in kwargs["user_content"]
        assert "concise answers" in kwargs["user_content"]
        # The session/user context must be threaded through.
        assert kwargs["session_key"] == "test-session"
        assert kwargs["session_id"] == "test-session"
        assert kwargs["user_id"] == "test-user"
        # A non-empty assistant_content signals to the L1 pipeline
        # that this is a complete turn, not a half-written one.
        assert kwargs["assistant_content"]

    def test_no_capture_when_gateway_unavailable(self):
        """If the Gateway is down, the hook must not try to capture.

        A builtin write already succeeded in Hermes's own store; we
        would rather skip the mirror than raise. The user will see
        the write land in USER.md regardless; the L1 index will
        catch up via the next normal sync_turn() that re-surfaces
        the same content.
        """
        p = _make_provider(gateway_available=False)
        # Must not raise.
        p.on_memory_write(action="append", target="USER.md", content="x")
        p._client.capture.assert_not_called()

    def test_no_capture_when_client_is_none(self):
        """If _client is None (e.g. supervisor never started), skip silently."""
        p = _make_provider()
        p._client = None
        # Must not raise.
        p.on_memory_write(action="append", target="USER.md", content="x")

    def test_capture_failure_is_swallowed(self):
        """A failed capture must not propagate to the caller.

        The builtin write already succeeded; a mirror failure is a
        soft-loss of cross-system visibility, not a write failure.
        Raising would make Hermes think the write itself failed
        and (depending on host wiring) retry or surface an error
        to the user. Both are wrong: the user only ever asked
        Hermes to remember, and Hermes did remember.
        """
        p = _make_provider()
        p._client.capture.side_effect = ConnectionError("Gateway down")
        # Must not raise.
        p.on_memory_write(action="append", target="USER.md", content="x")
        p._client.capture.assert_called_once()


# ---------------------------------------------------------------------------
# Negative control: pre-fix behaviour would have been a no-op
# ---------------------------------------------------------------------------

class TestNegativeControl:
    def test_pre_fix_hook_did_nothing(self):
        """Sanity check: before this PR, on_memory_write was a pass statement.

        This test simply confirms the hook *now* has observable
        behaviour. If a future refactor reverts it to a no-op
        (whether deliberately or by accident), the assertion above
        (``test_writes_are_forwarded_to_capture``) will fail. The
        negative control here documents the *shape* of the
        regression: a no-op means the L1 extractor never sees the
        builtin write, and the dedup layer cannot suppress a
        duplicate of a preference the user already wrote down.
        """
        p = _make_provider()
        p.on_memory_write(
            action="append",
            target="USER.md",
            content="NEGATIVE_CONTROL_SENTINEL_PREFERENCE_42",
        )
        # The capture call must have happened with the sentinel
        # verbatim in the user_content. If the hook is reverted to
        # a no-op, this assertion fails — that's the whole point of
        # the negative control.
        assert p._client.capture.called
        kwargs = p._client.capture.call_args.kwargs
        assert "NEGATIVE_CONTROL_SENTINEL_PREFERENCE_42" in kwargs["user_content"]
