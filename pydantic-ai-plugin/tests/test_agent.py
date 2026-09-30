from __future__ import annotations

import unittest
from typing import Any

from pydantic import BaseModel
from pydantic_ai import Agent, FunctionToolset, ModelResponse, TextPart, models
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.models.test import TestModel

from memory_tencentdb_pydantic_ai import (
    GatewayConnectionError,
    TencentDBMemoryAgent,
)

models.ALLOW_MODEL_REQUESTS = False


class RecordingMemoryClient:
    def __init__(
        self,
        *,
        context: str = "",
        fail_recall: bool = False,
        fail_capture: bool = False,
        fail_session: bool = False,
        flushed: bool = True,
    ) -> None:
        self.context = context
        self.fail_recall = fail_recall
        self.fail_capture = fail_capture
        self.fail_session = fail_session
        self.flushed = flushed
        self.events: list[str] = []
        self.recalls: list[dict[str, Any]] = []
        self.captures: list[dict[str, Any]] = []
        self.sessions: list[dict[str, str]] = []

    async def arecall(
        self,
        query: str,
        session_key: str,
        user_id: str,
    ) -> dict[str, Any]:
        self.events.append("recall")
        self.recalls.append(
            {
                "query": query,
                "session_key": session_key,
                "user_id": user_id,
            }
        )
        if self.fail_recall:
            raise GatewayConnectionError("recall", "offline")
        return {"context": self.context, "memory_count": int(bool(self.context))}

    async def acapture(
        self,
        user_content: str,
        assistant_content: str,
        session_key: str,
        session_id: str,
        user_id: str,
    ) -> dict[str, Any]:
        self.events.append("capture")
        self.captures.append(
            {
                "user_content": user_content,
                "assistant_content": assistant_content,
                "session_key": session_key,
                "session_id": session_id,
                "user_id": user_id,
            }
        )
        if self.fail_capture:
            raise GatewayConnectionError("capture", "offline")
        return {"l0_recorded": 1, "scheduler_notified": True}

    async def asearch_memories(
        self,
        query: str,
        limit: int,
        memory_type: str | None,
        scene: str | None,
    ) -> dict[str, Any]:
        return {"results": "", "total": 0, "strategy": "none"}

    async def asearch_conversations(
        self,
        query: str,
        limit: int,
        session_key: str | None,
    ) -> dict[str, Any]:
        return {"results": "", "total": 0}

    async def aend_session(
        self,
        session_key: str,
        user_id: str,
    ) -> dict[str, Any]:
        self.events.append("session_end")
        self.sessions.append(
            {"session_key": session_key, "user_id": user_id}
        )
        if self.fail_session:
            raise GatewayConnectionError("session end", "offline")
        return {"flushed": self.flushed}

    def recall(
        self,
        query: str,
        session_key: str,
        user_id: str,
    ) -> dict[str, Any]:
        self.events.append("recall")
        self.recalls.append(
            {
                "query": query,
                "session_key": session_key,
                "user_id": user_id,
            }
        )
        if self.fail_recall:
            raise GatewayConnectionError("recall", "offline")
        return {"context": self.context, "memory_count": int(bool(self.context))}

    def capture(
        self,
        user_content: str,
        assistant_content: str,
        session_key: str,
        session_id: str,
        user_id: str,
    ) -> dict[str, Any]:
        self.events.append("capture")
        self.captures.append(
            {
                "user_content": user_content,
                "assistant_content": assistant_content,
                "session_key": session_key,
                "session_id": session_id,
                "user_id": user_id,
            }
        )
        if self.fail_capture:
            raise GatewayConnectionError("capture", "offline")
        return {"l0_recorded": 1, "scheduler_notified": True}

    def end_session(
        self,
        session_key: str,
        user_id: str,
    ) -> dict[str, Any]:
        self.events.append("session_end")
        self.sessions.append(
            {"session_key": session_key, "user_id": user_id}
        )
        if self.fail_session:
            raise GatewayConnectionError("session end", "offline")
        return {"flushed": self.flushed}


class StructuredAnswer(BaseModel):
    language: str
    score: int


class TencentDBMemoryAgentAsyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_run_recalls_then_captures_once(self) -> None:
        client = RecordingMemoryClient(
            context="The user prefers sugar-free coffee."
        )
        model = TestModel(custom_output_text="I will remember that.")
        wrapped = TencentDBMemoryAgent(Agent(model), client)

        result = await wrapped.run(
            "Remember my preference",
            user_id="u",
            session_id="s",
            instructions="Answer concisely.",
        )

        self.assertEqual(result.output, "I will remember that.")
        self.assertEqual(client.events, ["recall", "capture"])
        self.assertEqual(len(client.captures), 1)
        self.assertEqual(
            client.captures[0]["assistant_content"],
            result.output,
        )
        instructions = result.all_messages()[0].instructions
        self.assertIn("Answer concisely.", instructions)
        self.assertIn(
            "The user prefers sugar-free coffee.",
            instructions,
        )

    async def test_empty_recall_adds_no_memory_instruction(self) -> None:
        client = RecordingMemoryClient(context="")
        wrapped = TencentDBMemoryAgent(
            Agent(
                TestModel(custom_output_text="ok"),
                instructions="Original instruction.",
            ),
            client,
        )

        result = await wrapped.run("hello", user_id="u", session_id="s")

        instructions = result.all_messages()[0].instructions
        self.assertTrue(instructions.startswith("Original instruction."))
        self.assertNotIn(
            "TencentDB Agent Memory recalled",
            instructions,
        )

    async def test_caller_toolsets_are_preserved(self) -> None:
        client = RecordingMemoryClient()
        model = TestModel(custom_output_text="ok")
        existing = FunctionToolset()

        @existing.tool_plain
        def existing_tool() -> str:
            """Return an existing application value."""
            return "existing"

        wrapped = TencentDBMemoryAgent(Agent(model), client)

        await wrapped.run(
            "hello",
            user_id="u",
            session_id="s",
            toolsets=[existing],
        )

        parameters = model.last_model_request_parameters
        self.assertIsNotNone(parameters)
        self.assertEqual(
            [tool.name for tool in parameters.function_tools],
            ["existing_tool", "memory_search", "conversation_search"],
        )

    async def test_message_history_is_forwarded(self) -> None:
        agent = Agent(TestModel(custom_output_text="first"))
        first = await agent.run("first prompt")
        client = RecordingMemoryClient()
        wrapped = TencentDBMemoryAgent(agent, client)

        second = await wrapped.run(
            "second prompt",
            user_id="u",
            session_id="s",
            message_history=first.all_messages(),
        )

        all_messages = second.all_messages()
        self.assertGreater(len(all_messages), len(second.new_messages()))
        self.assertEqual(client.captures[0]["user_content"], "second prompt")

    async def test_structured_output_is_captured_as_stable_json(self) -> None:
        model = TestModel(
            custom_output_args={"language": "zh", "score": 9}
        )
        agent = Agent(model, output_type=StructuredAnswer)
        client = RecordingMemoryClient()
        wrapped = TencentDBMemoryAgent(agent, client)

        result = await wrapped.run(
            "return a score",
            user_id="u",
            session_id="s",
        )

        self.assertEqual(result.output.language, "zh")
        self.assertEqual(
            client.captures[0]["assistant_content"],
            '{"language":"zh","score":9}',
        )

    async def test_model_error_is_not_captured(self) -> None:
        def fail_model(
            _messages: list[Any],
            _info: Any,
        ) -> ModelResponse:
            raise RuntimeError("model failed")

        client = RecordingMemoryClient()
        wrapped = TencentDBMemoryAgent(
            Agent(FunctionModel(fail_model)),
            client,
        )

        with self.assertRaisesRegex(RuntimeError, "model failed"):
            await wrapped.run("hello", user_id="u", session_id="s")

        self.assertEqual(client.events, ["recall"])
        self.assertEqual(client.captures, [])

    async def test_non_text_prompt_is_rejected_before_recall(self) -> None:
        client = RecordingMemoryClient()
        wrapped = TencentDBMemoryAgent(
            Agent(TestModel(custom_output_text="unused")),
            client,
        )

        with self.assertRaisesRegex(TypeError, "text prompts"):
            await wrapped.run(  # type: ignore[arg-type]
                ["not", "text"],
                user_id="u",
                session_id="s",
            )

        self.assertEqual(client.events, [])

    async def test_fail_open_recall_runs_without_context(self) -> None:
        client = RecordingMemoryClient(fail_recall=True)
        wrapped = TencentDBMemoryAgent(
            Agent(TestModel(custom_output_text="answer")),
            client,
        )

        with self.assertLogs(
            "memory_tencentdb_pydantic_ai.agent",
            level="WARNING",
        ) as logs:
            result = await wrapped.run(
                "private prompt",
                user_id="u",
                session_id="s",
            )

        self.assertEqual(result.output, "answer")
        self.assertEqual(client.events, ["recall", "capture"])
        self.assertNotIn("private prompt", "\n".join(logs.output))

    async def test_fail_open_capture_preserves_result(self) -> None:
        client = RecordingMemoryClient(fail_capture=True)
        wrapped = TencentDBMemoryAgent(
            Agent(TestModel(custom_output_text="answer")),
            client,
        )

        with self.assertLogs(
            "memory_tencentdb_pydantic_ai.agent",
            level="WARNING",
        ):
            result = await wrapped.run(
                "hello",
                user_id="u",
                session_id="s",
            )

        self.assertEqual(result.output, "answer")
        self.assertEqual(client.events, ["recall", "capture"])

    async def test_strict_recall_propagates_gateway_error(self) -> None:
        client = RecordingMemoryClient(fail_recall=True)
        wrapped = TencentDBMemoryAgent(
            Agent(TestModel(custom_output_text="unused")),
            client,
            strict=True,
        )

        with self.assertRaises(GatewayConnectionError):
            await wrapped.run("hello", user_id="u", session_id="s")

        self.assertEqual(client.events, ["recall"])

    async def test_strict_capture_propagates_gateway_error(self) -> None:
        client = RecordingMemoryClient(fail_capture=True)
        wrapped = TencentDBMemoryAgent(
            Agent(TestModel(custom_output_text="answer")),
            client,
            strict=True,
        )

        with self.assertRaises(GatewayConnectionError):
            await wrapped.run("hello", user_id="u", session_id="s")

        self.assertEqual(client.events, ["recall", "capture"])

    async def test_end_session_uses_explicit_session_key(self) -> None:
        client = RecordingMemoryClient(flushed=True)
        wrapped = TencentDBMemoryAgent(
            Agent(TestModel(custom_output_text="unused")),
            client,
        )

        flushed = await wrapped.end_session(
            user_id="u",
            session_id="s",
            session_key="shared-existing-key",
        )

        self.assertTrue(flushed)
        self.assertEqual(
            client.sessions,
            [{"session_key": "shared-existing-key", "user_id": "u"}],
        )

    async def test_end_session_fail_open_returns_false(self) -> None:
        client = RecordingMemoryClient(fail_session=True)
        wrapped = TencentDBMemoryAgent(
            Agent(TestModel(custom_output_text="unused")),
            client,
        )

        with self.assertLogs(
            "memory_tencentdb_pydantic_ai.agent",
            level="WARNING",
        ):
            flushed = await wrapped.end_session(
                user_id="u",
                session_id="s",
            )

        self.assertFalse(flushed)

    async def test_end_session_strict_propagates_gateway_error(self) -> None:
        client = RecordingMemoryClient(fail_session=True)
        wrapped = TencentDBMemoryAgent(
            Agent(TestModel(custom_output_text="unused")),
            client,
            strict=True,
        )

        with self.assertRaises(GatewayConnectionError):
            await wrapped.end_session(user_id="u", session_id="s")


class TencentDBMemoryAgentSyncTests(unittest.TestCase):
    def test_run_sync_matches_async_lifecycle(self) -> None:
        client = RecordingMemoryClient(context="Known preference")
        wrapped = TencentDBMemoryAgent(
            Agent(TestModel(custom_output_text="answer")),
            client,
        )

        result = wrapped.run_sync(
            "question",
            user_id="u",
            session_id="s",
        )

        self.assertEqual(result.output, "answer")
        self.assertEqual(client.events, ["recall", "capture"])
        self.assertIn(
            "Known preference",
            result.all_messages()[0].instructions,
        )

    def test_run_sync_fail_open_capture_preserves_result(self) -> None:
        client = RecordingMemoryClient(fail_capture=True)
        wrapped = TencentDBMemoryAgent(
            Agent(TestModel(custom_output_text="answer")),
            client,
        )

        with self.assertLogs(
            "memory_tencentdb_pydantic_ai.agent",
            level="WARNING",
        ):
            result = wrapped.run_sync(
                "question",
                user_id="u",
                session_id="s",
            )

        self.assertEqual(result.output, "answer")
        self.assertEqual(client.events, ["recall", "capture"])

    def test_end_session_sync_returns_flushed(self) -> None:
        client = RecordingMemoryClient(flushed=True)
        wrapped = TencentDBMemoryAgent(
            Agent(TestModel(custom_output_text="unused")),
            client,
        )

        flushed = wrapped.end_session_sync(
            user_id="u",
            session_id="s",
        )

        self.assertTrue(flushed)
        self.assertEqual(
            client.sessions[0]["session_key"],
            "pydantic-ai:u:s",
        )

    def test_end_session_sync_fail_open_returns_false(self) -> None:
        client = RecordingMemoryClient(fail_session=True)
        wrapped = TencentDBMemoryAgent(
            Agent(TestModel(custom_output_text="unused")),
            client,
        )

        with self.assertLogs(
            "memory_tencentdb_pydantic_ai.agent",
            level="WARNING",
        ):
            flushed = wrapped.end_session_sync(
                user_id="u",
                session_id="s",
            )

        self.assertFalse(flushed)


if __name__ == "__main__":
    unittest.main()
