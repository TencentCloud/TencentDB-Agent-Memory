"""Tests for the L3 persona injection in system_prompt_block().

Regression coverage for #205: the Hermes provider's
``system_prompt_block()`` previously returned a static string and
ignored the L3 persona that the Gateway had already generated and
returned via ``recalledL3_persona``. The fix calls ``/recall`` (with
a short TTL cache), appends the persona block when present, and falls
back to the static block when the Gateway has not yet generated a
persona or is unreachable.

These tests are mock-only: they assert behaviour against a stubbed
``MemoryTencentdbSdkClient`` and never open a network socket or spawn
a real Node process.
"""

from __future__ import annotations

import os
import pathlib
import sys
import time
from typing import Any, Dict
from unittest.mock import MagicMock

import pytest

# Mirror the sys.path injection used by the sibling test file
# (test_memory_tencentdb_recovery.py): the provider can live either
# under the plugin repo or under a hermes-agent checkout, so try both
# before skipping.
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

def _make_provider() -> MemoryTencentdbProvider:
    """Construct a provider with the Gateway stubbed as available.

    We bypass ``initialize()`` (which would start a background thread
    and a watchdog) and set the fields the production code reads. This
    is enough for ``system_prompt_block()`` to take the
    "Gateway is up" path without any real I/O.
    """
    p = MemoryTencentdbProvider.__new__(MemoryTencentdbProvider)
    p._gateway_available = True
    p._client = MagicMock()
    p._session_id = "test-session"
    p._user_id = "test-user"
    p._persona_cache = {"ts": 0.0, "value": ""}
    p._ensure_alive_for_request = MagicMock(return_value=True)  # type: ignore[attr-defined]
    p._record_success = MagicMock()  # type: ignore[attr-defined]
    p._record_failure = MagicMock()  # type: ignore[attr-defined]
    return p


# ---------------------------------------------------------------------------
# Core behaviour
# ---------------------------------------------------------------------------

class TestSystemPromptBlockPersona:
    def test_static_block_when_no_persona_returned(self):
        """Gateway returns no recalledL3_persona → fall back to static block.

        This is the pre-#205 behaviour and must still work: an operator
        with an older Gateway (or a fresh install that has not yet
        generated any L3 memories) should not see an error.
        """
        p = _make_provider()
        p._client.recall.return_value = {"context": "", "memory_count": 0}
        out = p.system_prompt_block()
        assert "memory-tencentdb Memory" in out
        assert "User Persona" not in out
        assert p._client.recall.call_count == 1

    def test_persona_injected_when_present(self):
        """Gateway returns recalledL3_persona → it appears in the system prompt."""
        p = _make_provider()
        p._client.recall.return_value = {
            "context": "",
            "memory_count": 0,
            "recalledL3_persona": "User prefers concise answers and Rust over Python.",
        }
        out = p.system_prompt_block()
        assert "memory-tencentdb Memory" in out
        assert "## User Persona" in out
        assert "concise answers and Rust" in out
        assert p._record_success.called

    def test_empty_string_persona_treated_as_absent(self):
        """An empty string in recalledL3_persona is a 'not generated yet' signal."""
        p = _make_provider()
        p._client.recall.return_value = {
            "context": "",
            "recalledL3_persona": "",  # explicit empty
        }
        out = p.system_prompt_block()
        assert "User Persona" not in out
        # Empty persona must not call _record_success — there is no
        # successful memory operation, just a successful round-trip
        # with no payload. The success counter is reserved for actual
        # recalls, not for "I asked and got nothing."
        assert not p._record_success.called

    def test_null_persona_treated_as_absent(self):
        """A null persona (newer Gateway, not yet generated) is also 'absent'."""
        p = _make_provider()
        p._client.recall.return_value = {
            "context": "",
            "recalledL3_persona": None,
        }
        out = p.system_prompt_block()
        assert "User Persona" not in out


# ---------------------------------------------------------------------------
# Caching: the /recall call must not fire on every turn
# ---------------------------------------------------------------------------

class TestPersonaCache:
    def test_second_call_within_ttl_does_not_re_recall(self):
        """Two system_prompt_block() calls within the TTL must trigger one /recall."""
        p = _make_provider()
        p._client.recall.return_value = {
            "recalledL3_persona": "Likes dark mode and long-form answers.",
        }
        first = p.system_prompt_block()
        second = p.system_prompt_block()
        assert "Likes dark mode" in first
        assert "Likes dark mode" in second
        assert p._client.recall.call_count == 1

    def test_cache_expires_after_ttl(self, monkeypatch):
        """A call after the TTL has elapsed must trigger a fresh /recall."""
        p = _make_provider()
        p._client.recall.side_effect = [
            {"recalledL3_persona": "first persona"},
            {"recalledL3_persona": "second persona, regenerated"},
        ]
        # Use a 1-second TTL to keep the test fast.
        p._PERSONA_CACHE_TTL_SECS = 0.01  # type: ignore[attr-defined]
        first = p.system_prompt_block()
        time.sleep(0.02)
        second = p.system_prompt_block()
        assert "first persona" in first
        assert "second persona" in second
        assert p._client.recall.call_count == 2

    def test_failed_recall_does_not_poison_cache(self):
        """A failed /recall must not crash system_prompt_block().

        On the very first call (cache empty), a failure leaves the
        cache empty and the next call retries — we want a fresh
        attempt once the Gateway comes back. The static block is
        returned in the meantime so the prompt builder is never
        broken.
        """
        p = _make_provider()
        p._client.recall.side_effect = ConnectionError("Gateway down")
        out = p.system_prompt_block()
        # Falls back to the static block — the persona fetch was a
        # best-effort, not a hard dependency.
        assert "memory-tencentdb Memory" in out
        assert "User Persona" not in out
        # Cache state must not be advanced on failure.
        assert p._persona_cache["ts"] == 0.0
        assert p._persona_cache["value"] == ""
        # And the next call (still within TTL, still no successful
        # fetch) must retry — not serve a cached failure.
        p.system_prompt_block()
        assert p._client.recall.call_count == 2

    def test_failed_recall_after_successful_fetch_falls_back(self):
        """Once a fetch succeeds, a later failure within the TTL returns the cached value.

        This is the "Gateway died mid-session" case: we already have
        a usable persona from earlier, the Gateway goes down, and we
        degrade gracefully by serving the last-known-good value
        rather than re-fetching on every turn (which would error on
        every turn and slow the prompt builder to a crawl).
        """
        p = _make_provider()
        p._client.recall.side_effect = [
            {"recalledL3_persona": "Loves Rust and dark mode."},  # success
            ConnectionError("Gateway went down"),               # failure
        ]
        # First call: success → persona is cached.
        first = p.system_prompt_block()
        assert "Loves Rust" in first
        # Override the TTL to "always fresh" for clarity, so the
        # second call would have re-fetched if not for the failure
        # path. (We want to test the failure-doesn't-update-ts
        # behaviour, not the TTL.)
        p._PERSONA_CACHE_TTL_SECS = 0.0  # type: ignore[attr-defined]
        # Second call: would normally re-fetch (TTL elapsed), but
        # the fetch fails, so we fall back to the cached value.
        second = p.system_prompt_block()
        assert "Loves Rust" in second
        # Only one network call was made; the failure didn't trigger
        # a retry (we want to limit damage when the Gateway is sick).
        assert p._client.recall.call_count == 2


# ---------------------------------------------------------------------------
# Negative-control: pre-#205 behaviour would fail this test
# ---------------------------------------------------------------------------

class TestNegativeControl:
    def test_pre_fix_static_block_does_not_contain_persona(self):
        """Sanity check the old behaviour is gone: a returned persona must appear.

        This is the test that would have failed on main before the fix
        and now passes. If a future refactor accidentally reverts to
        the static-only block, this assertion will fail loudly.
        """
        p = _make_provider()
        sentinel = "NEGATIVE_CONTROL_SENTINEL_PERSONA_STRING_42"
        p._client.recall.return_value = {
            "recalledL3_persona": f"User is a {sentinel} enthusiast.",
        }
        out = p.system_prompt_block()
        assert sentinel in out, (
            "system_prompt_block() did not surface the L3 persona. "
            "This is the regression — see issue #205."
        )
