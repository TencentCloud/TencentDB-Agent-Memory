"""Tests for Gateway /recall context field compatibility."""

from __future__ import annotations

from unittest.mock import MagicMock


from memory.memory_tencentdb import MemoryTencentdbProvider


def _ready_provider() -> MemoryTencentdbProvider:
    provider = MemoryTencentdbProvider()
    provider._client = MagicMock()
    provider._gateway_available = True
    provider._session_id = "test-session"
    provider._user_id = "test-user"
    provider._ensure_alive_for_request = MagicMock(return_value=True)
    return provider


def test_prefetch_prefers_split_context_fields_over_legacy_context():
    provider = _ready_provider()
    provider._client.recall.return_value = {
        "appendSystemContext": "stable system context",
        "prependContext": "dynamic L1 context",
        "context": "stale legacy context",
    }

    assert provider.prefetch("hello") == (
        "## memory-tencentdb Memory\n"
        "stable system context\n\n"
        "dynamic L1 context"
    )


def test_prefetch_reads_legacy_context_when_split_fields_absent():
    provider = _ready_provider()
    provider._client.recall.return_value = {"context": "legacy context"}

    assert provider.prefetch("hello") == (
        "## memory-tencentdb Memory\n"
        "legacy context"
    )
