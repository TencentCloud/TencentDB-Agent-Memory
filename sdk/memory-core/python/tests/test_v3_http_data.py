"""v3 transport envelope ``data`` handling.

A successful (``code == 0``) response must only fall back to an empty
object when ``data`` is ``null``; every other non-object payload —
including falsy ones (``[]``/``""``/``0``/``false``) — is malformed and
must raise ``TDAMError`` instead of silently passing as an empty
success. Mirrors the None-only rule applied to the v2 transport.
"""

import asyncio

import httpx
import pytest

from tencentdb_agent_memory._v3_http import AsyncHttpStub, HttpStub
from tencentdb_agent_memory.errors import TDAMError

ENDPOINT = "https://memory.example.com"


def _stub_for(payload, *, trace_id=None):
    def handler(request: httpx.Request) -> httpx.Response:
        headers = {"x-trace-id": trace_id} if trace_id else {}
        return httpx.Response(200, json=payload, headers=headers)

    return HttpStub(
        ENDPOINT, "k", "svc", client=httpx.Client(transport=httpx.MockTransport(handler))
    )


def _post(stub, body=None):
    return stub.post("/v3/echo", body or {})


# -- accepted payloads -------------------------------------------------------

def test_null_data_falls_back_to_empty_dict():
    stub = _stub_for({"code": 0, "message": "ok", "data": None}, trace_id="t-1")
    result = _post(stub)
    assert result == {"trace_id": "t-1"}
    stub.close()


def test_object_data_passes_through():
    stub = _stub_for({"code": 0, "data": {"items": [1], "total": 1}})
    result = _post(stub)
    assert result == {"items": [1], "total": 1}
    stub.close()


# -- malformed non-object data must fail, not normalize to {} ----------------

@pytest.mark.parametrize("data", [[], "", 0, False])
def test_falsy_non_object_data_raises(data):
    stub = _stub_for({"code": 0, "message": "ok", "data": data})
    with pytest.raises(TDAMError) as excinfo:
        _post(stub)
    assert excinfo.value.code == -1
    stub.close()


@pytest.mark.parametrize("data", [[1, 2], "ok", 3, True])
def test_truthy_non_object_data_raises(data):
    stub = _stub_for({"code": 0, "message": "ok", "data": data})
    with pytest.raises(TDAMError) as excinfo:
        _post(stub)
    assert excinfo.value.code == -1
    stub.close()


# -- async transport shares the same decoder ---------------------------------

def test_async_null_data_and_falsy_list():
    async def main():
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"code": 0, "data": None})

        stub = AsyncHttpStub(
            ENDPOINT, "k", "svc",
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )
        result = await stub.post("/v3/echo", {})
        await stub.close()
        return result

    assert asyncio.run(main()) == {}
