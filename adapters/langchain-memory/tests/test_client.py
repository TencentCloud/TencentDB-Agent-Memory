from __future__ import annotations

import pytest

from tencentdb_langchain import MemoryFact, TencentDBMemory
from tencentdb_langchain.client import _normalize_messages

from conftest import FACT, build_sync_memory


def test_capture_returns_accepted_ids_and_sends_session():
    memory = build_sync_memory({"/v3/conversation/add": {"accepted_ids": ["m1", "m2"]}})
    ids = memory.capture(
        [{"role": "user", "content": "hello"}], session_id="sess-1"
    )
    assert ids == ["m1", "m2"]
    path, body = memory.client._stub.calls[0]  # type: ignore[attr-defined]
    assert path == "/v3/conversation/add"
    assert body["session_id"] == "sess-1"
    assert body["messages"] == [{"role": "user", "content": "hello"}]
    assert body["team_id"] == "t1"


def test_capture_rejects_empty_messages():
    memory = build_sync_memory({})
    with pytest.raises(ValueError):
        memory.capture([], session_id="sess-1")


def test_search_facts_maps_items():
    memory = build_sync_memory({"/v3/atomic/search": {"items": [FACT]}})
    facts = memory.search_facts("theme", limit=5)
    assert len(facts) == 1
    f = facts[0]
    assert isinstance(f, MemoryFact)
    assert f.content == "The user prefers dark theme"
    assert f.type == "preference"
    assert f.score == 0.87
    assert f.id == "fact-1"


def test_read_persona_maps_content():
    memory = build_sync_memory({"/v3/core/read": {"content": "# persona", "version": 2}})
    persona = memory.read_persona()
    assert persona.content == "# persona"
    assert persona.version == 2


def test_list_scenarios_maps_entries():
    memory = build_sync_memory(
        {"/v3/scenario/ls": {"entries": [{"path": "notes/a.md", "summary": "about a"}]}}
    )
    scenarios = memory.list_scenarios()
    assert len(scenarios) == 1
    assert scenarios[0].path == "notes/a.md"


def test_delete_facts_returns_count():
    memory = build_sync_memory({"/v3/atomic/delete": {"deleted_count": 3}})
    assert memory.delete_facts(["a", "b", "c"]) == 3


def test_normalize_messages_rejects_missing_fields():
    with pytest.raises(ValueError):
        _normalize_messages([{"role": "user"}])
