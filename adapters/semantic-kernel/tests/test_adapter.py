"""Smoke tests for the Semantic Kernel adapter against a fake gateway.

Covers: gateway client payloads/auth, plugin registration and tool invocation,
recall filter injection modes (append/template), incremental thread capture,
and session flush. No stack or LLM required.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from tdai_sk import MEMORY_PLACEHOLDER, TDAiConfig, TencentDBAgentMemory
from tdai_sk.gateway_client import CaptureRequest, MemoryGatewayClient


# ---------------------------------------------------------------------------
# Fake gateway
# ---------------------------------------------------------------------------

class FakeGateway:
    def __init__(self) -> None:
        from aiohttp import web  # SK depends on aiohttp

        self.requests: list[tuple[str, str, dict[str, Any] | None]] = []
        self.recall_context = "User's project codename is Apollo Lake."
        self.app = web.Application()
        self.app.router.add_get("/health", self._health)
        self.app.router.add_post("/capture", self._capture)
        self.app.router.add_post("/recall", self._recall)
        self.app.router.add_post("/search/memories", self._search_memories)
        self.app.router.add_post("/search/conversations", self._search_conversations)
        self.app.router.add_post("/session/end", self._session_end)
        self.runner: Any = None

    async def start(self):
        from aiohttp import web

        self.runner = web.AppRunner(self.app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        port = self.runner.addresses[0][1]
        return f"http://127.0.0.1:{port}"

    async def stop(self):
        if self.runner:
            await self.runner.cleanup()

    def _record(self, request, body: dict[str, Any] | None = None):
        self.requests.append((request.path, request.headers.get("Authorization", ""), body))

    async def _health(self, request):
        self._record(request)
        from aiohttp import web

        return web.json_response({"status": "ok", "version": "test-gateway"})

    async def _capture(self, request):
        body = await request.json()
        self._record(request, body)
        from aiohttp import web

        return web.json_response({"l0_recorded": len(body.get("messages", [])), "scheduler_notified": True})

    async def _recall(self, request):
        body = await request.json()
        self._record(request, body)
        from aiohttp import web

        return web.json_response(
            {"context": self.recall_context, "strategy": "semantic", "memory_count": 1}
        )

    async def _search_memories(self, request):
        body = await request.json()
        self._record(request, body)
        from aiohttp import web

        return web.json_response({"results": "[mem] codename=Apollo Lake", "total": 1, "strategy": "semantic"})

    async def _search_conversations(self, request):
        body = await request.json()
        self._record(request, body)
        from aiohttp import web

        return web.json_response({"results": "[conv] user asked about codename", "total": 1})

    async def _session_end(self, request):
        body = await request.json()
        self._record(request, body)
        from aiohttp import web

        return web.json_response({"flushed": True})


@pytest.fixture
async def fake_gw():
    gw = FakeGateway()
    url = await gw.start()
    yield gw, url
    await gw.stop()


def paths(gw: FakeGateway) -> list[str]:
    return [p for p, _, _ in gw.requests]


# ---------------------------------------------------------------------------
# Gateway client
# ---------------------------------------------------------------------------

async def test_client_health_and_auth(fake_gw):
    gw, url = fake_gw
    async with MemoryGatewayClient(gateway_url=url, api_key="k1") as client:
        health = await client.health()
        assert health.status == "ok"
        assert health.version == "test-gateway"
        await client.recall("q", "sk", user_id="u")
    # auth header present on write path
    writes = [auth for p, auth, _ in gw.requests if p != "/health"]
    assert all(a == "Bearer k1" for a in writes)


async def test_client_search_payloads(fake_gw):
    gw, url = fake_gw
    async with MemoryGatewayClient(gateway_url=url) as client:
        result = await client.search_memories("codename", limit=3, user_id="u")
        assert "Apollo Lake" in result.results
        await client.search_conversations("codename", session_key="s:k", limit=2)
    mem_payload = next(b for p, _, b in gw.requests if p == "/search/memories")
    assert mem_payload["query"] == "codename" and mem_payload["limit"] == 3
    conv_payload = next(b for p, _, b in gw.requests if p == "/search/conversations")
    assert conv_payload["session_key"] == "s:k"


# ---------------------------------------------------------------------------
# Facade: plugin + capture + end_session
# ---------------------------------------------------------------------------

async def test_plugin_registration_and_tool_call(fake_gw):
    from semantic_kernel.functions import KernelArguments
    from semantic_kernel.kernel import Kernel

    gw, url = fake_gw
    mem = TencentDBAgentMemory(TDAiConfig(gateway_url=url))
    plugin = mem.as_plugin()
    assert plugin.name == "TencentDBMemory"
    fn_names = sorted(f.metadata.name for f in plugin.functions.values())
    assert fn_names == ["conversation_search", "memory_search"]

    # invoke the memory_search kernel function through a real kernel
    kernel = Kernel()
    kernel.add_plugin(plugin)
    memory_search = plugin.functions["memory_search"]
    result = await memory_search.invoke(
        kernel=kernel,
        arguments=KernelArguments(query="project codename", limit=3),
    )
    assert "Apollo Lake" in str(result)
    await mem.close()


def _make_thread():
    from semantic_kernel.agents.chat_completion.chat_completion_agent import (
        ChatHistoryAgentThread,
    )
    from semantic_kernel.contents.chat_history import ChatHistory
    from semantic_kernel.contents.chat_message_content import ChatMessageContent
    from semantic_kernel.contents.utils.author_role import AuthorRole

    history = ChatHistory()
    history.add_message(ChatMessageContent(role=AuthorRole.USER, content="Remember: codename is Apollo Lake."))
    history.add_message(ChatMessageContent(role=AuthorRole.ASSISTANT, content="Noted."))
    return ChatHistoryAgentThread(chat_history=history, thread_id="t-1")


async def test_capture_thread_incremental_and_end_session(fake_gw):
    gw, url = fake_gw
    mem = TencentDBAgentMemory(TDAiConfig(gateway_url=url, api_key="k1"))
    thread = _make_thread()

    first = await mem.capture_thread(thread)
    assert first is not None and first["l0_recorded"] == 2
    capture = next(b for p, _, b in gw.requests if p == "/capture")
    assert capture["user_content"] == "Remember: codename is Apollo Lake."
    assert capture["assistant_content"] == "Noted."
    assert capture["session_id"] == "t-1"
    assert len(capture["messages"]) == 2

    # second capture: no delta → no request
    count_before = len(gw.requests)
    assert await mem.capture_thread(thread) is None
    assert len(gw.requests) == count_before

    assert await mem.end_session(thread) is True
    end_payload = next(b for p, _, b in gw.requests if p == "/session/end")
    assert end_payload["session_key"].endswith("dC0x")  # b64url("t-1")
    await mem.close()


# ---------------------------------------------------------------------------
# Recall filter modes
# ---------------------------------------------------------------------------

async def test_recall_filter_append_mode(fake_gw):
    from semantic_kernel.functions import KernelArguments
    from semantic_kernel.kernel import Kernel

    gw, url = fake_gw
    mem = TencentDBAgentMemory(TDAiConfig(gateway_url=url, recall_mode="append"))
    kernel = Kernel()
    mem.attach(kernel)
    assert len(kernel.prompt_rendering_filters) == 1

    # simulate what ChatCompletionAgent does: render instructions through the
    # kernel's prompt-rendering filter stack
    arguments = KernelArguments(input="What is my project codename?")
    rendered = await _run_render_filters(kernel, arguments)
    assert "Apollo Lake" in rendered


async def test_recall_filter_template_mode(fake_gw):
    from semantic_kernel.functions import KernelArguments
    from semantic_kernel.kernel import Kernel

    gw, url = fake_gw
    mem = TencentDBAgentMemory(TDAiConfig(gateway_url=url, recall_mode="template"))
    kernel = Kernel()
    mem.attach(kernel)

    arguments = KernelArguments(input="What is my project codename?")
    await _run_render_filters(kernel, arguments)
    assert "Apollo Lake" in arguments[MEMORY_PLACEHOLDER]
    # template mode never touches instructions
    assert "instructions" not in arguments
    await mem.close()


async def _run_render_filters(kernel, arguments):
    """Drive the kernel's prompt_rendering_filters as the agent would."""
    # Resolve pydantic forward references the same way SK internals do
    # (see semantic_kernel.filters.kernel_filters_extension._rebuild_prompt_render_context).
    from semantic_kernel.filters import FilterTypes  # noqa: F401
    from semantic_kernel.filters.prompts.prompt_render_context import PromptRenderContext
    from semantic_kernel.functions import KernelFunction  # noqa: F401
    from semantic_kernel.functions.function_result import FunctionResult  # noqa: F401
    from semantic_kernel.functions.kernel_arguments import KernelArguments  # noqa: F401
    from semantic_kernel.kernel import Kernel  # noqa: F401

    PromptRenderContext.model_rebuild()

    inner_executed = {}

    async def inner(ctx):
        inner_executed["done"] = True

    # PromptRenderContext requires a real function being rendered.
    function = kernel.add_function(
        plugin_name="test", function_name="dummy", prompt="render me"
    )
    stack = kernel.construct_call_stack(FilterTypes.PROMPT_RENDERING, inner)
    context = PromptRenderContext(kernel=kernel, function=function, arguments=arguments)
    await stack(context)
    assert inner_executed.get("done") is True
    return arguments.get("instructions") or ""
