import asyncio
import json

import httpx
import pytest

from tencentdb_agent_memory._v3_http import AsyncHttpStub, HttpStub
from tencentdb_agent_memory.errors import ParamError, TDAMError


@pytest.fixture(params=[False, True], ids=["sync", "async"])
def send(request):
    def run(handler, method="post", **kwargs):
        transport = httpx.MockTransport(handler)
        options = dict(endpoint="https://memory.example/", api_key="test-token", service_id="tenant-a", user_key="user-key")
        if request.param:
            async def call():
                async with httpx.AsyncClient(transport=transport) as client:
                    stub = AsyncHttpStub(**options, client=client)
                    return await getattr(stub, method)("/v3/example", **kwargs)
            return asyncio.run(call())
        with httpx.Client(transport=transport) as client:
            stub = HttpStub(**options, client=client)
            return getattr(stub, method)("/v3/example", **kwargs)
    return run


def test_request_identity_and_trace_response(send):
    def handler(request):
        assert request.method == "POST"
        assert str(request.url) == "https://memory.example/v3/example"
        assert request.headers["authorization"] == "Bearer test-token"
        assert request.headers["x-tdai-service-id"] == "tenant-a"
        assert request.headers["x-tdai-user-key"] == "user-key"
        assert json.loads(request.content) == {"team_id": "team-a"}
        return httpx.Response(200, json={"code": 0, "data": {"total": 3}}, headers={"x-trace-id": "trace-1"})
    assert send(handler, body={"team_id": "team-a"}) == {"total": 3, "trace_id": "trace-1"}


def test_get_query_is_url_encoded(send):
    def handler(request):
        assert request.method == "GET"
        assert request.url.params["query"] == "a & b/中文"
        return httpx.Response(200, json={"code": 0, "data": {}})
    assert send(handler, method="get", query={"query": "a & b/中文"}) == {}


def test_business_error_preserves_conflict_details_and_request_id(send):
    def handler(request):
        return httpx.Response(409, json={"code": 40901, "message": "stale", "request_id": "request-1", "data": {"current_version": 5}})
    with pytest.raises(TDAMError) as exc:
        send(handler, body={})
    assert (exc.value.code, exc.value.message, exc.value.request_id) == (40901, "stale", "request-1")
    assert exc.value.details == {"current_version": 5}


@pytest.mark.parametrize("payload", [None, [], "bad", 1, {"code": 0, "data": [1]}])
def test_malformed_envelope_is_an_sdk_error(send, payload):
    def handler(request):
        return httpx.Response(200, content=json.dumps(payload), headers={"x-trace-id": "trace-invalid"})
    with pytest.raises(TDAMError) as exc:
        send(handler, body={})
    assert exc.value.code == -1
    assert exc.value.request_id == "trace-invalid"


def test_http_failure_cannot_be_hidden_by_success_business_code(send):
    with pytest.raises(TDAMError) as exc:
        send(lambda _: httpx.Response(503, json={"code": 0, "message": "unavailable"}), body={})
    assert exc.value.code == 503


def test_non_json_gateway_error_retains_status_and_transaction_id(send):
    with pytest.raises(TDAMError) as exc:
        send(lambda _: httpx.Response(502, text="bad gateway", headers={"x-qcloud-transaction-id": "tx-1"}), body={})
    assert (exc.value.code, exc.value.message, exc.value.request_id) == (502, "bad gateway", "tx-1")


@pytest.mark.parametrize("options", [
    {"endpoint": "file:///tmp/memory"}, {"endpoint": " "}, {"api_key": " "},
    {"service_id": " "}, {"timeout": 0}, {"timeout": -1}, {"timeout": True},
])
@pytest.mark.parametrize("stub_type", [HttpStub, AsyncHttpStub])
def test_invalid_transport_options_fail_before_creating_http_client(options, stub_type):
    params = dict(endpoint="https://memory.example", api_key="test-token", service_id="tenant-a")
    params.update(options)
    with pytest.raises(ParamError):
        stub_type(**params)
