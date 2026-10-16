import httpx
import pytest

from tencentdb_agent_memory import _http, _v3_http


@pytest.mark.parametrize("module, method", [(_http, "post"), (_v3_http, "post"), (_v3_http, "get")])
@pytest.mark.parametrize("override, expected", [(0, 0), (5, 5), (None, 30)])
def test_sync_timeout_override_reaches_httpx(module, method, override, expected):
    requests = []

    def reply(request):
        requests.append(request)
        return httpx.Response(200, json={"code": 0, "data": {}})

    with httpx.Client(transport=httpx.MockTransport(reply), timeout=30) as client:
        stub = module.HttpStub("https://fixture.invalid", "fixture-key", "fixture-service", client=client)
        assert getattr(stub, method)("/fixture", {}, timeout=override) == {}
    assert requests[0].extensions["timeout"] == {key: expected for key in ("connect", "read", "write", "pool")}


@pytest.mark.asyncio
@pytest.mark.parametrize("module, method", [(_http, "post"), (_v3_http, "post"), (_v3_http, "get")])
@pytest.mark.parametrize("override, expected", [(0, 0), (5, 5), (None, 30)])
async def test_async_timeout_override_reaches_httpx(module, method, override, expected):
    requests = []

    def reply(request):
        requests.append(request)
        return httpx.Response(200, json={"code": 0, "data": {}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(reply), timeout=30) as client:
        stub = module.AsyncHttpStub("https://fixture.invalid", "fixture-key", "fixture-service", client=client)
        assert await getattr(stub, method)("/fixture", {}, timeout=override) == {}
    assert requests[0].extensions["timeout"] == {key: expected for key in ("connect", "read", "write", "pool")}
