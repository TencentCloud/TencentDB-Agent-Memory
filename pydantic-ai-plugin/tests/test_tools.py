from __future__ import annotations

import unittest
from typing import Any

from pydantic_ai import Agent, models
from pydantic_ai.models.test import TestModel

from memory_tencentdb_pydantic_ai import (
    GatewayConnectionError,
    MemoryIdentity,
)
from memory_tencentdb_pydantic_ai.tools import create_memory_toolset

models.ALLOW_MODEL_REQUESTS = False


class RecordingSearchClient:
    def __init__(self, *, error: bool = False) -> None:
        self.error = error
        self.memory_calls: list[dict[str, Any]] = []
        self.conversation_calls: list[dict[str, Any]] = []

    async def asearch_memories(
        self,
        query: str,
        limit: int,
        memory_type: str | None,
        scene: str | None,
    ) -> dict[str, Any]:
        self.memory_calls.append(
            {
                "query": query,
                "limit": limit,
                "memory_type": memory_type,
                "scene": scene,
            }
        )
        if self.error:
            raise GatewayConnectionError("memory search", "offline")
        return {"results": "preference", "total": 1, "strategy": "hybrid"}

    async def asearch_conversations(
        self,
        query: str,
        limit: int,
        session_key: str | None,
    ) -> dict[str, Any]:
        self.conversation_calls.append(
            {
                "query": query,
                "limit": limit,
                "session_key": session_key,
            }
        )
        if self.error:
            raise GatewayConnectionError("conversation search", "offline")
        return {"results": "earlier turn", "total": 1}


class MemoryToolsTests(unittest.IsolatedAsyncioTestCase):
    async def test_toolset_registers_stable_names(self) -> None:
        model = TestModel(custom_output_text="ok")
        agent = Agent(model)
        toolset = create_memory_toolset(
            RecordingSearchClient(),
            MemoryIdentity.create("u", "s"),
            strict=False,
        )

        await agent.run("What tools are available?", toolsets=[toolset])

        parameters = model.last_model_request_parameters
        self.assertIsNotNone(parameters)
        names = [tool.name for tool in parameters.function_tools]
        self.assertEqual(names, ["memory_search", "conversation_search"])

    async def test_memory_search_runs_through_pydantic_ai(self) -> None:
        client = RecordingSearchClient()
        agent = Agent(TestModel(call_tools=["memory_search"]))
        toolset = create_memory_toolset(
            client,
            MemoryIdentity.create("u", "s"),
            strict=False,
        )

        await agent.run("Find my coffee preference", toolsets=[toolset])

        self.assertEqual(len(client.memory_calls), 1)
        self.assertTrue(client.memory_calls[0]["query"])

    async def test_conversation_search_uses_current_session_key(self) -> None:
        client = RecordingSearchClient()
        agent = Agent(TestModel(call_tools=["conversation_search"]))
        identity = MemoryIdentity.create(
            "u",
            "s",
            session_key="existing-session-key",
        )

        await agent.run(
            "Find an earlier turn",
            toolsets=[
                create_memory_toolset(client, identity, strict=False)
            ],
        )

        self.assertEqual(len(client.conversation_calls), 1)
        self.assertEqual(
            client.conversation_calls[0]["session_key"],
            "existing-session-key",
        )

    async def test_fail_open_tool_returns_unavailable_result(self) -> None:
        client = RecordingSearchClient(error=True)
        agent = Agent(TestModel(call_tools=["memory_search"]))
        toolset = create_memory_toolset(
            client,
            MemoryIdentity.create("u", "s"),
            strict=False,
        )

        with self.assertLogs(
            "memory_tencentdb_pydantic_ai.tools",
            level="WARNING",
        ) as logs:
            result = await agent.run("Search memory", toolsets=[toolset])

        self.assertEqual(len(client.memory_calls), 1)
        self.assertIn("memory service unavailable", str(result.output))
        self.assertNotIn("Search memory", "\n".join(logs.output))

    async def test_strict_tool_propagates_gateway_error(self) -> None:
        client = RecordingSearchClient(error=True)
        agent = Agent(TestModel(call_tools=["memory_search"]))
        toolset = create_memory_toolset(
            client,
            MemoryIdentity.create("u", "s"),
            strict=True,
        )

        with self.assertRaises(GatewayConnectionError):
            await agent.run("Search memory", toolsets=[toolset])


if __name__ == "__main__":
    unittest.main()
