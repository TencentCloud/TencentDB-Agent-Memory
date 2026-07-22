from __future__ import annotations

import asyncio
from typing import Any
import unittest

from llama_index.core.base.llms.types import ChatMessage
from llama_index.core.memory import Memory

from memory_tencentdb_llamaindex import TencentDBMemoryBlock


class FakeGateway:
    def __init__(self) -> None:
        self.recalls: list[tuple[str, str]] = []
        self.captures: list[dict[str, Any]] = []
        self.ended: list[str] = []
        self.fail = False

    def recall(self, query: str, session_key: str, **_: Any) -> dict[str, Any]:
        if self.fail:
            raise RuntimeError("gateway offline")
        self.recalls.append((query, session_key))
        return {"context": f"persona for {query}"}

    def search_memories(self, query: str, **_: Any) -> dict[str, Any]:
        return {"results": f"records for {query}"}

    def capture(
        self,
        user_content: str,
        assistant_content: str,
        session_key: str,
        **kwargs: Any,
    ) -> dict[str, Any]:
        if self.fail:
            raise RuntimeError("gateway offline")
        self.captures.append(
            {
                "user_content": user_content,
                "assistant_content": assistant_content,
                "session_key": session_key,
                **kwargs,
            }
        )
        return {"scheduler_notified": True}

    def end_session(self, session_key: str, **_: Any) -> dict[str, Any]:
        self.ended.append(session_key)
        return {"flushed": True}


class TencentDBMemoryBlockTests(unittest.TestCase):
    def make_block(self, **kwargs: Any) -> tuple[TencentDBMemoryBlock, FakeGateway]:
        block = TencentDBMemoryBlock(**kwargs)
        gateway = FakeGateway()
        block._client = gateway  # type: ignore[assignment]
        return block, gateway

    def test_is_accepted_by_native_memory_blocks_field(self) -> None:
        block, _ = self.make_block()
        memory = Memory(
            token_limit=100,
            token_flush_size=10,
            tokenizer_fn=lambda text: text.split(),
            memory_blocks=[block],
        )
        self.assertIs(memory.memory_blocks[0], block)

    def test_recall_uses_latest_user_message_and_session_id(self) -> None:
        block, gateway = self.make_block()
        result = asyncio.run(
            block.aget(
                [
                    ChatMessage(role="assistant", content="earlier"),
                    ChatMessage(role="user", content="preferred output"),
                ],
                session_id="run-7",
            )
        )

        self.assertEqual(
            result,
            "persona for preferred output\n\nrecords for preferred output",
        )
        self.assertEqual(gateway.recalls, [("preferred output", "llamaindex:run-7")])

    def test_put_maps_native_messages_to_one_capture(self) -> None:
        block, gateway = self.make_block(user_id="alice")
        asyncio.run(
            block.aput(
                [
                    ChatMessage(role="user", content="Use SQLite"),
                    ChatMessage(role="assistant", content="Preference saved"),
                ],
                session_id="run-9",
            )
        )

        self.assertEqual(len(gateway.captures), 1)
        self.assertEqual(gateway.captures[0]["session_key"], "llamaindex:run-9")
        self.assertEqual(gateway.captures[0]["session_id"], "run-9")
        self.assertEqual(gateway.captures[0]["user_id"], "alice")
        self.assertIn("user: Use SQLite", gateway.captures[0]["user_content"])

    def test_default_mode_fails_open(self) -> None:
        block, gateway = self.make_block()
        gateway.fail = True
        result = asyncio.run(
            block.aget([ChatMessage(role="user", content="query")])
        )
        self.assertEqual(result, "")

    def test_strict_mode_surfaces_gateway_failure(self) -> None:
        block, gateway = self.make_block(strict=True)
        gateway.fail = True
        with self.assertRaisesRegex(RuntimeError, "gateway offline"):
            asyncio.run(block.aget([ChatMessage(role="user", content="query")]))

    def test_close_flushes_effective_session(self) -> None:
        block, gateway = self.make_block()
        asyncio.run(block.aclose("run-11"))
        self.assertEqual(gateway.ended, ["llamaindex:run-11"])


if __name__ == "__main__":
    unittest.main()
