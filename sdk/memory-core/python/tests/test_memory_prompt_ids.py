"""Prompt ID validation must happen before any HTTP request is sent."""

import asyncio
import inspect
import json

import httpx
import pytest

from tencentdb_agent_memory._v3_http import AsyncHttpStub, HttpStub
from tencentdb_agent_memory.errors import ParamError
from tencentdb_agent_memory.v3 import AsyncMemoryPromptClient, MemoryPromptClient


@pytest.fixture(params=[False, True], ids=["sync", "async"])
def prompt_client(request):
    requests = []

    def respond(http_request):
        requests.append(http_request)
        return httpx.Response(200, json={"code": 0, "data": {}})

    def invoke(method, *args, **kwargs):
        result = method(*args, **kwargs)
        return asyncio.run(result) if inspect.isawaitable(result) else result

    transport = httpx.MockTransport(respond)
    if request.param:
        http = httpx.AsyncClient(transport=transport)
        stub = AsyncHttpStub("https://memory.example", "test-key", "test-service", client=http)
        client = AsyncMemoryPromptClient(stub=stub, team_id="team-1")
    else:
        http = httpx.Client(transport=transport)
        stub = HttpStub("https://memory.example", "test-key", "test-service", client=http)
        client = MemoryPromptClient(stub=stub, team_id="team-1")
    try:
        yield client, requests, invoke
    finally:
        invoke(client.close)


@pytest.mark.parametrize("values", [
    "prompt-1", b"prompt-1", bytearray(b"prompt-1"), None, 42,
    [], [""], ["   "], ["prompt-1", None], ["prompt-1", []],
    ["prompt-1", {}],
])
def test_delete_rejects_invalid_ids_without_sending_request(prompt_client, values):
    client, requests, invoke = prompt_client
    with pytest.raises(ParamError, match="memory_prompt_ids"):
        invoke(client.delete, values)
    assert requests == []


@pytest.mark.parametrize("operation", ["apply", "clear"])
@pytest.mark.parametrize("values", ["agent-1", 42, ["agent-1", []]])
def test_target_rejects_invalid_ids_without_sending_request(prompt_client, operation, values):
    client, requests, invoke = prompt_client
    args = ("prompt-1",) if operation == "apply" else ()
    with pytest.raises(ParamError, match="agent_ids"):
        invoke(getattr(client, operation), *args, layer="l1", agent_ids=values)
    assert requests == []


@pytest.mark.parametrize("container", [list, tuple, iter], ids=["list", "tuple", "iterator"])
def test_delete_preserves_iterables_and_deduplicates_in_order(prompt_client, container):
    client, requests, invoke = prompt_client
    values = container(["prompt-2", "prompt-1", "prompt-2"])
    invoke(client.delete, values)
    assert len(requests) == 1
    assert requests[0].url.path == "/v3/memory-prompt/delete"
    assert json.loads(requests[0].content) == {
        "memory_prompt_ids": ["prompt-2", "prompt-1"],
    }


@pytest.mark.parametrize("operation", ["apply", "clear"])
@pytest.mark.parametrize("agent_ids", [None, ["agent-1", "agent-2"]])
def test_target_preserves_team_and_agent_scopes(prompt_client, operation, agent_ids):
    client, requests, invoke = prompt_client
    args = ("prompt-1",) if operation == "apply" else ()
    invoke(getattr(client, operation), *args, layer="l1", agent_ids=agent_ids)
    expected = {"action": operation, "team_id": "team-1", "layer": "l1"}
    if operation == "apply":
        expected["memory_prompt_id"] = "prompt-1"
    if agent_ids is not None:
        expected["agent_ids"] = ["agent-1", "agent-2"]
    assert len(requests) == 1
    assert requests[0].url.path == "/v3/memory-prompt/set"
    assert json.loads(requests[0].content) == expected
