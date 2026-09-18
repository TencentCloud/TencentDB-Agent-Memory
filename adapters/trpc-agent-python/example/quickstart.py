"""Quickstart: TencentDBMemoryService plugged into a trpc-agent-python Runner.

Prerequisites:
  1. TencentDB Agent Memory stack running locally:
       cd deploy/global-images && cp .env.example .env && ./start-all.sh
     (set MEMORY_LLM_BASE_URL / MEMORY_LLM_API_KEY / MEMORY_LLM_MODEL in .env;
      the gateway listens on :8420)
  2. An OpenAI-compatible key for the agent's chat model (OPENAI_API_KEY).

Run:
       cd adapters/trpc-agent-python
       export OPENAI_API_KEY="sk-..."
       python example/quickstart.py
"""

import asyncio
import os

from trpc_agent_sdk.agents import LlmAgent
from trpc_agent_sdk.models import OpenAIModel
from trpc_agent_sdk.runners import Runner
from trpc_agent_sdk.sessions import InMemorySessionService
from trpc_agent_sdk.types import Content, Part

from tdai_trpc import TDAiConfig, TencentDBMemoryService


def user_message(text: str) -> Content:
    return Content(role="user", parts=[Part.from_text(text=text)])


def event_text(event) -> str:
    if not event.content or not event.content.parts:
        return ""
    return "".join(part.text or "" for part in event.content.parts).strip()


async def main() -> None:
    gateway_url = os.environ.get("TENCENTDB_AGENT_MEMORY_GATEWAY", "http://127.0.0.1:8420")
    api_key = os.environ.get("TDAI_GATEWAY_API_KEY", "")
    model_name = os.environ.get("OPENAI_MODEL_ID", "gpt-4o-mini")

    memory = TencentDBMemoryService(
        TDAiConfig(
            gateway_url=gateway_url,
            api_key=api_key,
            fail_open=True,  # gateway outage never breaks the chat loop
        )
    )
    health = await memory.health()
    print(f"Gateway: {gateway_url} (status={health.status} version={health.version})")

    agent = LlmAgent(
        name="memory-assistant",
        model=OpenAIModel(model_name),
        instruction="You are a concise assistant backed by TencentDB Agent Memory.",
    )

    runner = Runner(
        app_name="tdai-quickstart",
        agent=agent,
        session_service=InMemorySessionService(),
        # After each completed turn the runner calls memory.store_session,
        # which streams the turn's user/assistant pair to POST /capture.
        memory_service=memory,
    )

    user_id = "demo-user"

    async def turn(session_id: str, text: str) -> None:
        async for event in runner.run_async(
            user_id=user_id,
            session_id=session_id,
            new_message=user_message(text),
        ):
            reply = event_text(event)
            if reply:
                print("Assistant:", reply)

    # 1) Teach a fact in one session (captured to the gateway after the turn).
    await turn("demo-session-1", "Remember: my project codename is Apollo Lake.")
    # 2) Ask in a brand-new session; recall flows through the framework's
    #    memory search path (invocation context -> memory_service.search_memory).
    await turn("demo-session-2", "What is my project codename?")

    await memory.close()


if __name__ == "__main__":
    asyncio.run(main())
