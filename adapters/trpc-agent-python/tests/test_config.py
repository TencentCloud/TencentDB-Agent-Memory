"""Config validation tests."""

from __future__ import annotations

import pytest

from tdai_trpc import ConfigError, TDAiConfig


def test_defaults_are_local_http():
    TDAiConfig().validate()  # loopback http is allowed by default


def test_remote_plaintext_http_rejected_by_default():
    config = TDAiConfig(gateway_url="http://memory.example.com:8420")
    with pytest.raises(ConfigError, match="plaintext HTTP"):
        config.validate()


def test_remote_plaintext_http_allowed_when_explicit():
    TDAiConfig(
        gateway_url="http://memory.example.com:8420", allow_remote_http=True
    ).validate()


def test_remote_https_allowed():
    TDAiConfig(gateway_url="https://memory.example.com:8420").validate()


@pytest.mark.parametrize(
    "kwargs",
    [
        {"timeout": 0},
        {"timeout": -1.0},
        {"app_name": " "},
        {"user_id": ""},
        {"gateway_url": "ftp://example.com"},
        {"gateway_url": "not-a-url"},
    ],
)
def test_invalid_values_rejected(kwargs):
    with pytest.raises(ConfigError):
        TDAiConfig(**kwargs).validate()
