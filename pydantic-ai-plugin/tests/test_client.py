from __future__ import annotations

import unittest

from fake_gateway import FakeGateway
from memory_tencentdb_pydantic_ai import (
    GatewayClient,
    GatewayConnectionError,
    GatewayHTTPError,
    GatewayResponseError,
)


class GatewayClientConfigurationTests(unittest.TestCase):
    def test_rejects_invalid_base_urls(self) -> None:
        invalid_urls = (
            "ftp://127.0.0.1:8420",
            "http:///missing-host",
            "http://user:pass@localhost:8420",
            "http://localhost:8420?token=secret",
            "http://localhost:8420/#fragment",
        )

        for url in invalid_urls:
            with self.subTest(url=url):
                with self.assertRaises(ValueError):
                    GatewayClient(url)

    def test_repr_never_contains_api_key(self) -> None:
        client = GatewayClient("http://127.0.0.1:8420", api_key="top-secret")

        rendered = repr(client)

        self.assertNotIn("top-secret", rendered)
        self.assertIn("authenticated=True", rendered)


class GatewayClientTransportTests(unittest.TestCase):
    def test_health_uses_get_and_validates_response(self) -> None:
        with FakeGateway() as gateway:
            gateway.enqueue(
                200,
                {
                    "status": "ok",
                    "version": "0.3.6",
                    "uptime": 3,
                    "stores": {
                        "vectorStore": True,
                        "embeddingService": False,
                    },
                },
            )
            result = GatewayClient(gateway.url).health()

        self.assertEqual(result["status"], "ok")
        self.assertEqual(gateway.requests[0].method, "GET")
        self.assertEqual(gateway.requests[0].path, "/health")

    def test_health_type_error_uses_gateway_response_error(self) -> None:
        with FakeGateway() as gateway:
            gateway.enqueue(
                200,
                {
                    "status": "ok",
                    "version": "0.3.6",
                    "uptime": "not-a-number",
                    "stores": {},
                },
            )

            with self.assertRaisesRegex(GatewayResponseError, "uptime"):
                GatewayClient(gateway.url).health()

    def test_recall_sends_identity_unicode_and_bearer_token(self) -> None:
        with FakeGateway() as gateway:
            gateway.enqueue(
                200,
                {"context": "偏好无糖咖啡", "memory_count": 1},
            )
            client = GatewayClient(gateway.url, api_key=" secret ")
            result = client.recall("喝什么？", "pydantic-ai:u:s", "用户一")

        self.assertEqual(result["context"], "偏好无糖咖啡")
        self.assertEqual(
            gateway.requests[0].headers["Authorization"],
            "Bearer secret",
        )
        self.assertEqual(
            gateway.requests[0].json,
            {
                "query": "喝什么？",
                "session_key": "pydantic-ai:u:s",
                "user_id": "用户一",
            },
        )

    def test_capture_sends_complete_turn(self) -> None:
        with FakeGateway() as gateway:
            gateway.enqueue(
                200,
                {"l0_recorded": 1, "scheduler_notified": True},
            )
            result = GatewayClient(gateway.url).capture(
                "问题",
                "答案",
                "session-key",
                "session-id",
                "user-id",
            )

        self.assertEqual(result["l0_recorded"], 1)
        self.assertEqual(gateway.requests[0].path, "/capture")
        self.assertEqual(
            gateway.requests[0].json,
            {
                "user_content": "问题",
                "assistant_content": "答案",
                "session_key": "session-key",
                "session_id": "session-id",
                "user_id": "user-id",
            },
        )

    def test_memory_search_sends_optional_filters(self) -> None:
        with FakeGateway() as gateway:
            gateway.enqueue(
                200,
                {"results": "match", "total": 1, "strategy": "hybrid"},
            )
            result = GatewayClient(gateway.url).search_memories(
                "coffee",
                limit=3,
                memory_type="preference",
                scene="daily",
            )

        self.assertEqual(result["strategy"], "hybrid")
        self.assertEqual(
            gateway.requests[0].json,
            {
                "query": "coffee",
                "limit": 3,
                "type": "preference",
                "scene": "daily",
            },
        )

    def test_conversation_search_is_scoped_to_session(self) -> None:
        with FakeGateway() as gateway:
            gateway.enqueue(200, {"results": "turn", "total": 1})
            result = GatewayClient(gateway.url).search_conversations(
                "earlier", limit=4, session_key="scope"
            )

        self.assertEqual(result["total"], 1)
        self.assertEqual(
            gateway.requests[0].json,
            {"query": "earlier", "limit": 4, "session_key": "scope"},
        )

    def test_end_session_returns_flush_status(self) -> None:
        with FakeGateway() as gateway:
            gateway.enqueue(200, {"flushed": True})
            result = GatewayClient(gateway.url).end_session("scope", "u")

        self.assertTrue(result["flushed"])
        self.assertEqual(gateway.requests[0].path, "/session/end")
        self.assertEqual(
            gateway.requests[0].json,
            {"session_key": "scope", "user_id": "u"},
        )

    def test_capture_is_never_retried(self) -> None:
        with FakeGateway() as gateway:
            gateway.enqueue(503, {"error": "temporary"})
            client = GatewayClient(gateway.url, retries=3, retry_delay=0)

            with self.assertRaises(GatewayHTTPError) as caught:
                client.capture("q", "a", "key", "sid", "uid")

        self.assertEqual(caught.exception.status_code, 503)
        self.assertEqual(len(gateway.requests), 1)

    def test_safe_search_retries_transient_server_error(self) -> None:
        with FakeGateway() as gateway:
            gateway.enqueue(503, {"error": "temporary"})
            gateway.enqueue(
                200,
                {"results": "found", "total": 1, "strategy": "fts"},
            )
            client = GatewayClient(gateway.url, retries=1, retry_delay=0)
            result = client.search_memories("query")

        self.assertEqual(result["total"], 1)
        self.assertEqual(len(gateway.requests), 2)

    def test_authentication_error_is_not_retried(self) -> None:
        with FakeGateway() as gateway:
            gateway.enqueue(401, {"error": "unauthorized"})
            client = GatewayClient(gateway.url, retries=3, retry_delay=0)

            with self.assertRaises(GatewayHTTPError) as caught:
                client.recall("q", "key", "u")

        self.assertEqual(caught.exception.status_code, 401)
        self.assertEqual(len(gateway.requests), 1)

    def test_invalid_json_is_a_response_error(self) -> None:
        with FakeGateway() as gateway:
            gateway.enqueue(200, b"not-json", content_type="text/plain")

            with self.assertRaises(GatewayResponseError):
                GatewayClient(gateway.url).recall("q", "key", "u")

    def test_non_object_json_is_a_response_error(self) -> None:
        with FakeGateway() as gateway:
            gateway.enqueue(200, ["not", "an", "object"])

            with self.assertRaises(GatewayResponseError):
                GatewayClient(gateway.url).recall("q", "key", "u")

    def test_missing_required_response_field_is_rejected(self) -> None:
        with FakeGateway() as gateway:
            gateway.enqueue(200, {"memory_count": 0})

            with self.assertRaisesRegex(GatewayResponseError, "context"):
                GatewayClient(gateway.url).recall("q", "key", "u")

    def test_timeout_is_a_connection_error(self) -> None:
        with FakeGateway() as gateway:
            gateway.enqueue(200, {"context": "late"}, delay=0.1)
            client = GatewayClient(gateway.url, timeout=0.01, retries=0)

            with self.assertRaises(GatewayConnectionError):
                client.recall("q", "key", "u")


class GatewayClientAsyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_async_recall_uses_same_contract(self) -> None:
        with FakeGateway() as gateway:
            gateway.enqueue(200, {"context": "async", "memory_count": 1})
            result = await GatewayClient(gateway.url).arecall(
                "q", "key", "u"
            )

        self.assertEqual(result["context"], "async")
        self.assertEqual(gateway.requests[0].path, "/recall")


if __name__ == "__main__":
    unittest.main()
