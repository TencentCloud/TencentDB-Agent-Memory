"""Real loopback HTTP wire tests.

The server returns fixtures, not model output.
"""

import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Tuple

from tencentdb_agent_memory.errors import ParamError, TDAMError
from tencentdb_agent_memory.v3 import (
    AsyncSkillClient,
    SkillClient,
    SkillPackageCandidate,
    SkillRestructureOperation,
    SkillRestructureOutput,
    SkillRestructureSource,
    SkillRestructureStatus,
)


OPERATION: SkillRestructureOperation = {
    "operation_id": "sro-" + "a" * 32,
    "status": "queued",
    "source_skill_id": "skl-source",
    "source_version": 2,
    "created_at_ms": 1,
    "updated_at_ms": 1,
    "attempts": 0,
    "outputs": [],
}
IDS: Dict[str, str] = {
    "team_id": "team",
    "agent_id": "agent",
    "user_id": "user",
    "task_id": "task",
}
CANDIDATE: SkillPackageCandidate = {
    "name": "guide", "content": "complete candidate",
    "resources": [{
        "path": "run",
        "content": "AP8=",
        "encoding": "base64",
        "mime_type": "application/x-test",
        "is_executable": True,
    }],
    "metadata": {"keep": True},
}


class WireServer:
    def start_server(self) -> None:
        self.seen: List[Tuple[str, Dict[str, Any], Dict[str, str]]] = []
        self.status = 200
        self.envelope: Dict[str, Any] = {
            "code": 0,
            "message": "ok",
            "request_id": "server-trace",
            "data": OPERATION,
        }
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                body = json.loads(
                    self.rfile.read(int(self.headers["Content-Length"]))
                )
                owner.seen.append((self.path, body, dict(self.headers)))
                data = json.dumps(owner.envelope).encode()
                self.send_response(owner.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args: Any) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(
            target=self.server.serve_forever, daemon=True,
        )
        self.thread.start()
        self.endpoint = f"http://127.0.0.1:{self.server.server_port}"

    def stop_server(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


class SkillRestructureWireTests(WireServer, unittest.TestCase):
    def setUp(self) -> None:
        self.start_server()
        self.client = SkillClient(
            self.endpoint, "test-key", "instance-a", **IDS,
        )

    def tearDown(self) -> None:
        self.client.close()
        self.stop_server()

    def test_existing_request_preserves_stable_intent_and_ids(self) -> None:
        params: Dict[str, Any] = {
            "request_id": "caller-stable",
            "skill_id": "skl-source",
            "expected_version": 2,
            "reason": "split responsibilities",
        }
        self.assertEqual(self.client.restructure(**params), OPERATION)
        self.assertEqual(self.client.restructure(**params), OPERATION)
        self.assertEqual(
            [item[0] for item in self.seen], ["/v3/skill/restructure"] * 2,
        )
        self.assertEqual(self.seen[0][1], {**IDS, **params})
        self.assertEqual(self.seen[1][1]["request_id"], "caller-stable")
        self.assertEqual(self.seen[0][2]["x-tdai-service-id"], "instance-a")

    def test_candidate_source_and_overrides_are_sent_without_crud(
        self,
    ) -> None:
        source: SkillRestructureSource = {
            "skill_id": "skl-source", "expected_version": 2,
        }
        self.client.restructure(
            request_id="candidate",
            candidate=CANDIDATE,
            source=source,
            team_id="other-team",
            agent_id="other-agent",
        )
        self.assertEqual(self.seen[0][0], "/v3/skill/restructure")
        self.assertEqual(self.seen[0][1], {
            **IDS,
            "team_id": "other-team",
            "agent_id": "other-agent",
            "request_id": "candidate",
            "candidate": CANDIDATE,
            "source": source,
        })
        self.assertNotIn("force", self.seen[0][1])
        self.assertNotIn("skill_id", self.seen[0][1])

    def test_operation_get_retains_isolation(self) -> None:
        self.assertEqual(
            self.client.restructure_get(
                OPERATION["operation_id"], user_id="other",
            ),
            OPERATION,
        )
        self.assertEqual(self.seen[0][0], "/v3/skill/restructure/get")
        self.assertEqual(self.seen[0][1], {
            **IDS,
            "user_id": "other",
            "operation_id": OPERATION["operation_id"],
        })

    def test_required_ids_are_never_invented(self) -> None:
        with self.assertRaises(ParamError):
            self.client.restructure(
                request_id=" ", skill_id="skl-source", expected_version=2,
            )
        with self.assertRaises(ParamError):
            self.client.restructure_get("")
        self.assertEqual(self.seen, [])

    def test_server_error_preserves_committed_registration_details(
        self,
    ) -> None:
        self.status = 503
        self.envelope = {
            "code": 50301,
            "message": "ASSET_REGISTRATION_PENDING",
            "request_id": "server-trace",
            "data": {"publication_committed": True},
        }
        with self.assertRaises(TDAMError) as caught:
            self.client.restructure(
                request_id="stable", skill_id="skl-source", expected_version=2,
            )
        self.assertEqual(caught.exception.code, 50301)
        self.assertEqual(caught.exception.request_id, "server-trace")
        self.assertEqual(
            caught.exception.details, {"publication_committed": True},
        )

    def test_dtos_are_exported_from_the_official_v3_entrypoint(self) -> None:
        self.assertIn("status", SkillRestructureOperation.__annotations__)
        self.assertIn("resources", SkillPackageCandidate.__annotations__)
        self.assertIn(
            "expected_version", SkillRestructureSource.__annotations__,
        )
        self.assertIn("reused", SkillRestructureOutput.__annotations__)
        self.assertIsNotNone(SkillRestructureStatus)


class AsyncSkillRestructureWireTests(
    WireServer, unittest.IsolatedAsyncioTestCase,
):
    async def asyncSetUp(self) -> None:
        self.start_server()
        self.client = AsyncSkillClient(
            self.endpoint, "test-key", "instance-a", **IDS,
        )

    async def asyncTearDown(self) -> None:
        await self.client.close()
        self.stop_server()

    async def test_async_existing_and_get_request_paths(self) -> None:
        self.assertEqual(
            await self.client.restructure(
                request_id="stable", skill_id="skl-source", expected_version=2,
            ),
            OPERATION,
        )
        self.assertEqual(
            await self.client.restructure_get(
                OPERATION["operation_id"], agent_id="other",
            ),
            OPERATION,
        )
        self.assertEqual(
            [item[0] for item in self.seen],
            ["/v3/skill/restructure", "/v3/skill/restructure/get"],
        )
        self.assertEqual(self.seen[0][1]["request_id"], "stable")
        self.assertEqual(self.seen[1][1]["agent_id"], "other")

    async def test_async_candidate_is_complete(self) -> None:
        await self.client.restructure(
            request_id="candidate", candidate=CANDIDATE,
        )
        self.assertEqual(self.seen[0][1], {
            **IDS, "request_id": "candidate", "candidate": CANDIDATE,
        })

    async def test_async_missing_request_id_is_not_generated(self) -> None:
        with self.assertRaises(ParamError):
            await self.client.restructure(
                request_id="", skill_id="skl-source", expected_version=2,
            )
        self.assertEqual(self.seen, [])

    async def test_async_business_error_is_unchanged(self) -> None:
        self.envelope = {
            "code": 40401,
            "message": "Operation not found",
            "request_id": "server-trace",
        }
        with self.assertRaises(TDAMError) as caught:
            await self.client.restructure_get(OPERATION["operation_id"])
        self.assertEqual(caught.exception.code, 40401)


if __name__ == "__main__":
    unittest.main()
