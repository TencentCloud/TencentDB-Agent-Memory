"""Regression tests for v3 transport option validation (#1760)."""

import math

import pytest

from tencentdb_agent_memory._v3_http import AsyncHttpStub, HttpStub, _validate_transport_options
from tencentdb_agent_memory.errors import ParamError

VALID = {
    "endpoint": "https://memory.example.com",
    "api_key": "key",
    "service_id": "service",
}


def _expect_rejected(timeout):
    with pytest.raises(ParamError):
        _validate_transport_options(timeout=timeout, **VALID)


def _expect_accepted(timeout):
    _validate_transport_options(timeout=timeout, **VALID)


def test_nan_timeout_is_rejected():
    _expect_rejected(float("nan"))


def test_positive_infinity_timeout_is_rejected():
    _expect_rejected(float("inf"))


@pytest.mark.parametrize("timeout", [0, -1, float("-inf")])
def test_non_positive_timeout_is_rejected(timeout):
    _expect_rejected(timeout)


def test_boolean_timeout_is_rejected():
    _expect_rejected(True)
    _expect_rejected(False)


@pytest.mark.parametrize("timeout", [1, 0.5, 30, float(2.0)])
def test_positive_finite_timeouts_are_accepted(timeout):
    _expect_accepted(timeout)
    assert math.isfinite(timeout)


def test_nan_timeout_rejected_by_construction():
    with pytest.raises(ParamError):
        HttpStub(timeout=float("nan"), **VALID)


def test_inf_timeout_rejected_by_construction():
    with pytest.raises(ParamError):
        HttpStub(timeout=float("inf"), **VALID)


def test_inf_timeout_rejected_by_async_construction():
    with pytest.raises(ParamError):
        AsyncHttpStub(timeout=float("inf"), **VALID)
