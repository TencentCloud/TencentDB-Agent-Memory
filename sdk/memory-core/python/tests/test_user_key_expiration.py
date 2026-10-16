"""Nullable update fields must survive JSON serialization."""
import json

import httpx
import pytest

from tencentdb_agent_memory._v3_http import AsyncHttpStub, HttpStub
from tencentdb_agent_memory.v3 import AsyncMetadataClient, MetadataClient


@pytest.mark.parametrize("expiration", [None, "2030-01-01T00:00:00Z", "omitted"])
def test_sync_user_key_expiration_update(expiration):
    requests = []
    def handle(request):
        requests.append(request)
        return httpx.Response(200, json={"code": 0, "data": {"updated": True}})
    params = {"key_id": "key-1", "name": None}
    expected = {"key_id": "key-1"}
    if expiration != "omitted":
        params["expires_at"] = expected["expires_at"] = expiration
    original = params.copy()
    with httpx.Client(transport=httpx.MockTransport(handle)) as http:
        client = MetadataClient(stub=HttpStub("https://memory.invalid", "fixture", "instance", client=http))
        assert client.update_user_key(params) == {"updated": True}
    assert requests[0].url.path == "/v3/meta/user-key/update"
    assert json.loads(requests[0].content) == expected
    assert params == original


@pytest.mark.asyncio
@pytest.mark.parametrize("expiration", [None, "2030-01-01T00:00:00Z", "omitted"])
async def test_async_user_key_expiration_update(expiration):
    requests = []
    def handle(request):
        requests.append(request)
        return httpx.Response(200, json={"code": 0, "data": {"updated": True}})
    params = {"key_id": "key-1", "name": None}
    expected = {"key_id": "key-1"}
    if expiration != "omitted":
        params["expires_at"] = expected["expires_at"] = expiration
    original = params.copy()
    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http:
        client = AsyncMetadataClient(stub=AsyncHttpStub("https://memory.invalid", "fixture", "instance", client=http))
        assert await client.update_user_key(params) == {"updated": True}
    assert requests[0].url.path == "/v3/meta/user-key/update"
    assert json.loads(requests[0].content) == expected
    assert params == original
