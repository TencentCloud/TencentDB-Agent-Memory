"""List pagination remains meaningful when the optional selector is omitted."""
import json

import httpx
import pytest

from tencentdb_agent_memory._v3_http import AsyncHttpStub, HttpStub
from tencentdb_agent_memory.v3 import AsyncMetadataClient, MetadataClient


CASES = [("list_users", "team_id", "/v3/meta/user/list"),
         ("list_user_keys", "user_id", "/v3/meta/user-key/list")]


@pytest.mark.parametrize("method,selector,path", CASES)
@pytest.mark.parametrize("style", ["omitted", "positional", "request"])
def test_sync_list_pagination(method, selector, path, style):
    requests = []
    def handle(request):
        requests.append(request)
        return httpx.Response(200, json={"code": 0, "data": {"items": []}})
    paging = {"limit": 7, "offset": 14}
    expected = paging.copy()
    if style != "omitted":
        expected[selector] = "scope-1"
    with httpx.Client(transport=httpx.MockTransport(handle)) as http:
        client = MetadataClient(stub=HttpStub("https://memory.invalid", "fixture", "instance", client=http))
        call = getattr(client, method)
        if style == "omitted":
            result = call(pagination=paging)
        elif style == "positional":
            result = call("scope-1", pagination=paging)
        else:
            result = call(expected)
    assert result == {"items": []}
    assert requests[0].url.path == path
    assert json.loads(requests[0].content) == expected
    assert paging == {"limit": 7, "offset": 14}


@pytest.mark.asyncio
@pytest.mark.parametrize("method,selector,path", CASES)
@pytest.mark.parametrize("style", ["omitted", "positional", "request"])
async def test_async_list_pagination(method, selector, path, style):
    requests = []
    def handle(request):
        requests.append(request)
        return httpx.Response(200, json={"code": 0, "data": {"items": []}})
    paging = {"limit": 7, "offset": 14}
    expected = paging.copy()
    if style != "omitted":
        expected[selector] = "scope-1"
    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http:
        client = AsyncMetadataClient(stub=AsyncHttpStub("https://memory.invalid", "fixture", "instance", client=http))
        call = getattr(client, method)
        if style == "omitted":
            result = await call(pagination=paging)
        elif style == "positional":
            result = await call("scope-1", pagination=paging)
        else:
            result = await call(expected)
    assert result == {"items": []}
    assert requests[0].url.path == path
    assert json.loads(requests[0].content) == expected
    assert paging == {"limit": 7, "offset": 14}
