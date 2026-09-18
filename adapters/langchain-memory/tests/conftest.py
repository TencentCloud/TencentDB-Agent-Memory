"""Shared fixtures: fake transports that stub the SDK's HTTP layer.

The official SDK lets callers inject a ``stub`` into ``MemoryClient`` /
``AsyncMemoryClient``. We exploit that to test every mapping without a live
gateway. Each fake records calls and returns canned ``data`` payloads keyed by
``/v3/...`` path.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

import pytest

from tencentdb_agent_memory.v3 import AsyncMemoryClient, MemoryClient
from tencentdb_langchain import (
    AsyncTencentDBMemory,
    TencentDBMemory,
    TencentDBStore,
)


class FakeStub:
    """Synchronous fake: returns ``responses[path]`` and records ``(path, body)``."""

    def __init__(self, responses: Optional[Dict[str, Any]] = None):
        self.responses = responses or {}
        self.calls: List[Tuple[str, Dict[str, Any]]] = []

    def post(self, path: str, body: dict, timeout: Optional[float] = None) -> dict:
        self.calls.append((path, body))
        return self.responses.get(path, {})

    def close(self) -> None:
        pass


class FakeAsyncStub:
    def __init__(self, responses: Optional[Dict[str, Any]] = None):
        self.responses = responses or {}
        self.calls: List[Tuple[str, Dict[str, Any]]] = []

    async def post(self, path: str, body: dict, timeout: Optional[float] = None) -> dict:
        self.calls.append((path, body))
        return self.responses.get(path, {})

    async def close(self) -> None:
        pass


FACT = {
    "id": "fact-1",
    "content": "The user prefers dark theme",
    "type": "preference",
    "score": 0.87,
    "background": "settings",
    "created_at": "2026-01-01T00:00:00Z",
    "updated_at": "2026-01-02T00:00:00Z",
}


def build_sync_memory(responses: Dict[str, Any]) -> TencentDBMemory:
    stub = FakeStub(responses)
    client = MemoryClient(stub=stub, team_id="t1", agent_id="a1", user_id="u1")
    memory = TencentDBMemory(client=client)
    return memory


def build_async_memory(responses: Dict[str, Any]) -> AsyncTencentDBMemory:
    stub = FakeAsyncStub(responses)
    client = AsyncMemoryClient(stub=stub, team_id="t1", agent_id="a1", user_id="u1")
    return AsyncTencentDBMemory(client=client)


@pytest.fixture
def sync_memory() -> TencentDBMemory:
    return build_sync_memory({"/v3/atomic/search": {"items": [FACT]}})


@pytest.fixture
def async_memory() -> AsyncTencentDBMemory:
    return build_async_memory({"/v3/atomic/search": {"items": [FACT]}})


@pytest.fixture
def store() -> TencentDBStore:
    responses = {
        "/v3/atomic/search": {"items": [FACT]},
        "/v3/conversation/add": {"accepted_ids": ["m1"]},
        "/v3/scenario/ls": {"entries": [{"path": "notes/a.md", "summary": "about a"}]},
        "/v3/atomic/delete": {"deleted_count": 1},
    }
    return TencentDBStore(
        memory=build_sync_memory(responses),
        async_memory=build_async_memory(responses),
    )
