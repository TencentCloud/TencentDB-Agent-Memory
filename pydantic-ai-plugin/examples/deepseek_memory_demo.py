from __future__ import annotations

import asyncio
import os

from pydantic_ai import Agent

from memory_tencentdb_pydantic_ai import (
    GatewayClient,
    TencentDBMemoryAgent,
)


async def main() -> None:
    if not os.environ.get("DEEPSEEK_API_KEY"):
        raise RuntimeError(
            "Set DEEPSEEK_API_KEY in your local environment"
        )

    agent = Agent(
        os.environ.get(
            "PYDANTIC_AI_MODEL",
            "deepseek:deepseek-chat",
        ),
        instructions=(
            "Answer concisely and use recalled memory when relevant."
        ),
    )
    memory_agent = TencentDBMemoryAgent(
        agent,
        GatewayClient(
            os.environ.get(
                "TDAI_GATEWAY_URL",
                "http://127.0.0.1:8420",
            ),
            api_key=os.environ.get("TDAI_GATEWAY_API_KEY"),
        ),
    )

    user_id = "pydantic-ai-deepseek-demo"
    session_id = "two-turn-memory-demo"
    first = await memory_agent.run(
        "For this demo, remember that I prefer sugar-free coffee.",
        user_id=user_id,
        session_id=session_id,
    )
    print(f"Turn 1: {first.output}")

    second = await memory_agent.run(
        "What coffee preference did I mention?",
        user_id=user_id,
        session_id=session_id,
        message_history=first.all_messages(),
    )
    print(f"Turn 2: {second.output}")

    flushed = await memory_agent.end_session(
        user_id=user_id,
        session_id=session_id,
    )
    print(f"Session flushed: {flushed}")


if __name__ == "__main__":
    asyncio.run(main())
