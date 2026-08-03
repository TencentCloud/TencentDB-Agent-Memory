import httpx
import pytest

from tencentdb_agent_memory._v3_http import _decode_response
from tencentdb_agent_memory.errors import TDAMError


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
        _decode_response(response)

    assert exc_info.value.code == -1
    assert exc_info.value.message == "API response code must be an integer"


@pytest.mark.parametrize("data", [[], "", False])
def test_success_requires_object_data(data):
    response = httpx.Response(200, json={"code": 0, "message": "ok", "data": data})

    with pytest.raises(TDAMError) as exc_info:
        _decode_response(response)

    assert exc_info.value.code == -1
    assert exc_info.value.message == "API response data must be a JSON object"


def test_success_allows_null_data():
    response = httpx.Response(200, json={"code": 0, "message": "ok", "data": None})

    assert _decode_response(response) == {}


def test_http_error_without_code_preserves_status():
    response = httpx.Response(503, json={"message": "unavailable"})

    with pytest.raises(TDAMError) as exc_info:
        _decode_response(response)

    assert exc_info.value.code == 503
    assert exc_info.value.message == "unavailable"


def test_business_error_preserves_code_and_details():
    response = httpx.Response(200, json={"code": 40901, "data": {"current_version": 3}})

    with pytest.raises(TDAMError) as exc_info:
        _decode_response(response)

    assert exc_info.value.code == 40901
    assert exc_info.value.message == "HTTP 200"
    assert exc_info.value.details == {"current_version": 3}
