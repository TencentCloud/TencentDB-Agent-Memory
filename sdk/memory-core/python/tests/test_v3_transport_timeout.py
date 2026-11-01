import math

import pytest

from tencentdb_agent_memory._v3_http import (
    AsyncHttpStub,
    HttpStub,
    _validate_transport_options,
)
from tencentdb_agent_memory.errors import ParamError


ENDPOINT = "https://example.test"
API_KEY = "api-key"
SERVICE_ID = "service"


@pytest.mark.parametrize(
    "timeout",
    [
        math.nan,
        math.inf,
        -math.inf,
        0,
        -1,
        True,
        False,
        "1",
        None,
    ],
)
def test_transport_rejects_non_positive_or_non_finite_timeout(timeout):
    with pytest.raises(ParamError):
        _validate_transport_options(ENDPOINT, API_KEY, SERVICE_ID, timeout)
    with pytest.raises(ParamError):
        HttpStub(ENDPOINT, API_KEY, SERVICE_ID, timeout=timeout, client=object())
    with pytest.raises(ParamError):
        AsyncHttpStub(ENDPOINT, API_KEY, SERVICE_ID, timeout=timeout, client=object())


@pytest.mark.parametrize("timeout", [1, 0.5])
def test_both_transports_accept_positive_finite_timeout(timeout):
    sync_stub = HttpStub(ENDPOINT, API_KEY, SERVICE_ID, timeout=timeout, client=object())
    async_stub = AsyncHttpStub(ENDPOINT, API_KEY, SERVICE_ID, timeout=timeout, client=object())

    assert sync_stub.endpoint == ENDPOINT
    assert async_stub.endpoint == ENDPOINT
