from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any

import pytest
from pydantic import BaseModel
from pydantic_ai import Agent, BinaryContent
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
from pydantic_ai.models.function import FunctionModel

from tdai_pydantic_ai.client import TdaiGatewayError


@dataclass
class FakeGatewayClient:
    recall_context: str = "Remembered preference"
    fail_routes: set[str] = field(default_factory=set)
    calls: list[tuple[str, dict[str, Any]]] = field(default_factory=list)

    async def recall(
        self,
        query: str,
        session_key: str,
        user_id: str = "",
    ) -> dict[str, Any]:
        self.calls.append(
            (
                "recall",
                {
                    "query": query,
                    "session_key": session_key,
                    "user_id": user_id,
                },
            )
        )
        if "recall" in self.fail_routes:
            raise TdaiGatewayError("/recall", "unavailable")
        return {"context": self.recall_context}

    async def capture(
        self,
        user_content: str,
        assistant_content: str,
        session_key: str,
        session_id: str = "",
        user_id: str = "",
    ) -> dict[str, Any]:
        self.calls.append(
            (
                "capture",
                {
                    "user_content": user_content,
                    "assistant_content": assistant_content,
                    "session_key": session_key,
                    "session_id": session_id,
                    "user_id": user_id,
                },
            )
        )
        if "capture" in self.fail_routes:
            raise TdaiGatewayError("/capture", "unavailable")
        return {"l0_recorded": 2, "scheduler_notified": True}

    async def search_memories(
        self,
        query: str,
        limit: int = 5,
        type_filter: str = "",
        scene: str = "",
    ) -> dict[str, Any]:
        self.calls.append(
            (
                "search_memories",
                {
                    "query": query,
                    "limit": limit,
                    "type_filter": type_filter,
                    "scene": scene,
                },
            )
        )
        if "search_memories" in self.fail_routes:
            raise TdaiGatewayError("/search/memories", "unavailable")
        return {"results": "memory result", "total": 1, "strategy": "hybrid"}

    async def search_conversations(
        self,
        query: str,
        limit: int = 5,
        session_key: str = "",
    ) -> dict[str, Any]:
        self.calls.append(
            (
                "search_conversations",
                {
                    "query": query,
                    "limit": limit,
                    "session_key": session_key,
                },
            )
        )
        if "search_conversations" in self.fail_routes:
            raise TdaiGatewayError("/search/conversations", "unavailable")
        return {"results": "conversation result", "total": 1}

    async def health(self) -> dict[str, Any]:
        self.calls.append(("health", {}))
        if "health" in self.fail_routes:
            raise TdaiGatewayError("/health", "unavailable")
        return {"status": "ok"}

    async def end_session(
        self,
        session_key: str,
        user_id: str = "",
    ) -> dict[str, Any]:
        self.calls.append(
            (
                "end_session",
                {"session_key": session_key, "user_id": user_id},
            )
        )
        if "end_session" in self.fail_routes:
            raise TdaiGatewayError("/session/end", "unavailable")
        return {"flushed": True}


@dataclass
class RunDeps:
    session_key: str
    user_id: str


async def test_recall_is_injected_and_successful_run_is_captured() -> None:
    """Break caught: lifecycle hooks failing to recall before or capture after a run."""
    from tdai_pydantic_ai.capability import TencentDBMemoryCapability

    fake = FakeGatewayClient()
    seen_instructions: list[str | None] = []

    async def model_function(messages, info):
        seen_instructions.append(info.instructions)
        return ModelResponse(parts=[TextPart("final answer")])

    memory = TencentDBMemoryCapability(
        client=fake,
        session_key=lambda ctx: ctx.deps.session_key,
        user_id=lambda ctx: ctx.deps.user_id,
    )
    agent = Agent(
        FunctionModel(model_function),
        deps_type=RunDeps,
        capabilities=[memory],
    )

    result = await agent.run(
        "remember my editor",
        deps=RunDeps(session_key="session-a", user_id="user-a"),
    )

    assert result.output == "final answer"
    assert seen_instructions == ["Remembered preference"]
    assert fake.calls == [
        (
            "recall",
            {
                "query": "remember my editor",
                "session_key": "session-a",
                "user_id": "user-a",
            },
        ),
        (
            "capture",
            {
                "user_content": "remember my editor",
                "assistant_content": "final answer",
                "session_key": "session-a",
                "session_id": "",
                "user_id": "user-a",
            },
        ),
    ]


async def test_recall_failure_is_fail_open_and_logs_no_content(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Break caught: recall outages blocking runs or leaking private content."""
    from tdai_pydantic_ai.capability import TencentDBMemoryCapability

    fake = FakeGatewayClient(fail_routes={"recall"})
    seen_instructions: list[str | None] = []

    async def model_function(messages, info):
        seen_instructions.append(info.instructions)
        return ModelResponse(parts=[TextPart("private answer")])

    agent = Agent(
        FunctionModel(model_function),
        capabilities=[
            TencentDBMemoryCapability(
                client=fake,
                session_key="session-a",
                user_id="user-a",
            )
        ],
    )

    with caplog.at_level(logging.WARNING):
        result = await agent.run("private prompt")

    assert result.output == "private answer"
    assert seen_instructions == [None]
    assert "/recall" in caplog.text
    assert "private prompt" not in caplog.text
    assert "private answer" not in caplog.text


async def test_capture_failure_is_fail_open_and_logs_no_content(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Break caught: capture outages replacing an otherwise successful result."""
    from tdai_pydantic_ai.capability import TencentDBMemoryCapability

    fake = FakeGatewayClient(fail_routes={"capture"})

    async def model_function(messages, info):
        return ModelResponse(parts=[TextPart("private answer")])

    agent = Agent(
        FunctionModel(model_function),
        capabilities=[
            TencentDBMemoryCapability(
                client=fake,
                session_key="session-a",
                user_id="user-a",
            )
        ],
    )

    with caplog.at_level(logging.WARNING):
        result = await agent.run("private prompt")

    assert result.output == "private answer"
    assert "/capture" in caplog.text
    assert "private prompt" not in caplog.text
    assert "private answer" not in caplog.text


async def test_empty_session_key_fails_before_model_request() -> None:
    """Break caught: anonymous runs mixing memory under an empty session key."""
    from tdai_pydantic_ai.capability import TencentDBMemoryCapability

    model_called = False

    async def model_function(messages, info):
        nonlocal model_called
        model_called = True
        return ModelResponse(parts=[TextPart("should not run")])

    agent = Agent(
        FunctionModel(model_function),
        capabilities=[TencentDBMemoryCapability(session_key="  ")],
    )

    with pytest.raises(ValueError, match="session key must not be empty"):
        await agent.run("hello")

    assert model_called is False


async def test_recall_is_cached_across_model_steps() -> None:
    """Break caught: repeated model steps causing duplicate recall requests."""
    from tdai_pydantic_ai.capability import TencentDBMemoryCapability

    fake = FakeGatewayClient()
    seen_instructions: list[str | None] = []

    async def model_function(messages, info):
        seen_instructions.append(info.instructions)
        if len(seen_instructions) == 1:
            return ModelResponse(
                parts=[ToolCallPart("echo", {"text": "continue"})]
            )
        return ModelResponse(parts=[TextPart("final answer")])

    async def echo(text: str) -> str:
        return text

    agent = Agent(
        FunctionModel(model_function),
        tools=[echo],
        capabilities=[
            TencentDBMemoryCapability(
                client=fake,
                session_key="session-a",
                user_id="user-a",
            )
        ],
    )

    result = await agent.run("remember this")

    assert result.output == "final answer"
    assert seen_instructions == [
        "Remembered preference",
        "Remembered preference",
    ]
    assert [name for name, _ in fake.calls].count("recall") == 1


class StructuredAnswer(BaseModel):
    zed: int
    alpha: str


async def test_structured_output_is_captured_as_stable_json() -> None:
    """Break caught: structured answers being captured as unstable repr strings."""
    from tdai_pydantic_ai.capability import TencentDBMemoryCapability

    fake = FakeGatewayClient()

    async def model_function(messages, info):
        return ModelResponse(
            parts=[
                ToolCallPart(
                    info.output_tools[0].name,
                    {"zed": 2, "alpha": "value"},
                )
            ]
        )

    agent = Agent(
        FunctionModel(model_function),
        output_type=StructuredAnswer,
        capabilities=[
            TencentDBMemoryCapability(
                client=fake,
                session_key="session-a",
            )
        ],
    )

    result = await agent.run("make structure")

    assert result.output == StructuredAnswer(zed=2, alpha="value")
    capture = next(payload for name, payload in fake.calls if name == "capture")
    assert capture["assistant_content"] == '{"alpha":"value","zed":2}'


async def test_prompt_sequence_captures_only_text_members() -> None:
    """Break caught: binary prompt content being stringified into memory."""
    from tdai_pydantic_ai.capability import TencentDBMemoryCapability

    fake = FakeGatewayClient()

    async def model_function(messages, info):
        return ModelResponse(parts=[TextPart("answer")])

    agent = Agent(
        FunctionModel(model_function),
        capabilities=[
            TencentDBMemoryCapability(client=fake, session_key="session-a")
        ],
    )

    await agent.run(
        [
            " first ",
            BinaryContent(data=b"image", media_type="image/png"),
            "second",
        ]
    )

    recall = next(payload for name, payload in fake.calls if name == "recall")
    capture = next(payload for name, payload in fake.calls if name == "capture")
    assert recall["query"] == "first\nsecond"
    assert capture["user_content"] == "first\nsecond"


async def test_prompt_without_text_skips_recall_and_capture() -> None:
    """Break caught: binary-only prompts storing meaningless serialized data."""
    from tdai_pydantic_ai.capability import TencentDBMemoryCapability

    fake = FakeGatewayClient()

    async def model_function(messages, info):
        return ModelResponse(parts=[TextPart("answer")])

    agent = Agent(
        FunctionModel(model_function),
        capabilities=[
            TencentDBMemoryCapability(client=fake, session_key="session-a")
        ],
    )

    result = await agent.run(
        [BinaryContent(data=b"image", media_type="image/png")]
    )

    assert result.output == "answer"
    assert fake.calls == []


async def test_concurrent_runs_keep_identity_and_recall_isolated() -> None:
    """Break caught: one shared capability leaking run-scoped state across users."""
    from tdai_pydantic_ai.capability import TencentDBMemoryCapability

    @dataclass
    class ConcurrentFake(FakeGatewayClient):
        async def recall(
            self,
            query: str,
            session_key: str,
            user_id: str = "",
        ) -> dict[str, Any]:
            self.calls.append(
                (
                    "recall",
                    {
                        "query": query,
                        "session_key": session_key,
                        "user_id": user_id,
                    },
                )
            )
            await asyncio.sleep(0.01)
            return {"context": f"context:{session_key}:{user_id}"}

    fake = ConcurrentFake()

    async def model_function(messages, info):
        await asyncio.sleep(0)
        return ModelResponse(parts=[TextPart(info.instructions or "")])

    memory = TencentDBMemoryCapability(
        client=fake,
        session_key=lambda ctx: ctx.deps.session_key,
        user_id=lambda ctx: ctx.deps.user_id,
    )
    agent = Agent(
        FunctionModel(model_function),
        deps_type=RunDeps,
        capabilities=[memory],
    )

    first, second = await asyncio.gather(
        agent.run(
            "first prompt",
            deps=RunDeps(session_key="session-a", user_id="user-a"),
        ),
        agent.run(
            "second prompt",
            deps=RunDeps(session_key="session-b", user_id="user-b"),
        ),
    )

    assert {
        first.output,
        second.output,
    } == {
        "context:session-a:user-a",
        "context:session-b:user-b",
    }
    recalls = [payload for name, payload in fake.calls if name == "recall"]
    captures = [payload for name, payload in fake.calls if name == "capture"]
    assert {
        (
            payload["session_key"],
            payload["user_id"],
            payload["query"],
        )
        for payload in recalls
    } == {
        ("session-a", "user-a", "first prompt"),
        ("session-b", "user-b", "second prompt"),
    }
    assert {
        (
            payload["session_key"],
            payload["user_id"],
            payload["user_content"],
            payload["assistant_content"],
        )
        for payload in captures
    } == {
        (
            "session-a",
            "user-a",
            "first prompt",
            "context:session-a:user-a",
        ),
        (
            "session-b",
            "user-b",
            "second prompt",
            "context:session-b:user-b",
        ),
    }


def test_capability_api_is_exported_from_package_root() -> None:
    """Break caught: documented capability imports disappearing."""
    import tdai_pydantic_ai

    assert tdai_pydantic_ai.TencentDBMemoryCapability.__name__ == (
        "TencentDBMemoryCapability"
    )
    assert tdai_pydantic_ai.Resolver is not None
