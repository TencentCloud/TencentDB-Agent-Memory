import asyncio
import unittest

import httpx

from tencentdb_agent_memory._v3_http import AsyncHttpStub, HttpStub
from tencentdb_agent_memory.errors import TDAMError


class ResponseDataTest(unittest.TestCase):
    def request(self, envelope, asynchronous=False):
        transport = httpx.MockTransport(
            lambda request: httpx.Response(
                200, json=envelope, headers={"x-trace-id": "test-trace"}
            )
        )
        if asynchronous:
            async def run():
                async with httpx.AsyncClient(transport=transport) as client:
                    stub = AsyncHttpStub(
                        "https://example.test", "test-key", "default", client=client
                    )
                    return await stub.post("/v3/test", {})
            return asyncio.run(run())
        with httpx.Client(transport=transport) as client:
            stub = HttpStub(
                "https://example.test", "test-key", "default", client=client
            )
            return stub.post("/v3/test", {})

    def test_rejects_non_object_data_in_sync_and_async_responses(self):
        for asynchronous in (False, True):
            for data in ([], False, 0, "", [1], True, 1, "text"):
                with self.subTest(asynchronous=asynchronous, data=data):
                    with self.assertRaises(TDAMError) as caught:
                        self.request({"code": 0, "data": data}, asynchronous)
                    self.assertEqual(caught.exception.code, -1)
                    self.assertEqual(
                        caught.exception.message,
                        "API response data must be a JSON object",
                    )
                    self.assertEqual(caught.exception.request_id, "test-trace")

    def test_preserves_objects_and_optional_data(self):
        for asynchronous in (False, True):
            for envelope, expected in (
                ({"code": 0}, {}),
                ({"code": 0, "data": None}, {}),
                ({"code": 0, "data": {}}, {}),
                ({"code": 0, "data": {"items": []}}, {"items": []}),
            ):
                with self.subTest(asynchronous=asynchronous, envelope=envelope):
                    self.assertEqual(
                        self.request(envelope, asynchronous),
                        {**expected, "trace_id": "test-trace"},
                    )


if __name__ == "__main__":
    unittest.main()
