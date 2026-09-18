"""Config validation tests."""

from __future__ import annotations

import pytest

from tdai_sk import ConfigError, TDAiConfig


def test_defaults_are_local_http():
    config = TDAiConfig()
    config.validate()  # loopback http is allowed by default


def test_remote_plaintext_http_rejected_by_default():
    config = TDAiConfig(gateway_url="http://memory.example.com:8420")
    with pytest.raises(ConfigError, match="plaintext HTTP"):
        config.validate()


def test_remote_plaintext_http_allowed_when_explicit():
    config = TDAiConfig(
        gateway_url="http://memory.example.com:8420", allow_remote_http=True
    )
    config.validate()


def test_remote_https_allowed():
    config = TDAiConfig(gateway_url="https://memory.example.com:8420")
    config.validate()


@pytest.mark.parametrize(
    "kwargs",
    [
        {"app_name": "  "},
        {"user_id": ""},
        {"timeout": 0},
        {"timeout": -1.0},
        {"max_context_chars": 0},
        {"gateway_url": "ftp://example.com"},
        {"gateway_url": "not-a-url"},
    ],
)
def test_invalid_values_rejected(kwargs):
    config = TDAiConfig(**kwargs)
    with pytest.raises(ConfigError):
        config.validate()


def test_facade_validates_on_construction(fake_gw):
    from tdai_sk import TencentDBAgentMemory

    with pytest.raises(ConfigError):
        TencentDBAgentMemory(TDAiConfig(gateway_url="http://remote.example.com"))


def test_facade_validation_can_be_deferred():
    from tdai_sk import TencentDBAgentMemory

    # validate_config=False is the escape hatch for callers that construct the
    # client themselves (e.g. proxies, tests, or non-HTTP transports).
    mem = TencentDBAgentMemory(
        TDAiConfig(gateway_url="http://placeholder"), validate_config=False
    )
    assert mem is not None
