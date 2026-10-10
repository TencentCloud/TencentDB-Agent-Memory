"""Interactive quickstart for the Semantic Kernel adapter of TencentDB Agent Memory.

Prerequisites:
  1. TencentDB Agent Memory stack running locally:
       cd deploy/global-images && cp .env.example .env && ./start-all.sh
     (set MEMORY_LLM_BASE_URL / MEMORY_LLM_API_KEY / MEMORY_LLM_MODEL in .env;
      the gateway listens on :8420)
  2. An OpenAI-compatible key for the agent's chat model (OPENAI_API_KEY).

Run:
       cd adapters/semantic-kernel
       export OPENAI_API_KEY="sk-..."
       python example/quickstart.py
"""

import asyncio
import os

from semantic_kernel.agents import ChatCompletionAgent, ChatHistoryAgentThread
from semantic_kernel.connectors.ai.open_ai import OpenAIChatCompletion
from semantic_kernel.functions import KernelArguments
from semantic_kernel.kernel import Kernel

from tdai_sk import TDAiConfig, TencentDBAgentMemory

MEMORY_PLACEHOLDER_DEMO = (
    "You are a helpful assistant with long-term memory.\n"
    "Relevant remembered context:\n{{TDaiMemory}}"
)


async def main() -> None:
    gateway_url = os.environ.get("TENCENTDB_AGENT_MEMORY_GATEWAY", "http://127.0.0.1:8420")
    api_key = os.environ.get("TDAI_GATEWAY_API_KEY", "")
    model_id = os.environ.get("OPENAI_MODEL_ID", "gpt-4o-mini")

    mem = TencentDBAgentMemory(
        TDAiConfig(
            app_name="sk-quickstart",
            user_id="demo-user",
            gateway_url=gateway_url,
            api_key=api_key,
            recall_mode="append",  # or "template" with {{TDaiMemory}} in instructions
        )
    )

    health = await mem.health()
    print(f"Gateway: {gateway_url} (status={health.status} version={health.version})")

    kernel = Kernel()
    kernel.add_service(OpenAIChatCompletion(ai_model_id=model_id))
    mem.attach(kernel)  # registers the PROMPT_RENDERING recall filter

    agent = ChatCompletionAgent(
        kernel=kernel,
        name="memory-assistant",
        instructions="You are a concise assistant backed by TencentDB Agent Memory.",
        plugins=[mem.as_plugin()],
    )

    thread: ChatHistoryAgentThread | None = None

    async def turn(text: str) -> str:
        nonlocal thread
        response = await agent.get_response(messages=text, thread=thread)
        thread = response.thread
        await mem.capture_thread(thread)  # incremental capture to /capture
        return str(response.message.content)

    # --- teach, then recall across a new thread -------------------------
    print("You: Remember that my project codename is Apollo Lake.")
    print("Assistant:", await turn("Remember that my project codename is Apollo Lake."))

    print("\n(new thread — long-term memory should still apply)")
    thread2: ChatHistoryAgentThread | None = None
    response = await agent.get_response(
        messages="What is my project codename?",
        thread=thread2,
        arguments=KernelArguments(),
    )
    print("You: What is my project codename?")
    print("Assistant:", response.message.content)

    if thread is not None:
        await mem.end_session(thread)
    await mem.close()


if __name__ == "__main__":
    asyncio.run(main())
