from __future__ import annotations

import asyncio
import json

from langgraph.store.base import GetOp, PutOp, SearchItem

from tencentdb_langchain import TencentDBStore
from tencentdb_langchain.store import _observation_value


def test_search_maps_facts(store: TencentDBStore):
    results = store.search(("prefs",), query="theme", limit=5)
    assert len(results) == 1
    item = results[0]
    assert isinstance(item, SearchItem)
    assert item.key == "fact-1"
    assert item.value["content"] == "The user prefers dark theme"
    assert item.score == 0.87


def test_get_returns_top_fact(store: TencentDBStore):
    item = store.get(("prefs",), "theme")
    assert item is not None
    assert item.value["content"] == "The user prefers dark theme"


def test_put_records_an_observation(store: TencentDBStore):
    store.put(("project-x",), "decision-1", {"content": "use FastAPI"})
    sync_mem = store._require_memory()
    path, body = sync_mem.client._stub.calls[0]  # type: ignore[attr-defined]
    assert path == "/v3/conversation/add"
    # session derived from namespace top-level scope
    assert body["session_id"] == "project-x"
    decoded = json.loads(body["messages"][0]["content"])
    assert decoded["source"] == "tencentdb-langgraph"
    assert decoded["key"] == "decision-1"
    assert decoded["value"] == {"content": "use FastAPI"}


def test_list_namespaces_maps_scenarios(store: TencentDBStore):
    namespaces = store.list_namespaces()
    assert namespaces == [("notes", "a.md")]


def test_delete_is_best_effort(store: TencentDBStore):
    store.delete(("prefs",), "fact-1")
    sync_mem = store._require_memory()
    path, body = sync_mem.client._stub.calls[-1]  # type: ignore[attr-defined]
    assert path == "/v3/atomic/delete"
    assert body["ids"] == ["fact-1"]


def test_observation_value_encoding():
    v = _observation_value(("a", "b"), "k", {"x": 1})
    assert v["source"] == "tencentdb-langgraph"
    assert v["namespace"] == ["a", "b"]
    assert v["key"] == "k"
    assert v["value"] == {"x": 1}


def test_batch_dispatches_ops(store: TencentDBStore):
    results = store.batch([
        PutOp(namespace=("prefs",), key="k", value={"content": "v"}, index=None, ttl=None),
        GetOp(namespace=("prefs",), key="theme", refresh_ttl=None),
    ])
    assert results[0] is None  # put returns None
    assert results[1] is not None  # get returns an Item
    assert results[1].value["content"] == "The user prefers dark theme"


def test_abatch_dispatches_ops(store: TencentDBStore):
    async def run():
        return await store.abatch([
            PutOp(namespace=("prefs",), key="k", value={"content": "v"}, index=None, ttl=None),
            GetOp(namespace=("prefs",), key="theme", refresh_ttl=None),
        ])

    results = asyncio.run(run())
    assert results[0] is None
    assert results[1].value["content"] == "The user prefers dark theme"
