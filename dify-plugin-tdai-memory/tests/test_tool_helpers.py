from __future__ import annotations

import sys
import unittest
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
PLUGIN_ROOT_TEXT = str(PLUGIN_ROOT)
if PLUGIN_ROOT_TEXT not in sys.path:
    sys.path.insert(0, PLUGIN_ROOT_TEXT)

from tools.base import (  # noqa: E402
    DEFAULT_MAX_CHARS,
    MAX_CHARS_LIMIT,
    TEXT_TRUNCATED_MARKER,
    TdaiToolMixin,
    build_error_payload,
    normalize_limit,
    truncate_text,
)
from tools.client import TdaiGatewayError  # noqa: E402


class _StubRuntime:
    def __init__(self, credentials: dict[str, object] | None = None) -> None:
        self.credentials = credentials or {}


class ToolHelpersTest(unittest.TestCase):
    def test_truncate_text_keeps_short_text_unchanged(self) -> None:
        self.assertEqual(truncate_text("short memory", 50), "short memory")
        self.assertEqual(truncate_text("", 10), "")

    def test_truncate_text_marks_long_text(self) -> None:
        self.assertEqual(truncate_text("abcdef", 4), f"abcd{TEXT_TRUNCATED_MARKER}")

    def test_truncate_text_exact_boundary_is_not_truncated(self) -> None:
        self.assertEqual(truncate_text("abcd", 4), "abcd")

    def test_truncate_text_defaults_max_chars(self) -> None:
        short_text = "x" * 1500
        long_text = "x" * 2500

        self.assertEqual(truncate_text(short_text, None), short_text)
        self.assertEqual(truncate_text(long_text, None), "x" * DEFAULT_MAX_CHARS + TEXT_TRUNCATED_MARKER)

    def test_truncate_text_non_positive_limit_returns_full_text(self) -> None:
        self.assertEqual(truncate_text("hello", 0), "hello")
        self.assertEqual(truncate_text("hello", -1), "hello")

    def test_normalize_limit_bounds_values(self) -> None:
        self.assertEqual(normalize_limit(None), 5)
        self.assertEqual(normalize_limit(-5), 1)
        self.assertEqual(normalize_limit(0), 1)
        self.assertEqual(normalize_limit("0"), 1)
        self.assertEqual(normalize_limit("200"), 50)
        self.assertEqual(normalize_limit("bad"), 5)

    def test_normalize_limit_preserves_values_within_bounds(self) -> None:
        self.assertEqual(normalize_limit("10"), 10)
        self.assertEqual(normalize_limit(25), 25)

    def test_build_error_payload_keeps_tool_result_non_throwing(self) -> None:
        payload = build_error_payload("recall", RuntimeError("gateway down secret=abc"))

        self.assertEqual(payload["ok"], False)
        self.assertEqual(payload["operation"], "recall")
        self.assertEqual(payload["error"], "recall failed: RuntimeError")
        self.assertEqual(payload["error_type"], "RuntimeError")
        self.assertNotIn("secret=abc", payload["error"])

    def test_build_error_payload_uses_exception_class_for_empty_message(self) -> None:
        payload = build_error_payload("recall", RuntimeError())

        self.assertEqual(payload["error"], "recall failed: RuntimeError")

    def test_build_error_payload_formats_gateway_error_with_status(self) -> None:
        error = TdaiGatewayError("Unauthorized secret=abc", status_code=401, code="UNAUTHORIZED")

        payload = build_error_payload("recall", error)

        self.assertEqual(payload["error"], "recall failed: Gateway returned HTTP 401")
        self.assertEqual(payload["error_type"], "TdaiGatewayError")
        self.assertEqual(payload["status_code"], 401)
        self.assertEqual(payload["code"], "UNAUTHORIZED")
        self.assertNotIn("secret=abc", payload["error"])

    def test_build_error_payload_formats_gateway_error_without_status(self) -> None:
        payload = build_error_payload("recall", TdaiGatewayError("connection refused"))

        self.assertEqual(payload["error"], "recall failed: Gateway request failed")
        self.assertEqual(payload["error_type"], "TdaiGatewayError")
        self.assertNotIn("status_code", payload)
        self.assertNotIn("code", payload)

    def test_tool_mixin_text_helper_normalizes_values(self) -> None:
        self.assertEqual(TdaiToolMixin._text({"query": "  hello  "}, "query"), "hello")
        self.assertEqual(TdaiToolMixin._text({"query": None}, "query", "fallback"), "fallback")
        self.assertEqual(TdaiToolMixin._text({}, "query", "fallback"), "fallback")
        self.assertEqual(TdaiToolMixin._text({"query": "   "}, "query"), "")
        self.assertEqual(TdaiToolMixin._text({"query": 42}, "query"), "42")

    def test_tool_mixin_max_chars_bounds_values(self) -> None:
        self.assertEqual(TdaiToolMixin._max_chars({}), DEFAULT_MAX_CHARS)
        self.assertEqual(TdaiToolMixin._max_chars({"max_chars": 0}), 0)
        self.assertEqual(TdaiToolMixin._max_chars({"max_chars": "500"}), 500)
        self.assertEqual(TdaiToolMixin._max_chars({"max_chars": "bad"}), DEFAULT_MAX_CHARS)
        self.assertEqual(TdaiToolMixin._max_chars({"max_chars": 30_000}), MAX_CHARS_LIMIT)

    def test_tool_mixin_client_requires_runtime_credentials(self) -> None:
        mixin = TdaiToolMixin()
        with self.assertRaises(TdaiGatewayError):
            mixin._client()

        mixin.runtime = _StubRuntime()
        with self.assertRaises(TdaiGatewayError):
            mixin._client()

    def test_tool_mixin_client_uses_runtime_credentials(self) -> None:
        mixin = TdaiToolMixin()
        mixin.runtime = _StubRuntime(
            {
                "gateway_url": "http://127.0.0.1:8420",
                "gateway_api_key": "test-key",
                "gateway_timeout_seconds": 5,
            }
        )

        client = mixin._client()

        self.assertEqual(client.base_url, "http://127.0.0.1:8420")
        self.assertEqual(client.api_key, "test-key")
        self.assertEqual(client.timeout, 5)
