import httpx
import pytest

from tencentdb_agent_memory._http import (
    AsyncHttpStub,
    HttpStub,
    _decode_success_response,
)
from tencentdb_agent_memory.errors import TDAMError


@pytest.mark.parametrize("payload", [[], "ok"])
def test_success_requires_object_envelope(payload):
    response = httpx.Response(200, json=payload)

    with pytest.raises(TDAMError) as exc_info:
        _decode_success_response(response)

    assert exc_info.value.code == -1
    assert exc_info.value.message == "API response must be a JSON object"


def test_success_rejects_json_null_envelope():
    response = httpx.Response(
        200,
        content=b"null",
        headers={"content-type": "application/json"},
    )

    with pytest.raises(TDAMError) as exc_info:
        _decode_success_response(response)

    assert exc_info.value.code == -1
    assert exc_info.value.message == "API response must be a JSON object"


@pytest.mark.parametrize(
    "payload",
    [
        {"message": "ok", "data": {}},
        {"code": True, "message": "ok", "data": {}},
    ],
)
def test_success_requires_integer_code(payload):
    response = httpx.Response(200, json=payload)

    with pytest.raises(TDAMError) as exc_info:
        _decode_success_response(response)

    assert exc_info.value.code == -1
    assert exc_info.value.message == "API response code must be an integer"


@pytest.mark.parametrize("data", [[], "", False])
def test_success_requires_object_data(data):
    response = httpx.Response(200, json={"code": 0, "message": "ok", "data": data})

    with pytest.raises(TDAMError) as exc_info:
        _decode_success_response(response)

    assert exc_info.value.code == -1
    assert exc_info.value.message == "API response data must be a JSON object"


def test_success_allows_null_data():
    response = httpx.Response(200, json={"code": 0, "message": "ok", "data": None})

    assert _decode_success_response(response) == {}


def test_success_preserves_object_data_and_trace_id():
    response = httpx.Response(
        200,
        json={"code": 0, "message": "ok", "data": {"memory_id": "memory-1"}},
        headers={"x-trace-id": "trace-1"},
    )

    assert _decode_success_response(response) == {
        "memory_id": "memory-1",
        "trace_id": "trace-1",
    }


def test_business_error_preserves_code_details_and_request_id():
    response = httpx.Response(
        200,
        json={
            "code": 40901,
            "message": "stale version",
            "request_id": "body-request",
            "data": {"current_version": 3},
        },
        headers={"x-qcloud-transaction-id": "header-request"},
    )

    with pytest.raises(TDAMError) as exc_info:
        _decode_success_response(response)

    assert exc_info.value.code == 40901
    assert exc_info.value.message == "stale version"
    assert exc_info.value.request_id == "header-request"
    assert exc_info.value.details == {"current_version": 3}


def test_sync_transport_rejects_non_object_success_data():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"code": 0, "message": "ok", "data": []},
            request=request,
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        stub = HttpStub("https://memory.example.test", "key", "service", client=client)

        with pytest.raises(TDAMError, match="data must be a JSON object"):
            stub.post("/v2/test", {})


@pytest.mark.asyncio
async def test_async_transport_rejects_non_object_success_data():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"code": 0, "message": "ok", "data": []},
            request=request,
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        stub = AsyncHttpStub(
            "https://memory.example.test",
            "key",
            "service",
            client=client,
        )

        with pytest.raises(TDAMError, match="data must be a JSON object"):
            await stub.post("/v2/test", {})
