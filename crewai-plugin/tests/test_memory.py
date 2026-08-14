from __future__ import annotations

from typing import Any
import unittest

from crewai import Agent, Crew, Task

from memory_tencentdb_crewai import TencentDBMemory


class FakeGateway:
    def __init__(self) -> None:
        self.captures: list[dict[str, Any]] = []
        self.ended: list[str] = []
        self.fail_capture = False

    def recall(self, query: str, session_key: str, **_: Any) -> dict[str, Any]:
        return {"context": f"persona for {query}", "strategy": "hybrid", "memory_count": 2}

    def search_memories(self, query: str, **_: Any) -> dict[str, Any]:
        return {"results": f"records for {query}", "total": 3, "strategy": "fts"}

    def capture(
        self,
        user_content: str,
        assistant_content: str,
        session_key: str,
        **kwargs: Any,
    ) -> dict[str, Any]:
        if self.fail_capture:
            raise RuntimeError("gateway offline")
        self.captures.append(
            {
                "user_content": user_content,
                "assistant_content": assistant_content,
                "session_key": session_key,
                **kwargs,
            }
        )
        return {"l0_recorded": 2, "scheduler_notified": True}

    def end_session(self, session_key: str, **_: Any) -> dict[str, Any]:
        self.ended.append(session_key)
        return {"flushed": True}


class TencentDBMemoryTests(unittest.TestCase):
    def make_memory(self, **kwargs: Any) -> tuple[TencentDBMemory, FakeGateway]:
        memory = TencentDBMemory(session_key="crewai:test", **kwargs)
        gateway = FakeGateway()
        memory._client = gateway  # type: ignore[assignment]
        return memory, gateway

    def test_is_accepted_by_crewai_memory_field(self) -> None:
        memory, _ = self.make_memory()
        agent = Agent(
            role="Tester",
            goal="Validate a memory adapter",
            backstory="A deterministic compatibility-test agent",
            llm="openai/gpt-4o-mini",
        )
        task = Task(description="Validate memory", expected_output="ok", agent=agent)
        crew = Crew(agents=[agent], tasks=[task], memory=memory)
        self.assertIs(crew._memory, memory)
        memory.close()

    def test_rejects_whitespace_only_session_key(self) -> None:
        with self.assertRaisesRegex(ValueError, "non-whitespace"):
            TencentDBMemory(session_key="   ")

    def test_recall_returns_native_memory_matches(self) -> None:
        memory, _ = self.make_memory()
        matches = memory.recall("preferred output", limit=5)

        self.assertEqual(
            [match.record.metadata["kind"] for match in matches],
            ["recall", "memory_search"],
        )
        self.assertEqual(matches[0].record.content, "persona for preferred output")
        self.assertEqual(matches[1].record.metadata["total"], 3)
        memory.close()

    def test_remember_many_batches_one_gateway_capture(self) -> None:
        memory, gateway = self.make_memory()
        self.assertEqual(
            memory.remember_many(["prefers TypeScript", "uses SQLite"], agent_role="researcher"),
            [],
        )
        memory.drain_writes()

        self.assertEqual(len(gateway.captures), 1)
        self.assertIn("researcher", gateway.captures[0]["user_content"])
        self.assertIn("1. prefers TypeScript", gateway.captures[0]["assistant_content"])
        self.assertIn("2. uses SQLite", gateway.captures[0]["assistant_content"])
        memory.close()

    def test_default_mode_fails_open(self) -> None:
        memory, gateway = self.make_memory()
        gateway.fail_capture = True
        self.assertIsNone(memory.remember("important fact"))
        memory.close()

    def test_strict_mode_surfaces_background_capture_failure(self) -> None:
        memory, gateway = self.make_memory(strict=True)
        gateway.fail_capture = True
        memory.remember_many(["important fact"])
        with self.assertRaisesRegex(RuntimeError, "gateway offline"):
            memory.drain_writes()
        gateway.fail_capture = False
        memory.close()


if __name__ == "__main__":
    unittest.main()
