"""Regression: v2 transport must tolerate a null/non-dict ``data`` on success.

The v3 transport (``_v3_http.py``) normalizes a null success envelope with
``envelope.get("data") or {}`` and rejects non-dict data with a clean
``TDAMError``. The v2 transport (``_http.py``) used
``data.get("data", {})``, whose default never fires for an explicit
``null`` — so a ``{"code": 0, "data": null}`` response (the shape void-style
endpoints return) reached ``result["trace_id"] = trace_id`` and crashed the
caller with ``TypeError`` instead of returning the envelope's data. A
non-dict payload (list/string) crashed the same way.
"""

from __future__ import annotations

import httpx
import pytest
import respx

from tencentdb_agent_memory._http import AsyncHttpStub, HttpStub
from tencentdb_agent_memory.errors import TDAMError

_BASE = "https://memory.example.com"


def _envelope(data_payload) -> dict:
    return {"code": 0, "message": "ok", "data": data_payload}


@respx.mock
def test_sync_post_null_data_returns_envelope_with_trace_id() -> None:
    route = respx.post(f"{_BASE}/v2/demo").mock(
        return_value=httpx.Response(200, json=_envelope(None), headers={"x-trace-id": "trace-123"})
    )
    stub = HttpStub(endpoint=_BASE, api_key="k", service_id="s")

    result = stub.post("/v2/demo", {})

    assert route.called
    # Null data normalizes to the envelope's (empty) data, keeping the
    # trace-id propagation intact — no TypeError escapes the transport.
    assert result == {"trace_id": "trace-123"}


@pytest.mark.asyncio
@respx.mock
async def test_async_post_null_data_returns_envelope_with_trace_id() -> None:
    route = respx.post(f"{_BASE}/v2/demo").mock(
        return_value=httpx.Response(200, json=_envelope(None), headers={"x-trace-id": "trace-456"})
    )
    stub = AsyncHttpStub(endpoint=_BASE, api_key="k", service_id="s")

    result = await stub.post("/v2/demo", {})

    assert route.called
    assert result == {"trace_id": "trace-456"}


@pytest.mark.parametrize("data_payload", [[1, 2], "text", [], "", 0, False])
@respx.mock
def test_sync_post_non_dict_data_raises_tdam_error(data_payload) -> None:
    """Non-dict success data is an API contract violation: fail with TDAMError.

    Before the fix the transport crashed with ``TypeError`` while writing the
    trace id into the non-dict payload; the v3 transport raises TDAMError.
    """
    route = respx.post(f"{_BASE}/v2/demo").mock(
        return_value=httpx.Response(200, json=_envelope(data_payload), headers={"x-trace-id": "trace-789"})
    )
    stub = HttpStub(endpoint=_BASE, api_key="k", service_id="s")

    with pytest.raises(TDAMError):
        stub.post("/v2/demo", {})
    assert route.called


@respx.mock
def test_sync_post_dict_data_still_passes_through() -> None:
    """The normal dict-data path is unchanged by the fix."""
    respx.post(f"{_BASE}/v2/demo").mock(
        return_value=httpx.Response(200, json=_envelope({"id": "abc"}), headers={"x-trace-id": "trace-abc"})
    )
    stub = HttpStub(endpoint=_BASE, api_key="k", service_id="s")

    result = stub.post("/v2/demo", {})

    assert result == {"id": "abc", "trace_id": "trace-abc"}
